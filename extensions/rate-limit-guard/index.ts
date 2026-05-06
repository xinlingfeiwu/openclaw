import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

const DEFAULT_COOLDOWN_MS = 300_000; // 5 minutes, same as hermes nous_rate_guard.py default

// Patterns that indicate a 429 / rate-limit response (case-insensitive)
const RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /rate[_\s-]?limit/i,
  /too many requests/i,
  /quota exceeded/i,
  /throttl/i,
  /capacity exceeded/i,
  /retry after/i,
  /request limit/i,
  /overloaded/i,
];

type RateLimitState = {
  provider: string;
  resetAtMs: number;
  detectedAtMs: number;
  source: "tool" | "llm";
};

type RateLimitGuardConfig = {
  enabled?: boolean;
  cooldownMs?: number;
  rateLimitsDir?: string;
};

function isRateLimitError(msg: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(msg));
}

function defaultDir(): string {
  return join(homedir(), ".openclaw", "rate_limits");
}

function stateFile(dir: string, provider: string): string {
  const safe = provider.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
  return join(dir, `${safe}.json`);
}

/**
 * Atomic write: write to tmp then rename, just like hermes nous_rate_guard.py.
 * Prevents partial reads from concurrent processes.
 */
function atomicWrite(path: string, state: RateLimitState): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}

function readState(path: string): RateLimitState | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as RateLimitState;
  } catch {
    return null;
  }
}

export default definePluginEntry({
  id: "rate-limit-guard",
  name: "Rate Limit Guard",
  description:
    "Cross-session 429 rate-limit state tracking. Detects rate limit errors, writes atomic cooldown state, injects system-prompt warning while cooling down. Ported from hermes-agent/agent/nous_rate_guard.py.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as RateLimitGuardConfig;
    if (cfg.enabled === false) {
      return;
    }

    const cooldownMs =
      typeof cfg.cooldownMs === "number" && cfg.cooldownMs > 0
        ? cfg.cooldownMs
        : DEFAULT_COOLDOWN_MS;

    const rawDir = typeof cfg.rateLimitsDir === "string" ? cfg.rateLimitsDir : defaultDir();
    // Reject traversal: rateLimitsDir must be inside home directory
    const expandedDir = rawDir.startsWith("~/") ? join(homedir(), rawDir.slice(2)) : rawDir;
    const resolvedDir = resolve(expandedDir);
    const rateLimitsDir =
      resolvedDir.startsWith(homedir() + "/") || resolvedDir === homedir()
        ? resolvedDir
        : defaultDir();

    // Detect tool-level 429s (web search APIs, etc.)
    api.on("after_tool_call", (event, ctx) => {
      const err = (event as { error?: string }).error;
      if (!err || !isRateLimitError(err)) {
        return;
      }

      const provider = ctx.agentId ?? "unknown";
      const now = Date.now();
      const state: RateLimitState = {
        provider,
        resetAtMs: now + cooldownMs,
        detectedAtMs: now,
        source: "tool",
      };
      const filePath = stateFile(rateLimitsDir, provider);
      try {
        atomicWrite(filePath, state);
        api.logger.info?.(
          `rate-limit-guard: tool-level 429 detected for provider=${provider}, cooldown until ${new Date(state.resetAtMs).toISOString()}`,
        );
      } catch (e) {
        api.logger.error?.(`rate-limit-guard: failed to write state for ${provider}: ${String(e)}`);
      }
    });

    // Detect LLM-level 429s via agent_end with failure
    api.on("agent_end", (event, ctx) => {
      const ev = event as { success?: boolean; error?: string };
      if (ev.success !== false) {
        return;
      }
      const err = ev.error ?? "";
      if (!isRateLimitError(err)) {
        return;
      }

      const provider = ctx.agentId ?? "unknown";
      const now = Date.now();
      const state: RateLimitState = {
        provider,
        resetAtMs: now + cooldownMs,
        detectedAtMs: now,
        source: "llm",
      };
      const filePath = stateFile(rateLimitsDir, provider);
      try {
        atomicWrite(filePath, state);
        api.logger.info?.(
          `rate-limit-guard: LLM-level 429 detected for provider=${provider}, cooldown until ${new Date(state.resetAtMs).toISOString()}`,
        );
      } catch (e) {
        api.logger.error?.(`rate-limit-guard: failed to write state for ${provider}: ${String(e)}`);
      }
    });

    // Inject warning into system prompt if any provider is in cooldown
    api.on("before_prompt_build", (_event, _ctx) => {
      try {
        if (!existsSync(rateLimitsDir)) {
          return undefined;
        }
        const files = readdirSync(rateLimitsDir).filter((f) => f.endsWith(".json"));
        const now = Date.now();
        const active: RateLimitState[] = [];
        for (const file of files) {
          const state = readState(join(rateLimitsDir, file));
          if (state && state.resetAtMs > now) {
            active.push(state);
          }
        }
        if (active.length === 0) {
          return undefined;
        }

        const lines = active.map((s) => {
          const secsLeft = Math.ceil((s.resetAtMs - now) / 1000);
          // Sanitize provider name from disk before injecting into system prompt
          const displayProvider = (s.provider ?? "unknown")
            .replace(/[\n\r<>&"']/g, "_")
            .slice(0, 80);
          return `  - ${displayProvider}: rate-limited (${secsLeft}s remaining, source: ${s.source})`;
        });
        const warning =
          `\n\n[Rate Limit Guard] The following providers are currently rate-limited:\n` +
          lines.join("\n") +
          `\nAvoid calling tools or making requests to these providers until their cooldown expires.`;
        return { appendSystemContext: warning };
      } catch {
        // Don't break if filesystem scan fails
        return undefined;
      }
    });
  },
});
