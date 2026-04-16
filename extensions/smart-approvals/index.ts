import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// Patterns considered dangerous defaults requiring approval
const DEFAULT_DANGEROUS_PATTERNS = [
  /\brm\s+-rf?\s/i,
  /\bdrop\s+(table|database)\b/i,
  /\bformat\s+[a-z]:/i,
  /sudo\s+/i,
  />\s*\/dev\/(sda|nvme|disk)/i,
  /\bdd\s+if=/i,
  /\bsystemctl\s+(stop|disable|mask)\b/i,
  /\bkillall\b/i,
  /\bchmod\s+-R\s+777/i,
];

const DEFAULT_SENSITIVE_TOOLS = new Set([
  "bash",
  "run_terminal_cmd",
  "computer",
  "str_replace_based_edit_tool",
]);

type ApprovalPattern = {
  toolName: string;
  commandPrefix: string; // first 40 chars of command, normalized
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
};

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

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
  const cmd =
    params.command ??
    params.cmd ??
    params.input ??
    params.text ??
    params.content ??
    "";
  return String(cmd).trim().slice(0, 80);
}

function normalizeCommand(cmd: string): string {
  return cmd.toLowerCase().replace(/\s+/g, " ").slice(0, 40);
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

    const patternsFile = expandHome(
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
              api.logger.info?.(
                `smart-approvals: saved approved pattern "${normalKey}"`,
              );
            }
          },
        },
      };
    });
  },
});
