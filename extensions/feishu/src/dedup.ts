// Prevent duplicate processing when WebSocket reconnects or Feishu redelivers messages.
// Each account maintains its own dedup state so multiple bot accounts in the same group
// can each independently check and respond to messages they are @mentioned in.
const DEDUP_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEDUP_MAX_SIZE = 1_000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // cleanup every 5 minutes

// Per-account dedup: accountId -> (messageId -> timestamp)
const accountMessageIds = new Map<string, Map<string, number>>();
const accountLastCleanup = new Map<string, number>();

function getAccountMap(accountId: string): Map<string, number> {
  let map = accountMessageIds.get(accountId);
  if (!map) {
    map = new Map<string, number>();
    accountMessageIds.set(accountId, map);
  }
  return map;
}

export function tryRecordMessage(accountId: string, messageId: string): boolean {
  const now = Date.now();
  const processedMessageIds = getAccountMap(accountId);
  const lastCleanupTime = accountLastCleanup.get(accountId) ?? 0;

  // Throttled cleanup: evict expired entries at most once per interval.
  if (now - lastCleanupTime > DEDUP_CLEANUP_INTERVAL_MS) {
    for (const [id, ts] of processedMessageIds) {
      if (now - ts > DEDUP_TTL_MS) {
        processedMessageIds.delete(id);
      }
    }
    accountLastCleanup.set(accountId, now);
  }

  if (processedMessageIds.has(messageId)) {
    return false;
  }

  // Evict oldest entries if cache is full.
  if (processedMessageIds.size >= DEDUP_MAX_SIZE) {
    const first = processedMessageIds.keys().next().value!;
    processedMessageIds.delete(first);
  }

  processedMessageIds.set(messageId, now);
  return true;
}
