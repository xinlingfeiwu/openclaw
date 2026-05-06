import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expandHomePrefix } from "openclaw/plugin-sdk/infra-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// USD per 1M tokens — rough defaults; overridable per provider in config
const DEFAULT_PRICE_PER_M: Record<string, { input: number; output: number; cacheRead: number }> = {
  "github-copilot/gpt-5.4": { input: 2.5, output: 10.0, cacheRead: 1.25 },
  "github-copilot/gpt-4.1": { input: 0.4, output: 1.6, cacheRead: 0.2 },
  "deepseek/deepseek-chat": { input: 0.27, output: 1.1, cacheRead: 0.027 },
  "anthropic/claude-sonnet-4-5": { input: 3.0, output: 15.0, cacheRead: 0.3 },
  "ollama/*": { input: 0.0, output: 0.0, cacheRead: 0.0 },
};

type DailyEntry = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedUsd: number;
  calls: number;
  /** Number of real LLM API calls (≫ session count; 10-90x per session typically) */
  apiCallCount: number;
};

type UsageData = {
  // key: "YYYY-MM-DD/provider/model"
  entries: Record<string, DailyEntry>;
  lastUpdated: string;
};

type UsageTrackerConfig = {
  enabled?: boolean;
  usageFile?: string;
  /** Max total input tokens per day per provider before switching. 0 = no limit */
  dailyInputTokenLimit?: number;
  /** Provider to switch to when limit exceeded */
  fallbackProvider?: string;
  fallbackModel?: string;
  maxHistoryDays?: number;
  /** Custom pricing overrides: key is "provider/model", value is { input, output, cacheRead } USD per 1M tokens */
  pricing?: Record<string, { input: number; output: number; cacheRead?: number }>;
};

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function entryKey(date: string, provider: string, model: string): string {
  return `${date}/${provider}/${model}`;
}

function loadUsage(file: string): UsageData {
  try {
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf-8")) as UsageData;
    }
  } catch {}
  return { entries: {}, lastUpdated: new Date().toISOString() };
}

function saveUsage(file: string, data: UsageData): void {
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    data.lastUpdated = new Date().toISOString();
    writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {}
}

function pruneOldEntries(data: UsageData, maxDays: number): UsageData {
  const cutoff = new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return {
    ...data,
    entries: Object.fromEntries(
      Object.entries(data.entries).filter(([k]) => k.slice(0, 10) >= cutoff),
    ),
  };
}

function estimateUsd(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  provider: string,
  model: string,
  customPricing: Record<string, { input: number; output: number; cacheRead?: number }>,
): number {
  const key = `${provider}/${model}`;
  const pricing =
    customPricing[key] ?? DEFAULT_PRICE_PER_M[key] ?? DEFAULT_PRICE_PER_M[`${provider}/*`] ?? null;
  if (!pricing) {
    return 0;
  }
  const cacheRate = (pricing.cacheRead ?? pricing.input * 0.1) / 1_000_000;
  return (
    (inputTokens * pricing.input) / 1_000_000 +
    (outputTokens * pricing.output) / 1_000_000 +
    cacheReadTokens * cacheRate
  );
}

export default definePluginEntry({
  id: "usage-tracker",
  name: "Usage Tracker",
  description:
    "Tracks daily token usage per provider/model and auto-switches to a fallback provider when a daily limit is exceeded.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as UsageTrackerConfig;
    if (cfg.enabled === false) {
      return;
    }

    const usageFile = expandHomePrefix(
      typeof cfg.usageFile === "string" && cfg.usageFile.trim()
        ? cfg.usageFile
        : "~/.openclaw/usage-tracker.json",
    );
    const dailyLimit =
      typeof cfg.dailyInputTokenLimit === "number" && cfg.dailyInputTokenLimit > 0
        ? cfg.dailyInputTokenLimit
        : 0;
    const fallbackProvider =
      typeof cfg.fallbackProvider === "string" && cfg.fallbackProvider.trim()
        ? cfg.fallbackProvider.trim()
        : undefined;
    const fallbackModel =
      typeof cfg.fallbackModel === "string" && cfg.fallbackModel.trim()
        ? cfg.fallbackModel.trim()
        : undefined;
    const maxDays =
      typeof cfg.maxHistoryDays === "number" && cfg.maxHistoryDays > 0 ? cfg.maxHistoryDays : 30;
    const customPricing =
      typeof cfg.pricing === "object" && cfg.pricing !== null
        ? (cfg.pricing as Record<string, { input: number; output: number; cacheRead?: number }>)
        : {};

    // Track whether we're in fallback mode for this gateway session
    let fallbackActive = false;
    // Track which date fallback was activated so we can reset it on a new day
    let fallbackActivatedDate: string | undefined;

    api.on("llm_output", (event, _ctx) => {
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
      const provider = ev.provider ?? "unknown";
      const model = ev.model ?? "unknown";
      const usage = ev.usage ?? {};

      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const cacheRead = usage.cacheRead ?? 0;
      const cacheWrite = usage.cacheWrite ?? 0;

      const today = todayKey();

      // Reset fallback on a new calendar day so daily limits are re-evaluated fresh
      if (fallbackActive && fallbackActivatedDate && fallbackActivatedDate !== today) {
        fallbackActive = false;
        fallbackActivatedDate = undefined;
        api.logger.info?.(`usage-tracker: new day ${today} — resetting fallback mode`);
      }

      const key = entryKey(today, provider, model);

      try {
        let data = loadUsage(usageFile);
        data = pruneOldEntries(data, maxDays);

        const existing = data.entries[key] ?? {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedUsd: 0,
          calls: 0,
          apiCallCount: 0,
        };

        existing.inputTokens += input;
        existing.outputTokens += output;
        existing.cacheReadTokens += cacheRead;
        existing.cacheWriteTokens += cacheWrite;
        existing.estimatedUsd += estimateUsd(
          input,
          output,
          cacheRead,
          provider,
          model,
          customPricing,
        );
        existing.calls += 1;
        existing.apiCallCount = (existing.apiCallCount ?? 0) + 1;

        data.entries[key] = existing;
        saveUsage(usageFile, data);

        api.logger.info?.(
          `usage-tracker: ${provider}/${model} today: in=${existing.inputTokens} out=${existing.outputTokens} ` +
            `cacheR=${existing.cacheReadTokens} apiCalls=${existing.apiCallCount} ~$${existing.estimatedUsd.toFixed(4)}`,
        );

        // Check if we should activate fallback
        if (dailyLimit > 0 && !fallbackActive && existing.inputTokens > dailyLimit) {
          if (fallbackProvider) {
            fallbackActive = true;
            fallbackActivatedDate = today;
            api.logger.warn?.(
              `usage-tracker: daily input token limit ${dailyLimit} exceeded for ${provider}/${model} ` +
                `(used: ${existing.inputTokens}). Switching to fallback: ${fallbackProvider}`,
            );
          }
        }
      } catch (e) {
        api.logger.warn?.(`usage-tracker: failed to record usage: ${String(e)}`);
      }
    });

    if (dailyLimit > 0 && fallbackProvider) {
      api.on("before_model_resolve", (_event, _ctx) => {
        if (!fallbackActive) {
          return undefined;
        }
        return {
          providerOverride: fallbackProvider,
          ...(fallbackModel ? { modelOverride: fallbackModel } : {}),
        };
      });
    }
  },
});
