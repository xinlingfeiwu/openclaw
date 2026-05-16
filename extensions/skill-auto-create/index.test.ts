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
  mod.default.register(api as never);
  return api;
}

describe("skill-auto-create plugin", () => {
  it("does not inject before threshold", async () => {
    const api = await loadPlugin({ toolCallThreshold: 5 });
    // 3 interesting tool calls
    for (let i = 0; i < 3; i++) {
      await api._trigger(
        "after_tool_call",
        { toolName: "bash" },
        { sessionId: "s1", toolName: "bash" },
      );
    }
    const result = await api._trigger(
      "before_prompt_build",
      { prompt: "hello", messages: [] },
      { conversationId: "s1" },
    );
    expect(result[0]).toBeUndefined();
  });

  it("injects skill creation prompt after threshold", async () => {
    const api = await loadPlugin({ toolCallThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      await api._trigger(
        "after_tool_call",
        { toolName: "bash" },
        { sessionId: "s2", toolName: "bash" },
      );
    }
    const result = await api._trigger(
      "before_prompt_build",
      { prompt: "hello", messages: [] },
      { conversationId: "s2" },
    );
    expect(result[0]).toMatchObject({
      prependContext: expect.stringContaining("skill_review"),
    });
  });

  it("ignores non-interesting tools", async () => {
    const api = await loadPlugin({ toolCallThreshold: 3 });
    for (let i = 0; i < 5; i++) {
      await api._trigger(
        "after_tool_call",
        { toolName: "memory_search" },
        { sessionId: "s3", toolName: "memory_search" },
      );
    }
    const result = await api._trigger(
      "before_prompt_build",
      { prompt: "hello", messages: [] },
      { conversationId: "s3" },
    );
    expect(result[0]).toBeUndefined();
  });

  it("respects maxPerSession=1 (default)", async () => {
    const api = await loadPlugin({ toolCallThreshold: 2, maxPerSession: 1 });
    for (let i = 0; i < 2; i++) {
      await api._trigger(
        "after_tool_call",
        { toolName: "bash" },
        { sessionId: "s4", toolName: "bash" },
      );
    }
    const first = await api._trigger(
      "before_prompt_build",
      { prompt: "a", messages: [] },
      { conversationId: "s4" },
    );
    const second = await api._trigger(
      "before_prompt_build",
      { prompt: "b", messages: [] },
      { conversationId: "s4" },
    );
    expect(first[0]).toMatchObject({ prependContext: expect.any(String) });
    expect(second[0]).toBeUndefined();
  });

  it("does nothing when enabled=false", async () => {
    const api = await loadPlugin({ enabled: false });
    for (let i = 0; i < 10; i++) {
      await api._trigger(
        "after_tool_call",
        { toolName: "bash" },
        { sessionId: "s5", toolName: "bash" },
      );
    }
    const result = await api._trigger(
      "before_prompt_build",
      { prompt: "hello", messages: [] },
      { conversationId: "s5" },
    );
    expect(result).toHaveLength(0);
  });

  it("supports custom interestingTools list", async () => {
    const api = await loadPlugin({ toolCallThreshold: 2, interestingTools: ["my_custom_tool"] });
    await api._trigger(
      "after_tool_call",
      { toolName: "bash" },
      { sessionId: "s6", toolName: "bash" },
    ); // not interesting
    await api._trigger(
      "after_tool_call",
      { toolName: "my_custom_tool" },
      { sessionId: "s6", toolName: "my_custom_tool" },
    );
    await api._trigger(
      "after_tool_call",
      { toolName: "my_custom_tool" },
      { sessionId: "s6", toolName: "my_custom_tool" },
    );
    const result = await api._trigger(
      "before_prompt_build",
      { prompt: "hello", messages: [] },
      { conversationId: "s6" },
    );
    expect(result[0]).toMatchObject({
      prependContext: expect.stringContaining("skill_review"),
    });
  });
});
