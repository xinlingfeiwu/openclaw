import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// Ported from hermes tools/terminal_tool.py, tools/budget_config.py, and
// tools/tool_result_storage.py. Smart 40/60 head/tail split preserves early
// error messages (head) while keeping recent/relevant output (tail).
// 3-layer budget (hermes pattern):
//   Layer 2: per-result cap (DEFAULT_MAX_CHARS)
//   Layer 3: per-turn aggregate across all tools (DEFAULT_TURN_BUDGET)
const DEFAULT_MAX_CHARS = 50_000; // ~12K tokens — matches hermes MAX_OUTPUT_CHARS
const DEFAULT_HEAD_RATIO = 0.4; // 40% head → 20KB for error messages
const DEFAULT_TURN_BUDGET = 200_000; // Total chars per LLM turn across all tool results
// Minimum output chars before truncation kicks in (small outputs are never truncated)
const MIN_TRUNCATION_THRESHOLD = 2_000;

// Per-agent in-memory turn budget usage (reset on each before_model_resolve)
const turnBudgetUsed = new Map<string, number>();

type ToolOutputTruncationConfig = {
  enabled?: boolean;
  /** Max characters before truncation per result (default: 50000) */
  maxChars?: number;
  /** Fraction allocated to head — must be in (0,1) (default: 0.4) */
  headRatio?: number;
  /** Per-turn aggregate budget across all tool results (default: 200000) */
  turnBudget?: number;
  /** Tools to skip truncation for (e.g., ["read_file"]) */
  skipTools?: string[];
};

function truncateOutput(text: string, maxChars: number, headRatio: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  // Detect JSON content to warn agent not to parse truncated output as JSON.
  const looksLikeJson = /^\s*[{[]/.test(text);

  const headChars = Math.floor(maxChars * headRatio);
  const tailChars = maxChars - headChars;
  const omitted = text.length - headChars - tailChars;
  // Short preview of omitted section for agent context
  const preview = text
    .slice(headChars, headChars + 100)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  const warningAttr = looksLikeJson ? ` warning="json_truncated_output_is_incomplete"` : "";
  return (
    text.slice(0, headChars) +
    `\n\n<omitted chars="${omitted.toLocaleString()}" preview="${preview}..."${warningAttr} />\n\n` +
    text.slice(text.length - tailChars)
  );
}

function extractTextFromMessage(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const msg = message as Record<string, unknown>;

  // Tool result messages have content as array of blocks or plain string
  if (typeof msg.content === "string") {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    const parts: string[] = [];
    for (const block of msg.content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") {
          parts.push(b.text);
        } else if (typeof b.content === "string") {
          parts.push(b.content);
        }
      } else if (typeof block === "string") {
        parts.push(block);
      }
    }
    return parts.join("\n") || null;
  }
  return null;
}

function replaceTextInMessage(message: unknown, newText: string): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const msg = message as Record<string, unknown>;

  if (typeof msg.content === "string") {
    return { ...msg, content: newText };
  }
  if (Array.isArray(msg.content)) {
    // Rebuild content array: replace all text blocks with single truncated block
    const textBlock = { type: "text", text: newText };
    const nonTextBlocks = (msg.content as unknown[]).filter((b) => {
      if (!b || typeof b !== "object") {
        return false;
      }
      const block = b as Record<string, unknown>;
      return block.type !== "text" && typeof block.text !== "string";
    });
    return { ...msg, content: [textBlock, ...nonTextBlocks] };
  }
  return message;
}

export default definePluginEntry({
  id: "tool-output-truncation",
  name: "Tool Output Truncation",
  description:
    "Automatically truncates oversized tool outputs using a smart 40/60 head/tail split. Implements 2-layer budget (hermes pattern): per-result cap + per-turn aggregate 200K limit across all tool results. Prevents context window overflow from verbose terminal or file output.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as ToolOutputTruncationConfig;
    if (cfg.enabled === false) {
      return;
    }

    const maxChars =
      typeof cfg.maxChars === "number" && cfg.maxChars > MIN_TRUNCATION_THRESHOLD
        ? cfg.maxChars
        : DEFAULT_MAX_CHARS;

    const headRatio =
      typeof cfg.headRatio === "number" && cfg.headRatio > 0 && cfg.headRatio < 1
        ? cfg.headRatio
        : DEFAULT_HEAD_RATIO;

    const turnBudget =
      typeof cfg.turnBudget === "number" && cfg.turnBudget > maxChars
        ? cfg.turnBudget
        : DEFAULT_TURN_BUDGET;

    const skipTools = new Set<string>(Array.isArray(cfg.skipTools) ? cfg.skipTools : []);

    // Reset per-turn budget at the start of each LLM call (new turn boundary)
    api.on("before_model_resolve", (_event, ctx) => {
      const key = ctx.agentId ?? ctx.sessionId ?? "default";
      turnBudgetUsed.set(key, 0);
      return undefined;
    });

    api.on("tool_result_persist", (event, ctx) => {
      const agentKey = ctx.agentId ?? ctx.sessionKey ?? "default";
      const toolName = (event as { toolName?: string }).toolName ?? ctx.toolName ?? "";

      if (skipTools.has(toolName)) {
        return undefined;
      }
      if (!event.message) {
        return undefined;
      }

      const text = extractTextFromMessage(event.message);
      if (!text || text.length <= MIN_TRUNCATION_THRESHOLD) {
        return undefined;
      }

      // Layer 3: check per-turn aggregate budget
      const used = turnBudgetUsed.get(agentKey) ?? 0;
      const remaining = turnBudget - used;

      if (remaining <= MIN_TRUNCATION_THRESHOLD) {
        // Aggregate budget exhausted: hard-limit to minimum
        const truncated = truncateOutput(text, MIN_TRUNCATION_THRESHOLD, headRatio);
        const newMessage = replaceTextInMessage(event.message, truncated) as typeof event.message;
        turnBudgetUsed.set(agentKey, used + MIN_TRUNCATION_THRESHOLD);
        return { message: newMessage };
      }

      // Layer 2: effective cap = min(perResultMax, remainingTurnBudget)
      const effectiveMax = Math.min(maxChars, remaining);

      if (text.length <= effectiveMax) {
        // No truncation needed — still track budget usage
        turnBudgetUsed.set(agentKey, used + text.length);
        return undefined;
      }

      const truncated = truncateOutput(text, effectiveMax, headRatio);
      const newMessage2 = replaceTextInMessage(event.message, truncated);
      turnBudgetUsed.set(agentKey, used + effectiveMax);
      return { message: newMessage2 as AgentMessage };
    });

    // Clean up per-turn budget entry when session ends to prevent unbounded map growth.
    api.on("agent_end", (_event, ctx) => {
      const key = ctx.agentId ?? ctx.sessionId ?? "default";
      turnBudgetUsed.delete(key);
    });
  },
});
