import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

type ProcessRecord = {
  runId: string;
  sessionId: string;
  toolName: string;
  command: string;
  startedAt: number;
  durationMs?: number;
  status: "running" | "completed" | "long-running";
};

type ProcessMonitorConfig = {
  enabled?: boolean;
  maxTracked?: number;
  longRunningThresholdMs?: number;
};

export default definePluginEntry({
  id: "process-monitor",
  name: "Process Monitor",
  description: "Tracks long-running bash processes and summarises them in agent context.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as ProcessMonitorConfig;
    if (cfg.enabled === false) {
      return;
    }

    const maxTracked =
      typeof cfg.maxTracked === "number" && cfg.maxTracked > 0 ? cfg.maxTracked : 20;

    const longRunningThreshold =
      typeof cfg.longRunningThresholdMs === "number" && cfg.longRunningThresholdMs > 0
        ? cfg.longRunningThresholdMs
        : 5_000;

    // Records for the current gateway lifetime (cleared on gateway restart)
    const registry = new Map<string, ProcessRecord>();
    const callStart = new Map<string, number>();

    function extractCommand(params: Record<string, unknown>): string {
      const cmd = params.command ?? params.cmd ?? params.input ?? "";
      return (cmd as string).slice(0, 200);
    }

    api.on("before_tool_call", (event, ctx) => {
      const ev = event as {
        toolName?: string;
        params?: Record<string, unknown>;
        toolCallId?: string;
      };
      const toolName = ev.toolName ?? ctx.toolName ?? "";
      if (toolName !== "bash" && toolName !== "run_terminal_cmd") {
        return undefined;
      }

      const key = ev.toolCallId ?? `${ctx.agentId}_${Date.now()}`;
      callStart.set(key, Date.now());

      return undefined;
    });

    api.on("after_tool_call", (event, ctx) => {
      const ev = event as {
        toolName?: string;
        params?: Record<string, unknown>;
        toolCallId?: string;
        durationMs?: number;
      };
      const toolName = ev.toolName ?? ctx.toolName ?? "";
      if (toolName !== "bash" && toolName !== "run_terminal_cmd") {
        return;
      }

      const key = ev.toolCallId ?? "";
      const started = callStart.get(key) ?? Date.now();
      const durationMs = ev.durationMs ?? Date.now() - started;
      callStart.delete(key);

      if (durationMs < longRunningThreshold) {
        return;
      }

      const sessionId = ctx.sessionId ?? ctx.agentId ?? "default";
      const command = extractCommand((ev.params as Record<string, unknown>) ?? {});

      if (registry.size >= maxTracked) {
        // Prune oldest completed
        for (const [id, rec] of registry) {
          if (rec.status === "completed") {
            registry.delete(id);
            break;
          }
        }
      }

      const rec: ProcessRecord = {
        runId: key || `${sessionId}_${Date.now()}`,
        sessionId,
        toolName,
        command,
        startedAt: started,
        durationMs,
        status: "long-running",
      };
      registry.set(rec.runId, rec);
      api.logger.info?.(
        `process-monitor: long-running tool detected: "${command}" (${durationMs}ms)`,
      );
    });

    api.on("before_prompt_build", (_event, _ctx) => {
      const longRunning = [...registry.values()].filter((r) => r.status === "long-running");
      if (longRunning.length === 0) {
        return undefined;
      }

      const lines = longRunning
        .slice(-5) // show at most 5 most-recent
        .map(
          (r) =>
            `- \`${r.command}\` (took ${Math.round((r.durationMs ?? 0) / 1000)}s, session ${r.sessionId})`,
        )
        .join("\n");

      const context = `<process_monitor>
The following commands took longer than ${Math.round(longRunningThreshold / 1000)}s in this session:
${lines}
Consider whether these are still relevant before repeating them.
</process_monitor>`;

      return { appendSystemContext: context };
    });
  },
});
