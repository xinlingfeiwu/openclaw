import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// Model pricing in USD per 1M tokens (input/output/cacheRead).
// Fuzzy-matched: if model name contains a key (or key contains model name), pricing applies.
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  "gpt-5.4": { input: 2.5, output: 10.0, cacheRead: 1.25 },
  "gpt-5.4-mini": { input: 0.15, output: 0.6, cacheRead: 0.075 },
  "gpt-4.1": { input: 2.0, output: 8.0, cacheRead: 0.5 },
  "claude-opus-4.7": { input: 15.0, output: 75.0, cacheRead: 1.5 },
  "claude-opus-4.6": { input: 15.0, output: 75.0, cacheRead: 1.5 },
  "claude-opus-4.5": { input: 15.0, output: 75.0, cacheRead: 1.5 },
  "claude-sonnet-4.6": { input: 3.0, output: 15.0, cacheRead: 0.3 },
  "claude-sonnet-4.5": { input: 3.0, output: 15.0, cacheRead: 0.3 },
  "claude-haiku-4.5": { input: 0.8, output: 4.0, cacheRead: 0.08 },
  "gemini-2.5-pro": { input: 1.25, output: 5.0, cacheRead: 0.31 },
  "gemini-2.5-flash": { input: 0.075, output: 0.3, cacheRead: 0.019 },
};

function findPricing(model: string): { input: number; output: number; cacheRead: number } | null {
  const lower = model.toLowerCase();
  // Exact match first (longest matching key wins)
  let best: { input: number; output: number; cacheRead: number } | null = null;
  let bestLen = 0;
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (lower.includes(key.toLowerCase()) && key.length > bestLen) {
      best = pricing;
      bestLen = key.length;
    }
  }
  return best;
}

function estimateCostUsd(stat: TokenUsageStat): number {
  const pricing = findPricing(stat.model);
  if (!pricing) {
    return 0;
  }
  const inputCost = ((stat.inputTokens + stat.cacheWriteTokens) / 1_000_000) * pricing.input;
  const outputCost = (stat.outputTokens / 1_000_000) * pricing.output;
  const cacheReadCost = (stat.cacheReadTokens / 1_000_000) * pricing.cacheRead;
  return inputCost + outputCost + cacheReadCost;
}

type InsightsConfig = {
  enabled?: boolean;
  statsFile?: string;
  maxHistoryDays?: number;
};

type ToolCallStat = {
  tool: string;
  durationMs?: number;
  success: boolean;
  ts: number; // unix ms
};

type TokenUsageStat = {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  ts: number;
};

type SessionStat = {
  sessionId: string;
  toolCalls: ToolCallStat[];
  tokenUsage: TokenUsageStat[];
  startTs: number;
  endTs?: number;
};

type InsightsData = {
  sessions: SessionStat[];
  lastUpdated: string;
};

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function loadData(statsFile: string): InsightsData {
  try {
    if (existsSync(statsFile)) {
      return JSON.parse(readFileSync(statsFile, "utf-8")) as InsightsData;
    }
  } catch {}
  return { sessions: [], lastUpdated: new Date().toISOString() };
}

function pruneOldSessions(data: InsightsData, maxDays: number): InsightsData {
  const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
  return {
    ...data,
    sessions: data.sessions.filter((s) => s.startTs > cutoff || (s.endTs ?? 0) > cutoff),
  };
}

function saveData(statsFile: string, data: InsightsData): void {
  try {
    const dir = dirname(statsFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    data.lastUpdated = new Date().toISOString();
    writeFileSync(statsFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (e) {
    // Non-fatal: insights tracking should never disrupt agent operation
    appendFileSync("/tmp/openclaw-insights-error.log", `${String(e)}\n`);
  }
}

export default definePluginEntry({
  id: "insights-tracker",
  name: "Insights Tracker",
  description: "Tracks tool usage, response times, and session stats for behavioral analysis.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as InsightsConfig;
    if (cfg.enabled === false) {
      return;
    }

    const statsFile = expandHome(
      typeof cfg.statsFile === "string" && cfg.statsFile.trim()
        ? cfg.statsFile
        : "~/.openclaw/insights/stats.json",
    );
    const maxDays =
      typeof cfg.maxHistoryDays === "number" && cfg.maxHistoryDays > 0 ? cfg.maxHistoryDays : 30;

    // In-memory buffer; flushed on agent_end or periodically
    const sessionBuffers = new Map<string, SessionStat>();

    function getOrCreateSession(sessionId: string): SessionStat {
      let s = sessionBuffers.get(sessionId);
      if (!s) {
        s = { sessionId, toolCalls: [], tokenUsage: [], startTs: Date.now() };
        sessionBuffers.set(sessionId, s);
      }
      return s;
    }

    api.on("after_tool_call", (event, ctx) => {
      const sessionId = ctx.sessionId ?? ctx.agentId ?? "default";
      const ev = event as {
        toolName?: string;
        durationMs?: number;
        error?: string;
      };
      const stat: ToolCallStat = {
        tool: ctx.toolName ?? ev.toolName ?? "unknown",
        durationMs: ev.durationMs,
        success: !ev.error,
        ts: Date.now(),
      };
      getOrCreateSession(sessionId).toolCalls.push(stat);
    });

    // Track token usage from LLM responses
    api.on("llm_output", (event, ctx) => {
      const sessionId = ctx.sessionId ?? ctx.agentId ?? "default";
      const ev = event as {
        provider?: string;
        model?: string;
        usage?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
        };
      };
      const usage = ev.usage;
      if (!usage) {
        return;
      }
      const stat: TokenUsageStat = {
        provider: ev.provider ?? "unknown",
        model: ev.model ?? "unknown",
        inputTokens: usage.input ?? 0,
        outputTokens: usage.output ?? 0,
        cacheReadTokens: usage.cacheRead ?? 0,
        cacheWriteTokens: usage.cacheWrite ?? 0,
        ts: Date.now(),
      };
      getOrCreateSession(sessionId).tokenUsage.push(stat);
      api.logger.info?.(
        `insights-tracker: ${stat.provider}/${stat.model} — in=${stat.inputTokens} out=${stat.outputTokens} ` +
          `cacheR=${stat.cacheReadTokens} cacheW=${stat.cacheWriteTokens}`,
      );
    });

    api.on("agent_end", (_event, ctx) => {
      const sessionId = ctx.sessionId ?? ctx.agentId ?? "default";
      const session = sessionBuffers.get(sessionId);
      if (!session) {
        return;
      }

      session.endTs = Date.now();
      sessionBuffers.delete(sessionId);

      try {
        let data = loadData(statsFile);
        data = pruneOldSessions(data, maxDays);
        // Merge: replace existing session entry or append
        const idx = data.sessions.findIndex((s) => s.sessionId === sessionId);
        if (idx >= 0) {
          data.sessions[idx] = session;
        } else {
          data.sessions.push(session);
        }
        saveData(statsFile, data);
        const totalIn = session.tokenUsage.reduce((sum, t) => sum + t.inputTokens, 0);
        const totalOut = session.tokenUsage.reduce((sum, t) => sum + t.outputTokens, 0);
        const estimatedUsd = session.tokenUsage.reduce((sum, t) => sum + estimateCostUsd(t), 0);
        api.logger.info?.(
          `insights-tracker: saved stats for session ${sessionId} ` +
            `(${session.toolCalls.length} tool calls, tokens in=${totalIn} out=${totalOut}, ~$${estimatedUsd.toFixed(4)} USD)`,
        );
      } catch (e) {
        api.logger.warn?.(`insights-tracker: failed to save stats: ${String(e)}`);
      }
    });
  },
});
