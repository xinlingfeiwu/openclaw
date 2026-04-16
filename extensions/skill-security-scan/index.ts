import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// Prompt injection patterns in skill file content
const INJECTION_PATTERNS = [
  { name: "ignore-instructions", pattern: /ignore\s+(all\s+)?(previous|prior)\s+instructions?/i },
  { name: "system-override", pattern: /<\s*system\s*>/i },
  { name: "jailbreak", pattern: /jailbreak|DAN\s*mode/i },
  { name: "exfil-webhook", pattern: /\bhttps?:\/\/[^\s]+\/webhook/i },
  { name: "exfil-curl-external", pattern: /\bcurl\s+[^\s]*(?:ngrok|requestbin|webhook\.site|pipedream)/i },
  { name: "base64-decode-exec", pattern: /base64\s+(-d|--decode)\s*\|?\s*(bash|sh|python)/i },
  { name: "data-exfil-env", pattern: /\$\{?(?:HOME|USER|API_KEY|SECRET|TOKEN|PASSWORD)/i },
  { name: "act-as-override", pattern: /act\s+as\s+(a\s+)?malicious/i },
];

type SkillSecurityConfig = {
  enabled?: boolean;
  blockOnThreat?: boolean;
  scanPaths?: string[];
};

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function isSkillPath(filePath: string, scanPaths: string[]): boolean {
  const abs = resolve(expandHome(filePath));
  return scanPaths.some((sp) => abs.startsWith(resolve(expandHome(sp))));
}

function scanContent(content: string): Array<{ name: string; match: string }> {
  const threats: Array<{ name: string; match: string }> = [];
  for (const { name, pattern } of INJECTION_PATTERNS) {
    const m = content.match(pattern);
    if (m) {
      threats.push({ name, match: m[0].slice(0, 60) });
    }
  }
  return threats;
}

export default definePluginEntry({
  id: "skill-security-scan",
  name: "Skill Security Scan",
  description:
    "Scans skill file writes for prompt injection and data exfiltration patterns.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as SkillSecurityConfig;
    if (cfg.enabled === false) {
      return;
    }

    const blockOnThreat = cfg.blockOnThreat === true;
    const scanPaths =
      Array.isArray(cfg.scanPaths) && cfg.scanPaths.length > 0
        ? cfg.scanPaths
        : ["~/.openclaw/skills"];

    api.on("before_tool_call", (event, _ctx) => {
      const ev = event as {
        toolName?: string;
        params?: Record<string, unknown>;
      };
      const toolName = ev.toolName ?? "";
      // Only scan file write tools
      if (
        !["write_file", "create_file", "str_replace_based_edit_tool", "create", "edit"].includes(
          toolName,
        )
      ) {
        return undefined;
      }

      const params = ev.params ?? {};
      const filePath = String(params.path ?? params.file_path ?? params.filename ?? "");
      if (!filePath || !isSkillPath(filePath, scanPaths)) {
        return undefined;
      }

      // Content to scan: new_content, content, file_text, new_str
      const content = String(
        params.new_content ??
          params.content ??
          params.file_text ??
          params.new_str ??
          "",
      );
      if (!content) {
        return undefined;
      }

      const threats = scanContent(content);
      if (threats.length === 0) {
        return undefined;
      }

      const summary = threats.map((t) => `${t.name}: "${t.match}"`).join("; ");
      api.logger.warn?.(
        `skill-security-scan: THREAT in skill file "${filePath}": ${summary}`,
      );

      if (blockOnThreat) {
        return {
          block: true,
          blockReason: `Skill security scan detected suspicious patterns: ${summary}. Write blocked.`,
        };
      }

      // Warn-only: allow but prompt the agent to review
      return {
        requireApproval: {
          title: "Skill Security Warning",
          description: `Writing to skill file \`${filePath}\` — detected suspicious patterns:\n\n${threats.map((t) => `- **${t.name}**: \`${t.match}\``).join("\n")}\n\nProceed?`,
          severity: "warning" as const,
          timeoutMs: 60_000,
          timeoutBehavior: "deny" as const,
        },
      };
    });
  },
});
