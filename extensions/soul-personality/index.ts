import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// Invisible Unicode characters used in prompt injection — matches hermes _CONTEXT_INVISIBLE_CHARS
// Uses alternation to avoid lint rule for combining chars in character class
const INVISIBLE_UNICODE_REGEX =
  /\u200B|\u200C|\u200D|\u2060|\uFEFF|\u202A|\u202B|\u202C|\u202D|\u202E/;

// Patterns that suggest prompt injection attempts in user input or context files
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /forget\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /you\s+are\s+now\s+(a\s+)?(?!openclaw)/i,
  /act\s+as\s+(?!an?\s+agent|assistant)/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /\[SYSTEM\]\s*:/i,
  /<\s*system\s*>/i,
  /override\s+(your\s+)?(instructions?|behavior|personality)/i,
  /jailbreak/i,
  /DAN\s*(mode)?:/i,
  // HTML/XML injection patterns
  /<!--.*?(execute|inject|run|eval).*?-->/is,
  /<div[^>]+style\s*=\s*["']display\s*:\s*none/i,
  /translate\s*=\s*["']no["'].*execute/i,
  // Exfiltration patterns
  /send\s+(all\s+)?(memory|context|secrets?)\s+to/i,
  /exfil(trate)?/i,
];

type SoulConfig = {
  enabled?: boolean;
  soulFile?: string;
  enableInjectionScan?: boolean;
};

function loadSoulFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch {
    return null;
  }
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function detectInjection(text: string): string | null {
  // Check invisible Unicode first (zero-width joiners, BOM, RTL overrides)
  if (INVISIBLE_UNICODE_REGEX.test(text)) {
    return "invisible-unicode";
  }
  for (const pat of INJECTION_PATTERNS) {
    if (pat.test(text)) {
      return pat.source;
    }
  }
  return null;
}

export default definePluginEntry({
  id: "soul-personality",
  name: "SOUL Personality",
  description:
    "Injects SOUL.md personality into system prompt and scans for prompt injection attacks.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as SoulConfig;
    if (cfg.enabled === false) {
      return;
    }

    const soulPath = expandHome(
      typeof cfg.soulFile === "string" && cfg.soulFile.trim()
        ? cfg.soulFile
        : "~/.openclaw/SOUL.md",
    );

    const enableInjectionScan = cfg.enableInjectionScan !== false;

    api.on("before_prompt_build", (event, _ctx) => {
      const result: {
        prependSystemContext?: string;
      } = {};

      // Load SOUL file on each build (allows live edits without gateway restart)
      const soul = loadSoulFile(soulPath);
      if (soul) {
        // Scan SOUL.md content for injection before trusting it
        if (enableInjectionScan) {
          const soulInjection = detectInjection(soul);
          if (soulInjection) {
            api.logger.warn?.(
              `soul-personality: potential injection in SOUL.md (pattern: ${soulInjection}) — file blocked`,
            );
            // Don't inject compromised SOUL content
          } else {
            result.prependSystemContext = `${soul}\n`;
          }
        } else {
          result.prependSystemContext = `${soul}\n`;
        }
      }

      // Injection scan on incoming user prompt
      if (enableInjectionScan) {
        const prompt = (event as { prompt?: string }).prompt ?? "";
        const detected = detectInjection(prompt);
        if (detected) {
          api.logger.warn?.(
            `soul-personality: potential prompt injection detected (pattern: ${detected})`,
          );
        }
      }

      return Object.keys(result).length > 0 ? result : undefined;
    });
  },
});
