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

const BIG_TEXT = "x".repeat(60_000);
const SMALL_TEXT = "x".repeat(1_000);

function makeToolResultEvent(text: string) {
  return { toolName: "bash", message: { role: "tool", content: text } };
}

describe("tool-output-truncation plugin", () => {
  it("does not truncate small outputs", async () => {
    const api = await loadPlugin({ maxChars: 50_000 });
    await api._trigger("before_model_resolve", {}, { agentId: "a1" });
    const result = await api._trigger("tool_result_persist", makeToolResultEvent(SMALL_TEXT), {
      agentId: "a1",
    });
    expect(result[0]).toBeUndefined();
  });

  it("truncates large outputs and inserts omitted marker with tool attribute", async () => {
    const api = await loadPlugin({ maxChars: 50_000 });
    await api._trigger("before_model_resolve", {}, { agentId: "a2" });
    const result = (await api._trigger("tool_result_persist", makeToolResultEvent(BIG_TEXT), {
      agentId: "a2",
    })) as [{ message: { content: string } }];
    const content = result[0]?.message?.content ?? "";
    expect(content).toContain("<omitted");
    expect(content).toContain('tool="bash"');
    expect(content.length).toBeLessThan(BIG_TEXT.length);
  });

  it("adds JSON truncation warning for JSON-like output", async () => {
    const jsonText = JSON.stringify({
      results: Array.from({ length: 5000 }, (_, i) => ({ id: i, value: "x".repeat(20) })),
    });
    const api = await loadPlugin({ maxChars: 50_000 });
    await api._trigger("before_model_resolve", {}, { agentId: "a3" });
    const result = (await api._trigger("tool_result_persist", makeToolResultEvent(jsonText), {
      agentId: "a3",
    })) as [{ message: { content: string } }];
    const content = result[0]?.message?.content ?? "";
    expect(content).toContain("json_truncated_output_is_incomplete");
  });

  it("does not add JSON warning for plain text output", async () => {
    const api = await loadPlugin({ maxChars: 50_000 });
    await api._trigger("before_model_resolve", {}, { agentId: "a4" });
    const result = (await api._trigger("tool_result_persist", makeToolResultEvent(BIG_TEXT), {
      agentId: "a4",
    })) as [{ message: { content: string } }];
    const content = result[0]?.message?.content ?? "";
    expect(content).toContain("<omitted");
    expect(content).not.toContain("json_truncated_output_is_incomplete");
  });

  it("skips truncation for tools in skipTools list", async () => {
    const api = await loadPlugin({ maxChars: 50_000, skipTools: ["bash"] });
    await api._trigger("before_model_resolve", {}, { agentId: "a5" });
    const result = await api._trigger("tool_result_persist", makeToolResultEvent(BIG_TEXT), {
      agentId: "a5",
    });
    expect(result[0]).toBeUndefined();
  });

  it("does nothing when enabled=false", async () => {
    const api = await loadPlugin({ enabled: false });
    const result = await api._trigger("tool_result_persist", makeToolResultEvent(BIG_TEXT), {
      agentId: "a6",
    });
    expect(result).toHaveLength(0);
  });
});
