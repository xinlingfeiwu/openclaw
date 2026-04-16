import { describe, it, expect, beforeEach, vi } from "vitest";

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

describe("prompt-cache-anchor", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("appends default anchor to appendSystemContext", async () => {
    const { default: plugin } = await import("./index.js");
    const api = buildApi({});
    plugin.register(api as never);

    const result = await api._trigger("before_prompt_build", {}, {});
    expect((result as { appendSystemContext: string }).appendSystemContext).toBe(
      "<!-- openclaw:system-context-boundary -->",
    );
  });

  it("uses custom anchor from config", async () => {
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ anchor: "## END_SYSTEM_PROMPT" });
    plugin.register(api as never);

    const result = await api._trigger("before_prompt_build", {}, {});
    expect((result as { appendSystemContext: string }).appendSystemContext).toBe(
      "## END_SYSTEM_PROMPT",
    );
  });

  it("returns same anchor on every call (stable for caching)", async () => {
    const { default: plugin } = await import("./index.js");
    const api = buildApi({});
    plugin.register(api as never);

    const r1 = await api._trigger("before_prompt_build", {}, {});
    const r2 = await api._trigger("before_prompt_build", {}, {});
    expect((r1 as { appendSystemContext: string }).appendSystemContext).toBe(
      (r2 as { appendSystemContext: string }).appendSystemContext,
    );
  });

  it("disabled by config — no handler registered", async () => {
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ enabled: false });
    plugin.register(api as never);

    const result = await api._trigger("before_prompt_build", {}, {});
    expect(result).toBeUndefined();
  });
});
