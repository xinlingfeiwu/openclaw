import { describe, expect, it, vi } from "vitest";

// Minimal fake API for testing
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

function makeMessages(userCount: number) {
  const msgs: { role: string; content: string }[] = [];
  for (let i = 0; i < userCount; i++) {
    msgs.push({ role: "user", content: `msg ${i}` });
    msgs.push({ role: "assistant", content: `reply ${i}` });
  }
  return msgs;
}

async function loadPlugin(config?: Record<string, unknown>) {
  // Reset module to get fresh session state
  vi.resetModules();
  const mod = await import("./index.js");
  const entry = mod.default;
  const api = makeFakeApi(config);
  entry.register(api as never);
  return api;
}

describe("memory-nudge plugin", () => {
  it("returns undefined before interval is reached", async () => {
    const api = await loadPlugin({ interval: 5 });
    const ctx = { conversationId: "test-1", agentId: "main" };
    // 3 user messages — below interval of 5
    const result = await api._trigger(
      "before_prompt_build",
      { prompt: "hello", messages: makeMessages(3) },
      ctx,
    );
    expect(result[0]).toBeUndefined();
  });

  it("injects nudge at the interval boundary", async () => {
    const api = await loadPlugin({ interval: 5 });
    const ctx = { conversationId: "test-2", agentId: "main" };
    // Exactly 5 user messages
    const result = await api._trigger(
      "before_prompt_build",
      { prompt: "hello", messages: makeMessages(5) },
      ctx,
    );
    expect(result[0]).toMatchObject({ prependContext: expect.stringContaining("memory_nudge") });
  });

  it("does not double-nudge at the same turn count", async () => {
    const api = await loadPlugin({ interval: 5 });
    const ctx = { conversationId: "test-3", agentId: "main" };
    const msgs = makeMessages(5);
    const first = await api._trigger("before_prompt_build", { prompt: "a", messages: msgs }, ctx);
    const second = await api._trigger("before_prompt_build", { prompt: "b", messages: msgs }, ctx);
    expect(first[0]).toMatchObject({ prependContext: expect.any(String) });
    expect(second[0]).toBeUndefined();
  });

  it("respects maxPerSession limit", async () => {
    const api = await loadPlugin({ interval: 5, maxPerSession: 1 });
    const ctx = { conversationId: "test-4", agentId: "main" };
    await api._trigger("before_prompt_build", { prompt: "a", messages: makeMessages(5) }, ctx);
    // Second interval would normally trigger but is blocked by maxPerSession
    const result = await api._trigger(
      "before_prompt_build",
      { prompt: "b", messages: makeMessages(10) },
      ctx,
    );
    expect(result[0]).toBeUndefined();
  });

  it("does nothing when enabled=false", async () => {
    const api = await loadPlugin({ enabled: false });
    const ctx = { conversationId: "test-5", agentId: "main" };
    // No hooks should be registered
    const result = await api._trigger(
      "before_prompt_build",
      { prompt: "hello", messages: makeMessages(5) },
      ctx,
    );
    expect(result).toHaveLength(0);
  });

  it("uses custom nudgeText when provided", async () => {
    const api = await loadPlugin({ interval: 5, nudgeText: "CUSTOM NUDGE" });
    const ctx = { conversationId: "test-6", agentId: "main" };
    const result = await api._trigger(
      "before_prompt_build",
      { prompt: "hello", messages: makeMessages(5) },
      ctx,
    );
    expect(result[0]).toMatchObject({ prependContext: "CUSTOM NUDGE" });
  });
});
