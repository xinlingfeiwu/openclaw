import { describe, it, expect, vi, beforeEach } from "vitest";

function buildApi(config: Record<string, unknown> = {}) {
  const handlers: Record<string, ((ev: unknown, ctx: unknown) => unknown)[]> = {};
  return {
    pluginConfig: config,
    on(name: string, fn: (ev: unknown, ctx: unknown) => unknown) {
      handlers[name] ??= [];
      handlers[name].push(fn);
    },
    async _trigger(name: string, ev: unknown, ctx: unknown) {
      let result: unknown;
      for (const fn of handlers[name] ?? []) {
        result = await fn(ev, ctx);
      }
      return result;
    },
  };
}

const ctx = (sessionId = "sess1") => ({ sessionId });

describe("smart-compaction", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("allows first compaction (no state yet)", async () => {
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ cooldownMs: 60_000, minMessagesSinceLastCompaction: 5 });
    plugin.register(api as never);

    const result = await api._trigger("before_compaction", { messageCount: 10 }, ctx("first-1"));
    expect(result).toBeUndefined();
  });

  it("skips compaction within cooldown window", async () => {
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ cooldownMs: 60_000, minMessagesSinceLastCompaction: 5 });
    plugin.register(api as never);

    await api._trigger("after_compaction", { messageCount: 10 }, ctx("sess-cd"));

    const result = await api._trigger("before_compaction", { messageCount: 12 }, ctx("sess-cd"));
    expect((result as { skip?: boolean })?.skip).toBe(true);
    expect((result as { skipReason?: string })?.skipReason).toMatch(/cooldown/);
  });

  it("skips compaction when too few new messages", async () => {
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ cooldownMs: 0, minMessagesSinceLastCompaction: 10 });
    plugin.register(api as never);

    await api._trigger("after_compaction", { messageCount: 100 }, ctx("sess-msg"));

    // Only 3 new messages since last compaction
    const result = await api._trigger(
      "before_compaction",
      { messageCount: 103 },
      ctx("sess-msg"),
    );
    expect((result as { skip?: boolean })?.skip).toBe(true);
    expect((result as { skipReason?: string })?.skipReason).toMatch(/too few/);
  });

  it("allows compaction after cooldown passes and enough new messages", async () => {
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ cooldownMs: 0, minMessagesSinceLastCompaction: 2 });
    plugin.register(api as never);

    await api._trigger("after_compaction", { messageCount: 50 }, ctx("sess-ok"));

    // 5 new messages > 2 threshold, cooldown 0
    const result = await api._trigger("before_compaction", { messageCount: 55 }, ctx("sess-ok"));
    expect(result).toBeUndefined();
  });

  it("disabled by config — no handlers registered", async () => {
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ enabled: false });
    plugin.register(api as never);

    const result = await api._trigger("before_compaction", { messageCount: 10 }, ctx());
    expect(result).toBeUndefined();
  });

  it("tracks separate sessions independently", async () => {
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ cooldownMs: 60_000, minMessagesSinceLastCompaction: 2 });
    plugin.register(api as never);

    // sess-A had a recent compaction
    await api._trigger("after_compaction", { messageCount: 10 }, ctx("sess-A"));

    // sess-B has no state → should not skip
    const resultB = await api._trigger("before_compaction", { messageCount: 5 }, ctx("sess-B"));
    expect(resultB).toBeUndefined();

    // sess-A is in cooldown → should skip
    const resultA = await api._trigger("before_compaction", { messageCount: 15 }, ctx("sess-A"));
    expect((resultA as { skip?: boolean })?.skip).toBe(true);
  });
});
