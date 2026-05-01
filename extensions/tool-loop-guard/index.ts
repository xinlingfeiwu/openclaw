import { createHash } from "node:crypto";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// Idempotent tools: repeated calls with same args are safe — no side effects.
const IDEMPOTENT_TOOLS = new Set([
  "read_file",
  "list_files",
  "glob",
  "grep",
  "search",
  "web_search",
  "fetch",
  "view",
  "cat",
  "ls",
  "find",
  "head",
  "tail",
  "stat",
  "exists",
]);

type LoopGuardConfig = {
  enabled?: boolean;
  warningsEnabled?: boolean;
  hardStopEnabled?: boolean;
  exactFailureWarnAfter?: number;
  exactFailureBlockAfter?: number;
  sameToolFailureWarnAfter?: number;
  sameToolFailureHaltAfter?: number;
  noProgressWarnAfter?: number;
  noProgressBlockAfter?: number;
};

type SessionLoopState = {
  /** key = sha1(toolName + ":" + JSON.stringify(params)), value = consecutive failure count */
  exactFailures: Map<string, number>;
  /** key = toolName, value = consecutive failure count */
  sameToolFailures: Map<string, number>;
  /** consecutive tool calls with no apparent progress (all failures, no success) */
  noProgressStreak: number;
  /** warnings pending injection on next before_prompt_build */
  pendingWarnings: string[];
  /** whether a warning was already injected (to avoid flooding) */
  warnedThisTurn: Set<string>;
};

function makeSessionKey(ctx: unknown): string {
  return (
    (ctx as { sessionId?: string }).sessionId ?? (ctx as { agentId?: string }).agentId ?? "default"
  );
}

function hashCall(toolName: string, params: Record<string, unknown>): string {
  const canonical = JSON.stringify([toolName, params]);
  return createHash("sha1").update(canonical).digest("hex").slice(0, 12);
}

function isIdempotent(toolName: string): boolean {
  return IDEMPOTENT_TOOLS.has(toolName.toLowerCase());
}

const perSessionState = new Map<string, SessionLoopState>();

function getOrCreateState(key: string): SessionLoopState {
  let state = perSessionState.get(key);
  if (!state) {
    state = {
      exactFailures: new Map(),
      sameToolFailures: new Map(),
      noProgressStreak: 0,
      pendingWarnings: [],
      warnedThisTurn: new Set(),
    };
    perSessionState.set(key, state);
  }
  return state;
}

export default definePluginEntry({
  id: "tool-loop-guard",
  name: "Tool Loop Guard",
  description:
    "Detects agent tool-call loops (repeated failures, same-tool no-progress, general no-progress). Warning-first by default; hard-stop opt-in. Ported from hermes-agent/agent/tool_guardrails.py.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as LoopGuardConfig;
    if (cfg.enabled === false) {
      return;
    }

    const warningsEnabled = cfg.warningsEnabled !== false;
    const hardStopEnabled = cfg.hardStopEnabled === true;

    const exactWarn = typeof cfg.exactFailureWarnAfter === "number" ? cfg.exactFailureWarnAfter : 2;
    const exactBlock =
      typeof cfg.exactFailureBlockAfter === "number" ? cfg.exactFailureBlockAfter : 5;
    const sameWarn =
      typeof cfg.sameToolFailureWarnAfter === "number" ? cfg.sameToolFailureWarnAfter : 3;
    const sameHalt =
      typeof cfg.sameToolFailureHaltAfter === "number" ? cfg.sameToolFailureHaltAfter : 8;
    const noProgWarn = typeof cfg.noProgressWarnAfter === "number" ? cfg.noProgressWarnAfter : 2;
    const noProgBlock = typeof cfg.noProgressBlockAfter === "number" ? cfg.noProgressBlockAfter : 5;

    // Track tool results and update per-session state after each call.
    api.on("after_tool_call", (event, ctx) => {
      const ev = event as { toolName?: string; params?: Record<string, unknown>; error?: string };
      const toolName = ev.toolName ?? "unknown";
      const params = ev.params ?? {};
      const hasError = Boolean(ev.error);
      const key = makeSessionKey(ctx);
      const state = getOrCreateState(key);

      const callHash = hashCall(toolName, params);
      const warnKey = (label: string) => `${label}:${toolName}`;

      if (hasError) {
        // Track exact call failures
        const prev = state.exactFailures.get(callHash) ?? 0;
        state.exactFailures.set(callHash, prev + 1);

        // Track same-tool failures
        const prevTool = state.sameToolFailures.get(toolName) ?? 0;
        state.sameToolFailures.set(toolName, prevTool + 1);

        // Track overall no-progress streak
        state.noProgressStreak += 1;

        if (warningsEnabled) {
          const exact = state.exactFailures.get(callHash) ?? 0;
          const sameTool = state.sameToolFailures.get(toolName) ?? 0;
          const noProgress = state.noProgressStreak;

          if (exact >= exactWarn && !state.warnedThisTurn.has(warnKey("exact"))) {
            state.warnedThisTurn.add(warnKey("exact"));
            state.pendingWarnings.push(
              `[Tool Loop Guard] WARNING: tool "${toolName}" has failed ${exact} times with identical parameters. ` +
                `Try a different approach, modify the parameters, or skip this tool.`,
            );
          }
          if (sameTool >= sameWarn && !state.warnedThisTurn.has(warnKey("same"))) {
            state.warnedThisTurn.add(warnKey("same"));
            state.pendingWarnings.push(
              `[Tool Loop Guard] WARNING: tool "${toolName}" has failed ${sameTool} consecutive times. ` +
                `Consider using a different tool or approach.`,
            );
          }
          if (noProgress >= noProgWarn && !state.warnedThisTurn.has("noprogress")) {
            state.warnedThisTurn.add("noprogress");
            state.pendingWarnings.push(
              `[Tool Loop Guard] WARNING: ${noProgress} consecutive tool calls have failed with no progress. ` +
                `Step back and reconsider your approach before continuing.`,
            );
          }
        }
      } else {
        // On success, reset same-tool and no-progress streak.
        // Keep exact failures map clean — success clears this call's failure count.
        state.exactFailures.delete(callHash);
        state.sameToolFailures.delete(toolName);
        state.noProgressStreak = 0;
      }
    });

    // Hard-stop check before tool call (only when hardStopEnabled).
    api.on("before_tool_call", (event, ctx) => {
      if (!hardStopEnabled) {
        return undefined;
      }
      const ev = event as { toolName?: string; params?: Record<string, unknown> };
      const toolName = ev.toolName ?? "unknown";
      const params = ev.params ?? {};

      // Never hard-stop idempotent tools — they are safe to retry.
      if (isIdempotent(toolName)) {
        return undefined;
      }

      const key = makeSessionKey(ctx);
      const state = perSessionState.get(key);
      if (!state) {
        return undefined;
      }

      const callHash = hashCall(toolName, params);
      const exact = state.exactFailures.get(callHash) ?? 0;
      const sameTool = state.sameToolFailures.get(toolName) ?? 0;
      const noProgress = state.noProgressStreak;

      if (exact >= exactBlock) {
        return {
          block: true,
          blockReason: `[Tool Loop Guard] Hard-stop: tool "${toolName}" has failed ${exact} times with identical parameters. Please reconsider your approach.`,
        };
      }
      if (sameTool >= sameHalt) {
        return {
          block: true,
          blockReason: `[Tool Loop Guard] Hard-stop: tool "${toolName}" has failed ${sameTool} consecutive times. Please use a different approach.`,
        };
      }
      if (noProgress >= noProgBlock) {
        return {
          block: true,
          blockReason: `[Tool Loop Guard] Hard-stop: ${noProgress} consecutive tool calls have failed. Stopping to prevent infinite loop.`,
        };
      }

      return undefined;
    });

    // Inject pending warnings at the start of the next prompt build turn.
    api.on("before_prompt_build", (_event, ctx) => {
      const key = makeSessionKey(ctx);
      const state = perSessionState.get(key);
      if (!state || state.pendingWarnings.length === 0) {
        return undefined;
      }
      const text = "\n\n" + state.pendingWarnings.join("\n") + "\n";
      // Clear injected warnings so they only appear once.
      state.pendingWarnings = [];
      state.warnedThisTurn = new Set();
      return { appendContext: text };
    });

    // Clean up per-session state when agent ends.
    api.on("agent_end", (_event, ctx) => {
      const key = makeSessionKey(ctx);
      perSessionState.delete(key);
    });
  },
});
