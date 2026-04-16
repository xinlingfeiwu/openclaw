import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

type SmartProviderFallbackConfig = {
  enabled?: boolean;
  /** Size of the rolling window for failure rate tracking. Default: 10 */
  ringBufferSize?: number;
  /** Failure rate threshold (0-1) above which fallback is activated. Default: 0.4 */
  failureRateThreshold?: number;
  /** Provider to switch to when primary fails too often */
  fallbackProvider?: string;
  fallbackModel?: string;
  /** How many consecutive successes before deactivating fallback. Default: 3 */
  recoverySuccessCount?: number;
};

type ProviderHealth = {
  // circular buffer of results: true=success, false=failure
  results: boolean[];
  head: number;
  count: number;
  consecutiveSuccessesInFallback: number;
};

function createHealth(size: number): ProviderHealth {
  return {
    results: Array.from({ length: size }, () => true),
    head: 0,
    count: 0,
    consecutiveSuccessesInFallback: 0,
  };
}

function recordResult(health: ProviderHealth, success: boolean, size: number): void {
  health.results[health.head % size] = success;
  health.head = (health.head + 1) % size;
  health.count = Math.min(health.count + 1, size);
}

function failureRate(health: ProviderHealth, size: number): number {
  if (health.count === 0) {
    return 0;
  }
  const failures = health.results.slice(0, Math.min(health.count, size)).filter((r) => !r).length;
  return failures / Math.min(health.count, size);
}

export default definePluginEntry({
  id: "smart-provider-fallback",
  name: "Smart Provider Fallback",
  description:
    "Monitors per-provider failure rates and automatically switches to a fallback provider when failures exceed a threshold.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as SmartProviderFallbackConfig;
    if (cfg.enabled === false) {
      return;
    }

    const ringSize =
      typeof cfg.ringBufferSize === "number" && cfg.ringBufferSize > 0 ? cfg.ringBufferSize : 10;
    const failThreshold =
      typeof cfg.failureRateThreshold === "number" &&
      cfg.failureRateThreshold > 0 &&
      cfg.failureRateThreshold <= 1
        ? cfg.failureRateThreshold
        : 0.4;
    const fallbackProvider =
      typeof cfg.fallbackProvider === "string" && cfg.fallbackProvider.trim()
        ? cfg.fallbackProvider.trim()
        : undefined;
    const fallbackModel =
      typeof cfg.fallbackModel === "string" && cfg.fallbackModel.trim()
        ? cfg.fallbackModel.trim()
        : undefined;
    const recoveryCount =
      typeof cfg.recoverySuccessCount === "number" && cfg.recoverySuccessCount > 0
        ? cfg.recoverySuccessCount
        : 3;

    if (!fallbackProvider) {
      api.logger.warn?.(
        "smart-provider-fallback: fallbackProvider not configured — fallback disabled.",
      );
      return;
    }

    // Per-provider health tracking (session-scoped, no persistence needed)
    const health = new Map<string, ProviderHealth>();
    let fallbackActive = false;
    let currentPrimary: string | undefined;

    api.on("llm_output", (event, _ctx) => {
      const ev = event as {
        provider?: string;
        model?: string;
        usage?: unknown;
        error?: string;
      };
      const provider = ev.provider ?? "unknown";
      const isError = Boolean(ev.error);

      if (!health.has(provider)) {
        health.set(provider, createHealth(ringSize));
      }
      const h = health.get(provider)!;
      recordResult(h, !isError, ringSize);

      if (!currentPrimary && !fallbackActive) {
        currentPrimary = provider;
      }

      const rate = failureRate(h, ringSize);

      if (!fallbackActive && provider === currentPrimary && rate > failThreshold) {
        fallbackActive = true;
        api.logger.warn?.(
          `smart-provider-fallback: ${provider} failure rate ${(rate * 100).toFixed(0)}% > threshold ` +
            `${(failThreshold * 100).toFixed(0)}%. Activating fallback: ${fallbackProvider}`,
        );
      }

      // Recovery check: if we're in fallback but primary is recovering
      if (fallbackActive && provider === currentPrimary && !isError) {
        h.consecutiveSuccessesInFallback++;
        if (h.consecutiveSuccessesInFallback >= recoveryCount) {
          fallbackActive = false;
          h.consecutiveSuccessesInFallback = 0;
          api.logger.info?.(
            `smart-provider-fallback: ${provider} recovered after ${recoveryCount} successes. Restoring primary.`,
          );
        }
      } else if (fallbackActive && provider === currentPrimary && isError) {
        h.consecutiveSuccessesInFallback = 0;
      }
    });

    api.on("before_model_resolve", (_event, _ctx) => {
      if (!fallbackActive) {
        return undefined;
      }
      return {
        providerOverride: fallbackProvider,
        ...(fallbackModel ? { modelOverride: fallbackModel } : {}),
      };
    });
  },
});
