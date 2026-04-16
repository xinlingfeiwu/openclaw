import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

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

type SessionStat = {
  sessionId: string;
  toolCalls: ToolCallStat[];
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
    sessions: data.sessions.filter(
      (s) => s.startTs > cutoff || (s.endTs ?? 0) > cutoff,
    ),
  };
}

function saveData(statsFile: string, data: InsightsData): void {
  try {
    const dir = dirname(statsFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    data.lastUpdated = new Date().toISOString();
    writeFileSync(statsFile, JSON.stringify(data, null, 2));
  } catch (e) {
    // Non-fatal: insights tracking should never disrupt agent operation
    appendFileSync("/tmp/openclaw-insights-error.log", `${String(e)}\n`);
  }
}

export default definePluginEntry({
  id: "insights-tracker",
  name: "Insights Tracker",
  description:
    "Tracks tool usage, response times, and session stats for behavioral analysis.",
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
      typeof cfg.maxHistoryDays === "number" && cfg.maxHistoryDays > 0
        ? cfg.maxHistoryDays
        : 30;

    // In-memory buffer; flushed on agent_end or periodically
    const sessionBuffers = new Map<string, SessionStat>();

    function getOrCreateSession(sessionId: string): SessionStat {
      let s = sessionBuffers.get(sessionId);
      if (!s) {
        s = { sessionId, toolCalls: [], startTs: Date.now() };
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

    api.on("agent_end", (_event, ctx) => {
      const sessionId = ctx.sessionId ?? ctx.agentId ?? "default";
      const session = sessionBuffers.get(sessionId);
      if (!session) {return;}

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
        api.logger.info?.(
          `insights-tracker: saved stats for session ${sessionId} (${session.toolCalls.length} tool calls)`,
        );
      } catch (e) {
        api.logger.warn?.(`insights-tracker: failed to save stats: ${String(e)}`);
      }
    });
  },
});
