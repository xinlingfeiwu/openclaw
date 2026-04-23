import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expandHomePrefix } from "openclaw/plugin-sdk/infra-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// Invisible Unicode characters used in prompt injection attacks.
// Matches hermes _CONTEXT_INVISIBLE_CHARS detection logic.
const INVISIBLE_UNICODE_REGEX =
  /\u200B|\u200C|\u200D|\u2060|\uFEFF|\u202A|\u202B|\u202C|\u202D|\u202E/;

// Patterns considered dangerous defaults requiring approval.
// Organized by category, aligned with hermes tools/approval.py (30+ patterns).
const DEFAULT_DANGEROUS_PATTERNS = [
  // File system destruction
  /\brm\s+-[rRfF]{1,3}\s/i,
  /\bdrop\s+(table|database)\b/i,
  /\bformat\s+[a-z]:/i,
  />\s*\/dev\/(sda|nvme|disk\d)/i,
  /\bdd\s+if=/i,
  /\bshred\b/i,
  /\btruncate\s+-s\s+0\b/i,
  // Privilege escalation
  /\bsudo\s+/i,
  /\bsu\s+-\b/i,
  /\bchmod\s+([-+]?s|777|666|[ugo]\+[ws])/i,
  /\bchown\s+root/i,
  /\bsetuid\b/i,
  // System / service disruption
  /\bsystemctl\s+(stop|disable|mask)\b/i,
  /\bservice\s+\w+\s+(stop|disable)\b/i,
  /\bkillall\b/i,
  /\bkill\s+-9\s+-1\b/i, // kill ALL processes
  // Fork bomb / infinite loops
  /:\(\)\s*\{.*?:\|:&\s*\};:/s, // bash fork bomb
  // Remote code execution via pipe-to-shell
  /\bcurl\b.*\|\s*(ba)?sh\b/i,
  /\bwget\b.*\|\s*(ba)?sh\b/i,
  /\bpipe_to_shell\b/i,
  // eval / dynamic code execution
  /\beval\b.*base64/i,
  /\bpython\s+-c\b/i,
  /\bperl\s+-e\b/i,
  /\bnode\s+-e\b/i,
  /\bsh\s+-c\b/i,
  /\bbash\s+-c\b/i,
  // Credential / secrets exposure
  /\bcat\s+.*\/(\.ssh|\.gnupg|\.aws|\.config\/gcloud)\//i,
  /\benv\b.*secret/i,
  /\bprintenv\b/i,
  // Network exfiltration patterns
  /\bnc\s+-[el]\b/i, // netcat listen/exec
  /\b(ngrok|pagekite|localtunnel)\b/i,
  // SSRF — cloud metadata endpoints
  /169\.254\.169\.254/,
  /metadata\.google\.internal/i,
  /metadata\.goog\b/i,
  // Credential exfiltration via curl/wget with env var secrets
  /\bcurl\b[^;]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASS)/i,
  /\bwget\b[^;]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASS)/i,
];

const DEFAULT_SENSITIVE_TOOLS = new Set([
  "bash",
  "run_terminal_cmd",
  "computer",
  "str_replace_based_edit_tool",
]);

type ApprovalPattern = {
  toolName: string;
  commandPrefix: string; // first 200 chars of command, normalized
  approvedAt: number;
  approvedCount: number;
};

type PatternsData = {
  patterns: ApprovalPattern[];
  lastUpdated: string;
};

type SmartApprovalsConfig = {
  enabled?: boolean;
  patternsFile?: string;
  sensitiveTools?: string[];
  dangerousPatterns?: string[];
  /** Hard timeout in seconds for subagent delegation. Default: 300 */
  delegationTimeoutSeconds?: number;
  /** Heartbeat check interval in seconds. Default: 30 */
  heartbeatIntervalSeconds?: number;
  /** Stale cycles before escalating warning. Default: 5 */
  staleThresholdCycles?: number;
};

function loadPatterns(patternsFile: string): PatternsData {
  try {
    if (existsSync(patternsFile)) {
      return JSON.parse(readFileSync(patternsFile, "utf-8")) as PatternsData;
    }
  } catch {}
  return { patterns: [], lastUpdated: new Date().toISOString() };
}

function savePatterns(patternsFile: string, data: PatternsData): void {
  try {
    const dir = dirname(patternsFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    data.lastUpdated = new Date().toISOString();
    writeFileSync(patternsFile, JSON.stringify(data, null, 2));
  } catch {}
}

function extractCommandString(params: Record<string, unknown>): string {
  const cmd = params.command ?? params.cmd ?? params.input ?? params.text ?? params.content ?? "";
  const cmdStr = typeof cmd === "string" ? cmd : JSON.stringify(cmd);
  return cmdStr.trim().slice(0, 80);
}

function normalizeCommand(cmd: string): string {
  return cmd.toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

function isDangerous(cmd: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(cmd));
}

export default definePluginEntry({
  id: "smart-approvals",
  name: "Smart Approvals",
  description:
    "Requires approval for dangerous tool patterns, learns from decisions to reduce future friction.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as SmartApprovalsConfig;
    if (cfg.enabled === false) {
      return;
    }

    const patternsFile = expandHomePrefix(
      typeof cfg.patternsFile === "string" && cfg.patternsFile.trim()
        ? cfg.patternsFile
        : "~/.openclaw/approved-patterns.json",
    );

    const sensitiveTools =
      Array.isArray(cfg.sensitiveTools) && cfg.sensitiveTools.length > 0
        ? new Set(cfg.sensitiveTools)
        : DEFAULT_SENSITIVE_TOOLS;

    const dangerousPatterns: RegExp[] =
      Array.isArray(cfg.dangerousPatterns) && cfg.dangerousPatterns.length > 0
        ? cfg.dangerousPatterns
            .map((p) => {
              try {
                return new RegExp(p, "i");
              } catch {
                return null;
              }
            })
            .filter((r): r is RegExp => r !== null)
        : DEFAULT_DANGEROUS_PATTERNS;

    // Subagent delegation timeout monitoring.
    // Tracks running subagents and warns when they exceed hard timeout or stale heartbeat.
    const hardTimeoutMs =
      typeof cfg.delegationTimeoutSeconds === "number" && cfg.delegationTimeoutSeconds > 0
        ? cfg.delegationTimeoutSeconds * 1000
        : 300_000; // 5 minutes
    const heartbeatMs =
      typeof cfg.heartbeatIntervalSeconds === "number" && cfg.heartbeatIntervalSeconds > 0
        ? cfg.heartbeatIntervalSeconds * 1000
        : 30_000; // 30 seconds
    const staleCycles =
      typeof cfg.staleThresholdCycles === "number" && cfg.staleThresholdCycles > 0
        ? cfg.staleThresholdCycles
        : 5;

    type SubagentMonitor = {
      label: string;
      spawnedAt: number;
      lastActivityAt: number;
      staleCount: number;
      hardTimeoutHandle: ReturnType<typeof setTimeout>;
      heartbeatHandle: ReturnType<typeof setInterval>;
    };
    const activeSubagents = new Map<string, SubagentMonitor>();

    api.on("subagent_spawned", (event, _ctx) => {
      const ev = event as { childSessionKey: string; agentId?: string; label?: string };
      const key = ev.childSessionKey;
      const label = ev.label ?? ev.agentId ?? key.slice(0, 8);
      const now = Date.now();

      const hardTimeoutHandle = setTimeout(() => {
        const monitor = activeSubagents.get(key);
        if (monitor) {
          const elapsed = Math.round((Date.now() - monitor.spawnedAt) / 1000);
          api.logger.warn?.(
            `smart-approvals: subagent "${label}" hard timeout reached after ${elapsed}s ` +
              `(limit: ${hardTimeoutMs / 1000}s). Gateway will handle cleanup.`,
          );
        }
      }, hardTimeoutMs);

      const heartbeatHandle = setInterval(() => {
        const monitor = activeSubagents.get(key);
        if (!monitor) {
          clearInterval(heartbeatHandle);
          return;
        }
        const inactiveSecs = Math.round((Date.now() - monitor.lastActivityAt) / 1000);
        if (inactiveSecs * 1000 >= heartbeatMs) {
          monitor.staleCount++;
          if (monitor.staleCount >= staleCycles) {
            const totalSecs = Math.round((Date.now() - monitor.spawnedAt) / 1000);
            api.logger.warn?.(
              `smart-approvals: subagent "${label}" appears stale — no activity for ` +
                `${inactiveSecs}s (${monitor.staleCount} cycles, running ${totalSecs}s total). ` +
                `Consider /new if the agent is stuck.`,
            );
          }
        }
      }, heartbeatMs);

      activeSubagents.set(key, {
        label,
        spawnedAt: now,
        lastActivityAt: now,
        staleCount: 0,
        hardTimeoutHandle,
        heartbeatHandle,
      });

      api.logger.info?.(
        `smart-approvals: monitoring subagent "${label}" (hard limit: ${hardTimeoutMs / 1000}s)`,
      );
    });

    api.on("subagent_ended", (event, _ctx) => {
      const ev = event as { targetSessionKey: string; outcome?: string; reason?: string };
      const key = ev.targetSessionKey;
      const monitor = activeSubagents.get(key);
      if (monitor) {
        clearTimeout(monitor.hardTimeoutHandle);
        clearInterval(monitor.heartbeatHandle);
        activeSubagents.delete(key);
        const elapsed = Math.round((Date.now() - monitor.spawnedAt) / 1000);
        api.logger.info?.(
          `smart-approvals: subagent "${monitor.label}" ended after ${elapsed}s ` +
            `(outcome: ${ev.outcome ?? ev.reason ?? "unknown"})`,
        );
      }
    });

    // Clean up all active subagent monitors when the parent session ends.
    // Handles abnormal session termination where subagent_ended may not fire.
    api.on("agent_end", (_event, _ctx) => {
      for (const [, monitor] of activeSubagents) {
        clearTimeout(monitor.hardTimeoutHandle);
        clearInterval(monitor.heartbeatHandle);
      }
      activeSubagents.clear();
    });

    // Update last activity time on llm_output for stale detection
    api.on("llm_output", (event, ctx) => {
      const sessionId = (ctx as { sessionId?: string }).sessionId ?? "";
      for (const [key, monitor] of activeSubagents) {
        if (key === sessionId) {
          monitor.lastActivityAt = Date.now();
          monitor.staleCount = 0;
          break;
        }
      }
      // Also check if event has a sessionId hint
      const ev = event as { sessionId?: string };
      if (ev.sessionId) {
        const monitor = activeSubagents.get(ev.sessionId);
        if (monitor) {
          monitor.lastActivityAt = Date.now();
          monitor.staleCount = 0;
        }
      }
    });

    api.on("before_tool_call", (event, _ctx) => {
      const ev = event as {
        toolName?: string;
        params?: Record<string, unknown>;
      };
      const toolName = ev.toolName ?? "";
      if (!sensitiveTools.has(toolName)) {
        return undefined;
      }

      const params = ev.params ?? {};
      const cmdStr = extractCommandString(params);
      if (!cmdStr) {
        return undefined;
      }

      // Invisible Unicode in command → always flag, don't silently allow
      if (INVISIBLE_UNICODE_REGEX.test(cmdStr)) {
        api.logger.warn?.(
          `smart-approvals: invisible Unicode detected in command "${cmdStr.slice(0, 60)}" — possible injection`,
        );
        return {
          requireApproval: {
            title: `Invisible Unicode characters detected`,
            description: `Command contains invisible Unicode (zero-width joiners, BOM, or RTL overrides): \`${cmdStr.slice(0, 100)}\`\n\nThis may indicate a prompt injection attack. Allow?`,
            severity: "critical" as const,
            timeoutMs: 30_000,
            timeoutBehavior: "deny" as const,
          },
        };
      }

      if (!isDangerous(cmdStr, dangerousPatterns)) {
        return undefined;
      }

      const normalKey = normalizeCommand(cmdStr);

      // Check if this pattern was previously approved
      const data = loadPatterns(patternsFile);
      const existing = data.patterns.find(
        (p) => p.toolName === toolName && p.commandPrefix === normalKey,
      );

      if (existing) {
        // Already approved before — allow silently
        existing.approvedCount++;
        existing.approvedAt = Date.now();
        savePatterns(patternsFile, data);
        api.logger.info?.(
          `smart-approvals: auto-allowing previously approved pattern "${cmdStr.slice(0, 40)}"`,
        );
        return undefined;
      }

      // First time: require approval
      return {
        requireApproval: {
          title: `Potentially dangerous command`,
          description: `Command: \`${cmdStr.slice(0, 100)}\`\n\nThis matches a dangerous pattern. Allow?`,
          severity: "warning" as const,
          timeoutMs: 30_000,
          timeoutBehavior: "deny" as const,
          onResolution: (decision: string) => {
            if (decision === "allow-once" || decision === "allow-always") {
              const fresh = loadPatterns(patternsFile);
              const pattern: ApprovalPattern = {
                toolName,
                commandPrefix: normalKey,
                approvedAt: Date.now(),
                approvedCount: 1,
              };
              fresh.patterns.push(pattern);
              savePatterns(patternsFile, fresh);
              api.logger.info?.(`smart-approvals: saved approved pattern "${normalKey}"`);
            }
          },
        },
      };
    });
  },
});
