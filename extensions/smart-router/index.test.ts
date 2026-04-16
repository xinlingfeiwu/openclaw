import { describe, expect, it, vi } from "vitest";

function makeFakeApi(pluginConfig?: Record<string, unknown>) {
  const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  return {
    pluginConfig: pluginConfig ?? {},
    logger: { info: vi.fn(), warn: vi.fn() },
    config: {},
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
  void mod.default.register(api as never);
  return api;
}

describe("smart-router plugin", () => {
  it("warns and does nothing if fastModel is not set", async () => {
    const api = await loadPlugin({ enabled: true });
    const result = await api._trigger("before_model_resolve", { prompt: "hi" }, {});
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("fastModel not configured"),
    );
    expect(result).toHaveLength(0);
  });

  it("routes simple greeting to fast model", async () => {
    const api = await loadPlugin({ fastModel: "gpt-5.4-mini", fastProvider: "github-copilot" });
    const result = await api._trigger("before_model_resolve", { prompt: "hi" }, {});
    expect(result[0]).toMatchObject({
      modelOverride: "gpt-5.4-mini",
      providerOverride: "github-copilot",
    });
  });

  it("routes complex code request to primary (undefined)", async () => {
    const api = await loadPlugin({ fastModel: "gpt-5.4-mini" });
    const result = await api._trigger(
      "before_model_resolve",
      { prompt: "Please implement a binary search tree in TypeScript with full unit tests" },
      {},
    );
    expect(result[0]).toBeUndefined();
  });

  it("routes long prompts to primary model", async () => {
    const api = await loadPlugin({ fastModel: "gpt-5.4-mini", maxPromptLengthForFast: 50 });
    const longPrompt = "hi ".repeat(30); // 90 chars
    const result = await api._trigger("before_model_resolve", { prompt: longPrompt }, {});
    expect(result[0]).toBeUndefined();
  });

  it("complex pattern overrides simple pattern", async () => {
    const api = await loadPlugin({ fastModel: "gpt-5.4-mini" });
    // Contains code block → complex even if short
    const result = await api._trigger(
      "before_model_resolve",
      { prompt: "analyze ```const x = 1```" },
      {},
    );
    expect(result[0]).toBeUndefined();
  });

  it("does nothing when enabled=false", async () => {
    const api = await loadPlugin({ enabled: false, fastModel: "gpt-5.4-mini" });
    const result = await api._trigger("before_model_resolve", { prompt: "hi" }, {});
    expect(result).toHaveLength(0);
  });

  it("supports custom simplePatterns", async () => {
    const api = await loadPlugin({
      fastModel: "gpt-5.4-mini",
      simplePatterns: ["^ping$"],
    });
    const match = await api._trigger("before_model_resolve", { prompt: "ping" }, {});
    expect(match[0]).toMatchObject({ modelOverride: "gpt-5.4-mini" });
    const noMatch = await api._trigger("before_model_resolve", { prompt: "pong" }, {});
    expect(noMatch[0]).toBeUndefined();
  });
});
