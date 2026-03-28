import type { FailoverReason } from "./pi-embedded-helpers.js";

export function shouldAllowCooldownProbeForReason(
  reason: FailoverReason | null | undefined,
): boolean {
  return (
    reason === "rate_limit" ||
    reason === "overloaded" ||
    reason === "billing" ||
    // Network timeouts are transient: proxy/network can recover without any config change.
    reason === "timeout" ||
    reason === "unknown"
  );
}

export function shouldUseTransientCooldownProbeSlot(
  reason: FailoverReason | null | undefined,
): boolean {
  // Network timeouts are transient: after proxy/network recovery the primary model
  // should be re-probed automatically rather than staying on the fallback permanently.
  return reason === "rate_limit" || reason === "overloaded" || reason === "timeout" || reason === "unknown";
}

export function shouldPreserveTransientCooldownProbeSlot(
  reason: FailoverReason | null | undefined,
): boolean {
  return (
    reason === "model_not_found" ||
    reason === "format" ||
    reason === "auth" ||
    reason === "auth_permanent" ||
    reason === "session_expired"
  );
}
