import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// Patterns that suggest prompt injection attempts
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

function detectInjection(prompt: string): string | null {
  for (const pat of INJECTION_PATTERNS) {
    if (pat.test(prompt)) {
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
        result.prependSystemContext = `${soul}\n`;
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
