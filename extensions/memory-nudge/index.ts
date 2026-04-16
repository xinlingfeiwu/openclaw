import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

const DEFAULT_INTERVAL = 5;
const DEFAULT_MAX_PER_SESSION = 10;

const DEFAULT_NUDGE_TEXT = `<memory_nudge>
IMPORTANT: Reflect on the conversation so far and proactively save any useful information to memory using the memory tool. Consider saving:
- User preferences, habits, or stated requirements
- Technical environment details (OS, tools, versions, paths, configs)
- Recurring topics or domain context
- Decisions made and their rationale
- Error patterns or known workarounds
Do this now if there is anything worth remembering for future conversations.
</memory_nudge>`;

type MemoryNudgeConfig = {
  enabled?: boolean;
  interval?: number;
  maxPerSession?: number;
  nudgeText?: string;
};

// Per-session tracking: sessionId → { userTurnCount, nudgeCount, lastNudgedAt }
const sessionState = new Map<
  string,
  { userTurnCount: number; nudgeCount: number; lastNudgedAt: number }
>();

function getSessionState(sessionId: string) {
  let state = sessionState.get(sessionId);
  if (!state) {
    state = { userTurnCount: 0, nudgeCount: 0, lastNudgedAt: 0 };
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

      // Update user turn count from current messages
      const currentUserMsgCount = countUserMessages(event.messages);
      state.userTurnCount = currentUserMsgCount;

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
