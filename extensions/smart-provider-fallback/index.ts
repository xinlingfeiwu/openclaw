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
  /** Seconds to stay in fallback before probing primary again. Default: 300 */
  recoveryIntervalSeconds?: number;
};

// Error categories ported from hermes error taxonomy (errors.py).
type ErrorCategory =
  | "auth" // 401 invalid key — check credentials
  | "auth_permanent" // account disabled/suspended — provider-level block
  | "billing" // 402 payment required — rotate provider
  | "rate_limit" // 429 too many requests — temporary, use fallback
  | "overloaded" // 503 service overloaded — temporary, use fallback
  | "timeout" // request timeout — retryable, use fallback
  | "context_overflow" // context window exceeded — need compaction, not fallback
  | "payload_too_large" // 413 payload too large — need compression
  | "thinking_sig" // Claude thinking signature mismatch — retryable
  | "model_not_found" // 404 / invalid model — fallback to different model/provider
  | "server_error" // 500/502 server error — temporary, use fallback
  | "unknown"; // unclassified — default to fallback

type ErrorClassification = {
  category: ErrorCategory;
  shouldFallback: boolean;
};

function classifyError(errorMsg: string): ErrorClassification {
  const msg = errorMsg.toLowerCase();
  if (/disabled|suspended|banned|terminated|deactivated/.test(msg)) {
    return { category: "auth_permanent", shouldFallback: false };
  }
  if (
    /invalid.*api.*key|api.*key.*invalid|authentication.*failed|unauthorized|invalid.*token/.test(
      msg,
    )
  ) {
    return { category: "auth", shouldFallback: false };
  }
  if (/payment.*required|billing|quota.*exceeded|insufficient.*credits|402/.test(msg)) {
    return { category: "billing", shouldFallback: true };
  }
  if (/rate.*limit|too.*many.*requests|throttle|429/.test(msg)) {
    return { category: "rate_limit", shouldFallback: true };
  }
  if (/overload|service.*unavailable|capacity|503/.test(msg)) {
    return { category: "overloaded", shouldFallback: true };
  }
  if (/context.*length|maximum.*context|token.*limit|too.*long|context.*window/.test(msg)) {
    return { category: "context_overflow", shouldFallback: false };
  }
  if (/payload.*too.*large|request.*too.*large|413/.test(msg)) {
    return { category: "payload_too_large", shouldFallback: false };
  }
  if (/thinking.*signature|signature.*mismatch/.test(msg)) {
    return { category: "thinking_sig", shouldFallback: false };
  }
  if (
    /model not found|invalid model|model_not_found|not a valid model|does not exist|no such model|unknown model|unsupported model/.test(
      msg,
    )
  ) {
    return { category: "model_not_found", shouldFallback: true };
  }
  if (/internal server error|bad gateway|server error|upstream error|\b500\b|\b502\b/.test(msg)) {
    return { category: "server_error", shouldFallback: true };
  }
  if (/timeout|timed.*out/.test(msg)) {
    return { category: "timeout", shouldFallback: true };
  }
  return { category: "unknown", shouldFallback: true };
}

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
    let fallbackActivatedAt: number | undefined;
    let currentPrimary: string | undefined;

    // How long to stay in fallback before attempting primary recovery (ms).
    // After this window, one request is allowed through to the primary; if it
    // succeeds consecutively (recoveryCount times) fallback deactivates.
    const recoveryIntervalMs =
      typeof cfg.recoveryIntervalSeconds === "number" && cfg.recoveryIntervalSeconds > 0
        ? cfg.recoveryIntervalSeconds * 1000
        : 5 * 60 * 1000; // 5 minutes default

    api.on("llm_output", (event, _ctx) => {
      const ev = event as {
        provider?: string;
        model?: string;
        usage?: unknown;
        error?: string;
      };
      const provider = ev.provider ?? "unknown";
      const errorMsg = ev.error ?? "";
      const isError = Boolean(errorMsg);

      // Classify the error to decide whether this failure should count against the provider.
      // auth/auth_permanent/context_overflow/payload_too_large errors are not provider health
      // issues — don't activate fallback for them.
      let classification: ErrorClassification | undefined;
      if (isError) {
        classification = classifyError(errorMsg);
        if (!classification.shouldFallback) {
          api.logger.info?.(
            `smart-provider-fallback: ${provider} error classified as "${classification.category}" — ` +
              `not counting against health ring (fallback not appropriate)`,
          );
          return;
        }
      }

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
        fallbackActivatedAt = Date.now();
        const cat = classification?.category ?? "unknown";
        api.logger.warn?.(
          `smart-provider-fallback: ${provider} failure rate ${(rate * 100).toFixed(0)}% > threshold ` +
            `${(failThreshold * 100).toFixed(0)}% (last error: ${cat}). Activating fallback: ${fallbackProvider}`,
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
      // Time-based recovery: after recoveryIntervalMs, let one request through to the
      // primary. If it succeeds consecutively (recoveryCount times), fallback deactivates.
      if (
        fallbackActivatedAt !== undefined &&
        Date.now() - fallbackActivatedAt >= recoveryIntervalMs
      ) {
        api.logger.info?.(
          `smart-provider-fallback: recovery window elapsed (${recoveryIntervalMs / 1000}s). ` +
            `Probing primary ${currentPrimary} — fallback will reactivate if it fails again.`,
        );
        fallbackActive = false;
        fallbackActivatedAt = undefined;
        const h = currentPrimary ? health.get(currentPrimary) : undefined;
        if (h) {
          h.consecutiveSuccessesInFallback = 0;
        }
        return undefined;
      }
      return {
        providerOverride: fallbackProvider,
        ...(fallbackModel ? { modelOverride: fallbackModel } : {}),
      };
    });
  },
});
