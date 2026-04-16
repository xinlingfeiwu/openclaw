import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

let tmpDir: string;
let patternsFile: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `approvals-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  patternsFile = join(tmpDir, "approved-patterns.json");
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true }); } catch {}
});

async function loadPlugin(config?: Record<string, unknown>) {
  vi.resetModules();
  const mod = await import("./index.js");
  const api = makeFakeApi(config);
  void mod.default.register(api as never);
  return api;
}

describe("smart-approvals plugin", () => {
  it("returns undefined for non-sensitive tools", async () => {
    const api = await loadPlugin({ patternsFile });
    const result = await api._trigger(
      "before_tool_call",
      { toolName: "memory_search", params: { query: "hello" } },
      {},
    );
    expect(result[0]).toBeUndefined();
  });

  it("returns requireApproval for dangerous command", async () => {
    const api = await loadPlugin({ patternsFile });
    const result = await api._trigger(
      "before_tool_call",
      { toolName: "bash", params: { command: "rm -rf /tmp/test" } },
      {},
    );
    expect(result[0]).toMatchObject({ requireApproval: { title: expect.stringContaining("dangerous") } });
  });

  it("allows safe bash command without approval", async () => {
    const api = await loadPlugin({ patternsFile });
    const result = await api._trigger(
      "before_tool_call",
      { toolName: "bash", params: { command: "echo hello world" } },
      {},
    );
    expect(result[0]).toBeUndefined();
  });

  it("does nothing when enabled=false", async () => {
    const api = await loadPlugin({ enabled: false, patternsFile });
    const result = await api._trigger(
      "before_tool_call",
      { toolName: "bash", params: { command: "rm -rf /" } },
      {},
    );
    expect(result).toHaveLength(0);
  });
});
