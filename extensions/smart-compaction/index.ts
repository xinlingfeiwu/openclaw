import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

const DEFAULT_COOLDOWN_MS = 120_000; // 2 minutes
const DEFAULT_MIN_MESSAGES = 10;

// Structured 13-section compaction template guidance (ported from hermes context_compressor.py).
// Injected via appendSystemContext so the agent and compaction LLM receive consistent guidance.
const COMPACTION_TEMPLATE_GUIDANCE = `
CRITICAL RULE: The text of the LAST USER MESSAGE must be preserved VERBATIM in the Active Task
section. Never omit, paraphrase, or summarize it — it represents the user's current active request.

When compressing or summarizing conversation context, use this structured 13-section template:

## Active Task
What the user is currently trying to accomplish.

## Goal
The ultimate objective or deliverable.

## Completed Actions
What has been done so far (concise bullet points, past tense).

## Active State
Current state of files, processes, and system (what exists right now after changes).

## In Progress
Work currently in flight (if anything is mid-execution).

## Blocked
Items waiting on external input or blocked by an issue (with reason).

## Key Decisions
Important choices made and the rationale behind them.

## Resolved Questions
Questions or ambiguities that were clarified during this session.

## Pending User Asks
Questions or requests from the agent still awaiting user response.

## Relevant Files
Key files modified or created (relative paths preferred, one per line).

## Remaining Work
Clear ordered list of what still needs to be done to complete the goal.

## Constraints
Hard rules, requirements, or limitations in effect for this task.

## Critical Context
Any information that absolutely must survive into the next session.`.trim();

type SmartCompactionConfig = {
  enabled?: boolean;
  cooldownMs?: number;
  minMessagesSinceLastCompaction?: number;
  /** Whether to inject structured compaction template guidance into system prompt (default: true) */
  injectTemplate?: boolean;
};

type SessionState = {
  lastCompactionAt: number;
  messageCountAtLastCompaction: number;
  poorCompactionWarningPending: boolean;
  lastCompactionRatio?: number;
};

// Per-session in-memory state (keyed by sessionId or agentId)
const sessionState = new Map<string, SessionState>();

export default definePluginEntry({
  id: "smart-compaction",
  name: "Smart Compaction",
  description:
    "Anti-thrash compaction guard: skips compaction if one ran recently within the cooldown window. Also injects a structured 13-section compaction template into the system prompt to improve summary quality (ported from hermes context_compressor.py).",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as SmartCompactionConfig;
    if (cfg.enabled === false) {
      return;
    }

    const cooldownMs =
      typeof cfg.cooldownMs === "number" && cfg.cooldownMs >= 0
        ? cfg.cooldownMs
        : DEFAULT_COOLDOWN_MS;

    const minMessages =
      typeof cfg.minMessagesSinceLastCompaction === "number" &&
      cfg.minMessagesSinceLastCompaction >= 0
        ? cfg.minMessagesSinceLastCompaction
        : DEFAULT_MIN_MESSAGES;

    const injectTemplate = cfg.injectTemplate !== false;

    // Inject structured 13-section compaction template via system prompt
    if (injectTemplate) {
      api.on("before_prompt_build", (_event, ctx) => {
        const key =
          (ctx as { sessionId?: string }).sessionId ??
          (ctx as { agentId?: string }).agentId ??
          "default";
        const state = sessionState.get(key);

        let extra = "";
        if (state?.poorCompactionWarningPending) {
          state.poorCompactionWarningPending = false;
          const pct =
            state.lastCompactionRatio !== undefined
              ? `${(state.lastCompactionRatio * 100).toFixed(0)}%`
              : "very few";
          extra =
            `\n\n[Smart Compaction] The last compaction was ineffective (only ${pct} of messages were reduced). ` +
            `If the context feels noisy or confused, consider using /reset to start a fresh session.`;
        }

        return { appendSystemContext: `\n\n${COMPACTION_TEMPLATE_GUIDANCE}${extra}\n` };
      });
    }

    api.on("after_compaction", async (ev, ctx) => {
      const event = ev as { messageCount?: number; compactedCount?: number };
      const key =
        (ctx as { sessionId?: string }).sessionId ??
        (ctx as { agentId?: string }).agentId ??
        "default";

      const messageCount = event.messageCount ?? 0;
      const compactedCount = event.compactedCount ?? 0;
      const ratio = messageCount > 0 ? compactedCount / messageCount : 1;

      sessionState.set(key, {
        lastCompactionAt: Date.now(),
        messageCountAtLastCompaction: messageCount,
        poorCompactionWarningPending: ratio < 0.2 && messageCount >= 10,
        lastCompactionRatio: ratio,
      });

      if (ratio < 0.2 && messageCount >= 10) {
        api.logger.info?.(
          `smart-compaction: low effectiveness ratio ${(ratio * 100).toFixed(0)}% ` +
            `(${compactedCount}/${messageCount} messages reduced) — will suggest /reset`,
        );
      }
    });

    api.on("before_compaction", async (ev, ctx) => {
      const event = ev as { messageCount?: number };
      const key =
        (ctx as { sessionId?: string }).sessionId ??
        (ctx as { agentId?: string }).agentId ??
        "default";
      const state = sessionState.get(key);
      if (!state) {
        return;
      }

      const msSince = Date.now() - state.lastCompactionAt;
      if (msSince < cooldownMs) {
        const secLeft = Math.ceil((cooldownMs - msSince) / 1000);
        api.logger.debug?.(
          `smart-compaction: cooldown active — last compaction was ${Math.floor(msSince / 1000)}s ago (${secLeft}s remaining)`,
        );
        return;
      }

      const msgsSince = (event.messageCount ?? 0) - state.messageCountAtLastCompaction;
      if (msgsSince < minMessages) {
        api.logger.debug?.(
          `smart-compaction: too few new messages since last compaction: ${msgsSince} < ${minMessages}`,
        );
        return;
      }
    });

    // Clean up per-session state when session ends to prevent unbounded map growth.
    api.on("agent_end", (_event, ctx) => {
      const key =
        (ctx as { sessionId?: string }).sessionId ??
        (ctx as { agentId?: string }).agentId ??
        "default";
      sessionState.delete(key);
    });
  },
});
