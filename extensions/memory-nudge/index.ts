import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

const DEFAULT_INTERVAL = 10;
const DEFAULT_MAX_PER_SESSION = 8;

// Exact hermes _MEMORY_REVIEW_PROMPT text — focused on durable user-persona and work-style facts
const DEFAULT_NUDGE_TEXT = `<memory_review>
Review the conversation above and consider saving to memory if appropriate. Focus on:
1. Has the user revealed things about themselves — their persona, desires, preferences, or personal details worth remembering?
2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate?
If something stands out, save it using the memory tool. If nothing is worth saving, just say "Nothing to save." and stop.
</memory_review>`;

type MemoryNudgeConfig = {
  enabled?: boolean;
  interval?: number;
  maxPerSession?: number;
  nudgeText?: string;
};

// Per-session tracking: sessionId → { userTurnCount, nudgeCount, lastNudgedAt, lastCountedUserMsgs }
// userTurnCount accumulates as a running total; lastCountedUserMsgs tracks the previous window size
// so we can compute deltas correctly even after context compaction truncates message history.
const sessionState = new Map<
  string,
  { userTurnCount: number; nudgeCount: number; lastNudgedAt: number; lastCountedUserMsgs: number }
>();

function getSessionState(sessionId: string) {
  let state = sessionState.get(sessionId);
  if (!state) {
    state = { userTurnCount: 0, nudgeCount: 0, lastNudgedAt: 0, lastCountedUserMsgs: 0 };
    sessionState.set(sessionId, state);
  }
  return state;
}

function countUserMessages(messages: unknown[]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg && typeof msg === "object") {
      const typed = msg as { role?: unknown };
      if (typed.role === "user") {
        count++;
      }
    }
  }
  return count;
}

export default definePluginEntry({
  id: "memory-nudge",
  name: "Memory Nudge",
  description:
    "Periodically reminds the agent to save useful information to memory every N conversation turns.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as MemoryNudgeConfig;

    if (cfg.enabled === false) {
      return;
    }

    const interval =
      typeof cfg.interval === "number" && cfg.interval > 0 ? cfg.interval : DEFAULT_INTERVAL;
    const maxPerSession =
      typeof cfg.maxPerSession === "number" && cfg.maxPerSession >= 0
        ? cfg.maxPerSession
        : DEFAULT_MAX_PER_SESSION;
    const nudgeText =
      typeof cfg.nudgeText === "string" && cfg.nudgeText.trim()
        ? cfg.nudgeText.trim()
        : DEFAULT_NUDGE_TEXT;

    api.on("before_prompt_build", async (event, ctx) => {
      const sessionId = ctx.sessionId ?? ctx.agentId ?? "default";
      const state = getSessionState(sessionId);

      // Accumulate user turn count by delta only — never overwrite.
      // After context compaction the message list may shrink; using max(0, delta)
      // prevents the counter from going backwards.
      const currentUserMsgCount = countUserMessages(event.messages);
      const delta = Math.max(0, currentUserMsgCount - state.lastCountedUserMsgs);
      state.userTurnCount += delta;
      state.lastCountedUserMsgs = currentUserMsgCount;

      // Check if we should nudge: at interval boundaries only
      if (state.userTurnCount === 0 || state.userTurnCount % interval !== 0) {
        return undefined;
      }

      // Avoid double-nudging: skip if we already nudged at this exact turn count
      if (state.lastNudgedAt === state.userTurnCount) {
        return undefined;
      }

      // Respect max-per-session limit
      if (maxPerSession > 0 && state.nudgeCount >= maxPerSession) {
        return undefined;
      }

      // Issue the nudge
      state.nudgeCount++;
      state.lastNudgedAt = state.userTurnCount;

      api.logger.info?.(
        `memory-nudge: injecting nudge at turn ${state.userTurnCount} (nudge #${state.nudgeCount} for session ${sessionId})`,
      );

      return { prependContext: nudgeText };
    });
  },
});
