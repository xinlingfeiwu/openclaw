import { describe, expect, it, vi } from "vitest";

function makeFakeApi(pluginConfig?: Record<string, unknown>) {
  const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  return {
    pluginConfig: pluginConfig ?? {},
    logger: { info: vi.fn(), warn: vi.fn() },
    on(hookName: string, handler: (...args: unknown[]) => unknown) {
      handlers[hookName] ??= [];
      handlers[hookName].push(handler);
    },
    _trigger(hookName: string, event: unknown, ctx: unknown) {
      const list = handlers[hookName] ?? [];
      return Promise.all(list.map((h) => h(event, ctx)));
    },
  };
}

async function loadPlugin(config?: Record<string, unknown>) {
  vi.resetModules();
  const mod = await import("./index.js");
  const api = makeFakeApi(config);
  mod.default.register(api as never);
  return api;
}

describe("context-fence plugin", () => {
  it("injects appendSystemContext with fence guide", async () => {
    const api = await loadPlugin();
    const result = await api._trigger("before_prompt_build", { prompt: "hi", messages: [] }, {});
    expect(result[0]).toMatchObject({
      appendSystemContext: expect.stringContaining("Context Marker Guide"),
    });
  });

  it("does nothing when enabled=false", async () => {
    const api = await loadPlugin({ enabled: false });
    const result = await api._trigger("before_prompt_build", { prompt: "hi", messages: [] }, {});
    expect(result).toHaveLength(0);
  });

  it("includes all marker types in guide", async () => {
    const api = await loadPlugin();
    const result = (await api._trigger(
      "before_prompt_build",
      { prompt: "hi", messages: [] },
      {},
    )) as [{ appendSystemContext?: string }];
    expect(result[0]?.appendSystemContext).toContain("memory-context");
    expect(result[0]?.appendSystemContext).toContain("CONTEXT COMPACTION");
    expect(result[0]?.appendSystemContext).toContain("skill_auto_create");
  });
});
