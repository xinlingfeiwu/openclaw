import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

const DEFAULT_COOLDOWN_MS = 120_000; // 2 minutes
const DEFAULT_MIN_MESSAGES = 10;

type SmartCompactionConfig = {
  enabled?: boolean;
  cooldownMs?: number;
  minMessagesSinceLastCompaction?: number;
};

type SessionState = {
  lastCompactionAt: number;
  messageCountAtLastCompaction: number;
};

// Per-session in-memory state (keyed by sessionId or agentId)
const sessionState = new Map<string, SessionState>();

export default definePluginEntry({
  id: "smart-compaction",
  name: "Smart Compaction",
  description:
    "Anti-thrash compaction guard: skips compaction if one ran recently within the cooldown window.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as SmartCompactionConfig;
    if (cfg.enabled === false) return;

    const cooldownMs =
      typeof cfg.cooldownMs === "number" && cfg.cooldownMs >= 0
        ? cfg.cooldownMs
        : DEFAULT_COOLDOWN_MS;

    const minMessages =
      typeof cfg.minMessagesSinceLastCompaction === "number" &&
      cfg.minMessagesSinceLastCompaction >= 0
        ? cfg.minMessagesSinceLastCompaction
        : DEFAULT_MIN_MESSAGES;

    api.on("after_compaction", async (ev, ctx) => {
      const event = ev as { messageCount?: number };
      const key =
        (ctx as { sessionId?: string }).sessionId ??
        (ctx as { agentId?: string }).agentId ??
        "default";
      sessionState.set(key, {
        lastCompactionAt: Date.now(),
        messageCountAtLastCompaction: event.messageCount ?? 0,
      });
    });

    api.on("before_compaction", async (ev, ctx) => {
      const event = ev as { messageCount?: number };
      const key =
        (ctx as { sessionId?: string }).sessionId ??
        (ctx as { agentId?: string }).agentId ??
        "default";
      const state = sessionState.get(key);
      if (!state) return undefined;

      const msSince = Date.now() - state.lastCompactionAt;
      if (msSince < cooldownMs) {
        const secLeft = Math.ceil((cooldownMs - msSince) / 1000);
        return {
          skip: true,
          skipReason: `cooldown: last compaction was ${Math.floor(msSince / 1000)}s ago (wait ${secLeft}s)`,
        };
      }

      const msgsSince = (event.messageCount ?? 0) - state.messageCountAtLastCompaction;
      if (msgsSince < minMessages) {
        return {
          skip: true,
          skipReason: `too few new messages since last compaction: ${msgsSince} < ${minMessages}`,
        };
      }

      return undefined;
    });
  },
});
