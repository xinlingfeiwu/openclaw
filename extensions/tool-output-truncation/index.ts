import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// Ported from hermes tools/terminal_tool.py and tools/code_execution_tool.py.
// Smart 40/60 head/tail split preserves early error messages (head) while
// keeping recent/relevant output (tail). This mirrors shell conventions where
// errors appear first but final state is what matters most.
const DEFAULT_MAX_CHARS = 50_000; // ~12K tokens — matches hermes MAX_OUTPUT_CHARS
const DEFAULT_HEAD_RATIO = 0.4; // 40% head → 20KB for error messages
// Minimum output chars before truncation kicks in (small outputs are never truncated)
const MIN_TRUNCATION_THRESHOLD = 2_000;

type ToolOutputTruncationConfig = {
  enabled?: boolean;
  /** Max characters before truncation (default: 50000) */
  maxChars?: number;
  /** Fraction allocated to head — must be in (0,1) (default: 0.4) */
  headRatio?: number;
  /** Tools to skip truncation for (e.g., ["read_file"]) */
  skipTools?: string[];
};

function truncateOutput(text: string, maxChars: number, headRatio: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const headChars = Math.floor(maxChars * headRatio);
  const tailChars = maxChars - headChars;
  const omitted = text.length - headChars - tailChars;

  return (
    text.slice(0, headChars) +
    `\n\n[... ${omitted.toLocaleString()} characters omitted to fit context window ...]\n\n` +
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
    "Automatically truncates oversized tool outputs using a smart 40/60 head/tail split. Preserves early error messages (head) and most recent output (tail). Prevents context window overflow from verbose terminal or file output.",
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

    const skipTools = new Set<string>(Array.isArray(cfg.skipTools) ? cfg.skipTools : []);

    api.on("tool_result_persist", (event, ctx) => {
      const ev = event as { message?: unknown; toolName?: string };
      const toolName = ev.toolName ?? (ctx as { toolName?: string }).toolName ?? "";

      if (skipTools.has(toolName)) {
        return undefined;
      }
      if (!ev.message) {
        return undefined;
      }

      const text = extractTextFromMessage(ev.message);
      if (!text || text.length <= maxChars) {
        return undefined;
      }

      const truncated = truncateOutput(text, maxChars, headRatio);
      const newMessage = replaceTextInMessage(ev.message, truncated);

      return { message: newMessage };
    });
  },
});
