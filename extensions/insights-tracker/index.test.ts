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

beforeEach(() => {
  tmpDir = join(tmpdir(), `insights-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
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

describe("insights-tracker plugin", () => {
  it("tracks tool calls and saves on agent_end", async () => {
    const statsFile = join(tmpDir, "stats.json");
    const api = await loadPlugin({ statsFile });
    await api._trigger("after_tool_call", { toolName: "bash", durationMs: 50 }, { sessionId: "s1", toolName: "bash" });
    await api._trigger("after_tool_call", { toolName: "write_file" }, { sessionId: "s1", toolName: "write_file" });
    await api._trigger("agent_end", { success: true }, { sessionId: "s1" });

    const { readFileSync } = await import("node:fs");
    const data = JSON.parse(readFileSync(statsFile, "utf-8"));
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].toolCalls).toHaveLength(2);
    expect(data.sessions[0].toolCalls[0].tool).toBe("bash");
  });

  it("does nothing when enabled=false", async () => {
    const statsFile = join(tmpDir, "stats.json");
    const api = await loadPlugin({ enabled: false, statsFile });
    await api._trigger("after_tool_call", { toolName: "bash" }, { sessionId: "s1", toolName: "bash" });
    await api._trigger("agent_end", {}, { sessionId: "s1" });
    const { existsSync } = await import("node:fs");
    expect(existsSync(statsFile)).toBe(false);
  });

  it("handles missing session gracefully at agent_end", async () => {
    const statsFile = join(tmpDir, "stats.json");
    const api = await loadPlugin({ statsFile });
    // No tool calls recorded — agent_end should not crash
    await expect(api._trigger("agent_end", {}, { sessionId: "ghost" })).resolves.toBeDefined();
  });
});
