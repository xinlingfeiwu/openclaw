import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// Expanded threat pattern library — ported from hermes-agent/tools/skills_guard.py.
// 78+ patterns across 9 categories: exfiltration, prompt_injection, destructive,
// persistence, network, obfuscation, supply_chain, privilege_escalation, credential_exposure.
type ThreatPattern = {
  name: string;
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  pattern: RegExp;
};

const THREAT_PATTERNS: ThreatPattern[] = [
  // ── PROMPT INJECTION ──────────────────────────────────────────────────────
  {
    name: "ignore-previous-instructions",
    category: "prompt_injection",
    severity: "critical",
    pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  },
  {
    name: "disregard-instructions",
    category: "prompt_injection",
    severity: "critical",
    pattern: /disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  },
  {
    name: "forget-instructions",
    category: "prompt_injection",
    severity: "critical",
    pattern: /forget\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  },
  {
    name: "system-override-tag",
    category: "prompt_injection",
    severity: "critical",
    pattern: /<\s*system\s*>/i,
  },
  {
    name: "you-are-now-override",
    category: "prompt_injection",
    severity: "critical",
    pattern: /you\s+are\s+now\s+(a\s+)?(?!an?\s+(?:ai|assistant|agent|helpful))/i,
  },
  {
    name: "jailbreak-dan",
    category: "prompt_injection",
    severity: "critical",
    pattern: /jailbreak|DAN\s*(mode)?:/i,
  },
  {
    name: "override-behavior",
    category: "prompt_injection",
    severity: "high",
    pattern: /override\s+(your\s+)?(instructions?|behavior|personality|constraints?)/i,
  },
  {
    name: "pretend-to-be",
    category: "prompt_injection",
    severity: "high",
    pattern: /pretend\s+(you\s+are|to\s+be)\s+(?!helping|assist)/i,
  },
  {
    name: "act-as-malicious",
    category: "prompt_injection",
    severity: "critical",
    pattern: /act\s+as\s+(a\s+)?(?:malicious|hacker|attacker|adversary)/i,
  },
  {
    name: "do-not-tell-user",
    category: "prompt_injection",
    severity: "high",
    pattern: /do\s+not\s+(tell|inform|reveal\s+to)\s+(the\s+)?user/i,
  },
  {
    name: "hidden-html-execute",
    category: "prompt_injection",
    severity: "high",
    pattern: /<!--.*?(execute|inject|run|eval).*?-->/is,
  },
  {
    name: "display-none-inject",
    category: "prompt_injection",
    severity: "high",
    pattern: /<div[^>]+style\s*=\s*["']display\s*:\s*none/i,
  },

  // ── EXFILTRATION ──────────────────────────────────────────────────────────
  {
    name: "exfil-webhook",
    category: "exfiltration",
    severity: "critical",
    pattern: /\bhttps?:\/\/[^\s]+\/webhook/i,
  },
  {
    name: "exfil-ngrok",
    category: "exfiltration",
    severity: "critical",
    pattern: /\bcurl\s+[^\s]*(?:ngrok|requestbin|webhook\.site|pipedream|beeceptor)/i,
  },
  {
    name: "exfil-env-var",
    category: "exfiltration",
    severity: "critical",
    pattern: /\$\{?(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|PRIVATE_KEY|ACCESS_KEY)\b/i,
  },
  {
    name: "exfil-env-home-user",
    category: "exfiltration",
    severity: "high",
    pattern: /\$\{?(?:HOME|USER|LOGNAME|SHELL)\b/,
  },
  {
    name: "exfil-send-memory",
    category: "exfiltration",
    severity: "critical",
    pattern: /send\s+(all\s+)?(memory|context|secrets?|credentials?|keys?)\s+to/i,
  },
  {
    name: "exfil-keyword",
    category: "exfiltration",
    severity: "high",
    pattern: /exfil(?:trate)?/i,
  },
  {
    name: "exfil-ssh-key-cat",
    category: "exfiltration",
    severity: "critical",
    pattern: /\bcat\s+.*\.ssh\//i,
  },
  {
    name: "exfil-aws-credentials",
    category: "exfiltration",
    severity: "critical",
    pattern: /\bcat\s+.*\.aws\/credentials/i,
  },
  {
    name: "exfil-netrc",
    category: "exfiltration",
    severity: "critical",
    pattern: /\bcat\s+.*\.netrc\b/i,
  },
  {
    name: "exfil-curl-creds",
    category: "exfiltration",
    severity: "critical",
    pattern: /\bcurl\b[^;]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASS)/i,
  },
  {
    name: "exfil-wget-creds",
    category: "exfiltration",
    severity: "critical",
    pattern: /\bwget\b[^;]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASS)/i,
  },
  { name: "exfil-printenv", category: "exfiltration", severity: "high", pattern: /\bprintenv\b/i },
  {
    name: "exfil-shadow",
    category: "exfiltration",
    severity: "critical",
    pattern: /\/etc\/shadow\b/i,
  },
  {
    name: "exfil-gpg-export",
    category: "exfiltration",
    severity: "critical",
    pattern: /\bgpg\b.*--export.*--armor/i,
  },
  {
    name: "exfil-keychain",
    category: "exfiltration",
    severity: "critical",
    pattern: /security\s+find-(?:generic|internet|key)-password/i,
  },
  {
    name: "exfil-base64-pipe",
    category: "exfiltration",
    severity: "high",
    pattern: /\bbase64\b.*\|\s*(?:curl|wget|nc)\b/i,
  },

  // ── DESTRUCTIVE ───────────────────────────────────────────────────────────
  {
    name: "destructive-rm-recursive",
    category: "destructive",
    severity: "critical",
    pattern: /\brm\s+-[rRfF]{1,3}\s/i,
  },
  {
    name: "destructive-dd-wipe",
    category: "destructive",
    severity: "critical",
    pattern: /\bdd\s+if=/i,
  },
  { name: "destructive-shred", category: "destructive", severity: "high", pattern: /\bshred\b/i },
  {
    name: "destructive-truncate-zero",
    category: "destructive",
    severity: "high",
    pattern: /\btruncate\s+-s\s+0\b/i,
  },
  {
    name: "destructive-redirect-dev",
    category: "destructive",
    severity: "critical",
    pattern: />\s*\/dev\/(sda|nvme|disk\d)/i,
  },
  {
    name: "destructive-drop-table",
    category: "destructive",
    severity: "critical",
    pattern: /\bdrop\s+(table|database|schema)\b/i,
  },
  {
    name: "destructive-kill-all",
    category: "destructive",
    severity: "critical",
    pattern: /\bkill\s+-9\s+-1\b/,
  },
  {
    name: "destructive-format",
    category: "destructive",
    severity: "critical",
    pattern: /\bformat\s+[a-z]:/i,
  },

  // ── PERSISTENCE ───────────────────────────────────────────────────────────
  {
    name: "persistence-crontab-write",
    category: "persistence",
    severity: "high",
    pattern: /\bcrontab\s+-[el]\b/i,
  },
  {
    name: "persistence-launchd-plist",
    category: "persistence",
    severity: "high",
    pattern: /Library\/LaunchAgents|Library\/LaunchDaemons/i,
  },
  {
    name: "persistence-systemd-unit",
    category: "persistence",
    severity: "high",
    pattern: /\/etc\/systemd\/system\/.*\.service\b/i,
  },
  {
    name: "persistence-bashrc-inject",
    category: "persistence",
    severity: "high",
    pattern: />>\s*~?\/?(\.bashrc|\.zshrc|\.profile|\.bash_profile)/i,
  },
  {
    name: "persistence-authorized-keys",
    category: "persistence",
    severity: "critical",
    pattern: />>?\s*.*authorized_keys/i,
  },
  {
    name: "persistence-at-job",
    category: "persistence",
    severity: "medium",
    pattern: /\becho\b.*\|\s*\bat\b\s+(?:now|tomorrow|\d)/i,
  },
  {
    name: "persistence-git-hook",
    category: "persistence",
    severity: "medium",
    pattern: /\.git\/hooks\/(?:pre-commit|post-commit|pre-push)/i,
  },
  {
    name: "persistence-npm-postinstall",
    category: "persistence",
    severity: "medium",
    pattern: /"postinstall"\s*:/i,
  },
  {
    name: "persistence-startup-script",
    category: "persistence",
    severity: "medium",
    pattern: /\/etc\/(?:rc\.local|init\.d\/\w+)/i,
  },
  {
    name: "persistence-login-item",
    category: "persistence",
    severity: "medium",
    pattern: /osascript.*login\s+item/i,
  },

  // ── NETWORK ───────────────────────────────────────────────────────────────
  {
    name: "network-netcat-listen",
    category: "network",
    severity: "critical",
    pattern: /\bnc\s+-[el]\b/i,
  },
  {
    name: "network-tunnel-tool",
    category: "network",
    severity: "critical",
    pattern: /\b(ngrok|pagekite|localtunnel|bore|chisel|frpc)\b/i,
  },
  {
    name: "network-ssrf-aws-metadata",
    category: "network",
    severity: "critical",
    pattern: /169\.254\.169\.254/,
  },
  {
    name: "network-ssrf-gcp-metadata",
    category: "network",
    severity: "critical",
    pattern: /metadata\.google\.internal|metadata\.goog\b/i,
  },
  {
    name: "network-reverse-shell",
    category: "network",
    severity: "critical",
    pattern: /\bbash\s+-i\b.*>&\s*\/dev\/tcp/i,
  },
  {
    name: "network-curl-pipe-sh",
    category: "network",
    severity: "critical",
    pattern: /\bcurl\b.*\|\s*(ba)?sh\b/i,
  },
  {
    name: "network-wget-pipe-sh",
    category: "network",
    severity: "critical",
    pattern: /\bwget\b.*\|\s*(ba)?sh\b/i,
  },
  {
    name: "network-socat-exec",
    category: "network",
    severity: "critical",
    pattern: /\bsocat\b.*EXEC:/i,
  },
  {
    name: "network-iptables-flush",
    category: "network",
    severity: "high",
    pattern: /\biptables\s+-F\b/i,
  },
  {
    name: "network-port-scan",
    category: "network",
    severity: "medium",
    pattern: /\bnmap\s+-[sS]/i,
  },

  // ── OBFUSCATION ───────────────────────────────────────────────────────────
  {
    name: "obfuscation-base64-exec",
    category: "obfuscation",
    severity: "critical",
    pattern: /base64\s+(-d|--decode)\s*\|?\s*(bash|sh|python|perl)/i,
  },
  {
    name: "obfuscation-eval-base64",
    category: "obfuscation",
    severity: "critical",
    pattern: /\beval\b.*base64/i,
  },
  {
    name: "obfuscation-python-exec",
    category: "obfuscation",
    severity: "high",
    pattern: /\bpython\s+-c\s+['"](?:exec|eval|__import__)/i,
  },
  {
    name: "obfuscation-node-exec",
    category: "obfuscation",
    severity: "high",
    pattern: /\bnode\s+-e\s+['"](?:require|eval|process)/i,
  },
  {
    name: "obfuscation-perl-exec",
    category: "obfuscation",
    severity: "high",
    pattern: /\bperl\s+-e\b/i,
  },
  {
    name: "obfuscation-hex-decode",
    category: "obfuscation",
    severity: "high",
    pattern: /\\x[0-9a-f]{2}(?:\\x[0-9a-f]{2}){8,}/i,
  },
  {
    name: "obfuscation-fork-bomb",
    category: "obfuscation",
    severity: "critical",
    pattern: /:\s*\(\s*\)\s*\{.*:\s*\|.*:.*&.*\};/s,
  },
  { name: "obfuscation-ifs-split", category: "obfuscation", severity: "high", pattern: /\$IFS/ },
  {
    name: "obfuscation-invisible-unicode",
    category: "obfuscation",
    severity: "critical",
    pattern: /\u200B|\u200C|\u200D|\u2060|\uFEFF|\u202A|\u202B|\u202C|\u202D|\u202E/,
  },
  {
    name: "obfuscation-shell-c-exec",
    category: "obfuscation",
    severity: "high",
    pattern: /\bsh\s+-c\b/i,
  },
  {
    name: "obfuscation-bash-c-exec",
    category: "obfuscation",
    severity: "high",
    pattern: /\bbash\s+-c\b/i,
  },
  {
    name: "obfuscation-here-string-exec",
    category: "obfuscation",
    severity: "high",
    pattern: /\bbash\s+<<<\s*\$\(/i,
  },
  {
    name: "obfuscation-dollar-single-quote",
    category: "obfuscation",
    severity: "medium",
    pattern: /\$'\\\w{2,5}'/,
  },
  {
    name: "obfuscation-env-command",
    category: "obfuscation",
    severity: "medium",
    pattern: /\benv\b.*(?:secret|password|key|token)/i,
  },

  // ── SUPPLY CHAIN ──────────────────────────────────────────────────────────
  {
    name: "supply-chain-curl-install",
    category: "supply_chain",
    severity: "high",
    pattern: /\bcurl\b.*\|\s*(ba)?sh\s*$/i,
  },
  {
    name: "supply-chain-npm-preinstall",
    category: "supply_chain",
    severity: "high",
    pattern: /"(?:preinstall|prepare)"\s*:/i,
  },
  {
    name: "supply-chain-pip-editable-git",
    category: "supply_chain",
    severity: "medium",
    pattern: /\bpip\s+install\s+-e\s+git\+http/i,
  },
  {
    name: "supply-chain-git-clone-exec",
    category: "supply_chain",
    severity: "medium",
    pattern: /git\s+clone\b.*&&.*(?:sh|bash|python|make)\s/i,
  },
  {
    name: "supply-chain-pip-vcs",
    category: "supply_chain",
    severity: "medium",
    pattern: /\bpip\s+install\s+git\+https?:\/\/github/i,
  },
  {
    name: "supply-chain-registry-override",
    category: "supply_chain",
    severity: "high",
    pattern: /--registry\s+https?:\/\/(?!registry\.npmjs\.org)/i,
  },
  {
    name: "supply-chain-env-path-override",
    category: "supply_chain",
    severity: "medium",
    pattern: /\bexport\s+PATH\s*=\s*[^:]*\/tmp\//i,
  },
  {
    name: "supply-chain-unpinned-wildcard",
    category: "supply_chain",
    severity: "low",
    pattern: /"dependencies"\s*:\s*\{[^}]*"\*"\s*:/i,
  },
  {
    name: "supply-chain-typosquat",
    category: "supply_chain",
    severity: "high",
    pattern: /\bnpm\s+install\s+(?:rndom|reqeust|expres|lodsh)\b/i,
  },

  // ── PRIVILEGE ESCALATION ──────────────────────────────────────────────────
  {
    name: "privesc-sudo",
    category: "privilege_escalation",
    severity: "critical",
    pattern: /\bsudo\s+(?!apt|brew|yum|apk|pacman|dnf)\S/i,
  },
  {
    name: "privesc-su-root",
    category: "privilege_escalation",
    severity: "critical",
    pattern: /\bsu\s+-\s*(?:root\b|$)/i,
  },
  {
    name: "privesc-chmod-suid",
    category: "privilege_escalation",
    severity: "critical",
    pattern: /\bchmod\s+(?:[ugo]\+[ws]|[46][0-7]{2,3}|777|666)\b/i,
  },
  {
    name: "privesc-chown-root",
    category: "privilege_escalation",
    severity: "critical",
    pattern: /\bchown\s+root\b/i,
  },
  {
    name: "privesc-setuid",
    category: "privilege_escalation",
    severity: "critical",
    pattern: /\bsetuid\b|\bsetcap\s+cap_setuid/i,
  },
  {
    name: "privesc-systemctl-mask",
    category: "privilege_escalation",
    severity: "high",
    pattern: /\bsystemctl\s+(stop|disable|mask)\b/i,
  },

  // ── CREDENTIAL EXPOSURE ───────────────────────────────────────────────────
  {
    name: "cred-hardcoded-key",
    category: "credential_exposure",
    severity: "critical",
    pattern:
      /(?:api[_-]key|secret[_-]key|access[_-]token|private[_-]key)\s*[:=]\s*["'][a-zA-Z0-9+/=_-]{20,}/i,
  },
  {
    name: "cred-aws-key",
    category: "credential_exposure",
    severity: "critical",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: "cred-github-token",
    category: "credential_exposure",
    severity: "critical",
    pattern: /\bghp_[a-zA-Z0-9]{36}\b|\bgithub_pat_[a-zA-Z0-9_]{82}\b/,
  },
  {
    name: "cred-openai-key",
    category: "credential_exposure",
    severity: "critical",
    pattern: /\bsk-[a-zA-Z0-9]{20,}\b/,
  },
  {
    name: "cred-stripe-key",
    category: "credential_exposure",
    severity: "critical",
    pattern: /\bsk_(?:live|test)_[a-zA-Z0-9]{24,}\b/,
  },
  {
    name: "cred-jwt-token",
    category: "credential_exposure",
    severity: "high",
    pattern: /\beyJ[A-Za-z0-9+/]{20,}={0,2}\.[A-Za-z0-9+/]{20,}/,
  },
  {
    name: "cred-basic-auth-url",
    category: "credential_exposure",
    severity: "high",
    pattern: /https?:\/\/[^@\s]{3,}:[^@\s]{3,}@/i,
  },
];

// Invisible/directional unicode characters used for steganographic prompt injection.
// Covers: zero-width space/non-joiner/joiner, word joiner, BOM, paragraph separators,
// LTR/RTL marks, and directional override/isolate/pop characters (U+202A–202E).
// Uses alternation (not character class) to avoid no-misleading-character-class lint rule.
const INVISIBLE_UNICODE_RE =
  /\u200B|\u200C|\u200D|\u2060|\uFEFF|\u2028|\u2029|\u200E|\u200F|\u202A|\u202B|\u202C|\u202D|\u202E/;

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

type ThreatFinding = {
  name: string;
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  match: string;
};

function scanContent(content: string): ThreatFinding[] {
  const findings: ThreatFinding[] = [];

  // Check for invisible/directional unicode steganographic injection
  if (INVISIBLE_UNICODE_RE.test(content)) {
    findings.push({
      name: "invisible-unicode-injection",
      category: "prompt_injection",
      severity: "critical",
      match: "invisible or directional unicode characters detected (U+200B–202E range)",
    });
  }

  for (const { name, category, severity, pattern } of THREAT_PATTERNS) {
    const m = content.match(pattern);
    if (m) {
      findings.push({ name, category, severity, match: m[0].slice(0, 120) });
    }
  }
  // Sort by severity (critical first)
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  return findings.toSorted((a, b) => order[a.severity] - order[b.severity]);
}

export default definePluginEntry({
  id: "skill-security-scan",
  name: "Skill Security Scan",
  description:
    "Scans skill file writes for 79+ threat patterns across 9 categories (prompt injection, exfiltration, destructive, persistence, network, obfuscation, supply chain, privilege escalation, credential exposure), plus invisible/directional unicode steganographic injection detection. Ported from hermes-agent/tools/skills_guard.py.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as SkillSecurityConfig;
    if (cfg.enabled === false) {
      return;
    }

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
      const filePathVal = params["path"] ?? params["file_path"] ?? params["filename"] ?? "";
      const filePath = typeof filePathVal === "string" ? filePathVal : JSON.stringify(filePathVal);
      if (!filePath || !isSkillPath(filePath, scanPaths)) {
        return undefined;
      }

      // Content to scan: new_content, content, file_text, new_str
      const contentVal =
        params["new_content"] ??
        params["content"] ??
        params["file_text"] ??
        params["new_str"] ??
        "";
      const content = typeof contentVal === "string" ? contentVal : JSON.stringify(contentVal);
      if (!content) {
        return undefined;
      }

      const findings = scanContent(content);
      if (findings.length === 0) {
        return undefined;
      }

      const hasCritical = findings.some((f) => f.severity === "critical");
      const summary = findings.map((f) => `[${f.severity}] ${f.name}: "${f.match}"`).join("; ");
      api.logger.warn?.(
        `skill-security-scan: ${hasCritical ? "CRITICAL" : "HIGH"} threat in skill file "${filePath}": ${summary}`,
      );

      // Auto-block if blockOnThreat is explicitly enabled, OR if any critical finding
      if (cfg.blockOnThreat === true || (hasCritical && cfg.blockOnThreat !== false)) {
        return {
          block: true,
          blockReason: `Skill Security Guard blocked write to \`${filePath}\` — ${findings.length} threat(s) detected:\n\n${findings
            .slice(0, 8)
            .map(
              (f) =>
                `• [${f.severity.toUpperCase()}] **${f.name}** (${f.category}): \`${f.match}\``,
            )
            .join("\n")}\n\nReview the content and remove malicious patterns before proceeding.`,
        };
      }

      // Non-critical: require approval
      return {
        requireApproval: {
          title: `Skill Security Warning (${findings.length} pattern${findings.length > 1 ? "s" : ""})`,
          description: `Writing to skill file \`${filePath}\` — detected suspicious patterns:\n\n${findings
            .slice(0, 10)
            .map((f) => `- **[${f.severity}] ${f.name}** (${f.category}): \`${f.match}\``)
            .join("\n")}\n\nProceed?`,
          severity: hasCritical ? ("critical" as const) : ("warning" as const),
          timeoutMs: 60_000,
          timeoutBehavior: "deny" as const,
        },
      };
    });
  },
});
