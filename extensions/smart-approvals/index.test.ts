import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {}
});

async function loadPlugin(config?: Record<string, unknown>) {
  vi.resetModules();
  const mod = await import("./index.js");
  const api = makeFakeApi(config);
  mod.default.register(api as never);
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
    expect(result[0]).toMatchObject({
      requireApproval: { title: expect.stringContaining("dangerous") },
    });
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

  it("agent_end clears active subagent timers without errors", async () => {
    vi.useFakeTimers();
    const api = await loadPlugin({
      patternsFile,
      delegationTimeoutSeconds: 10,
      heartbeatIntervalSeconds: 2,
      staleThresholdCycles: 2,
    });

    // Spawn a subagent to register timers
    await api._trigger(
      "subagent_spawned",
      { childSessionKey: "sub-001", agentId: "worker", label: "test-worker" },
      {},
    );

    // End the parent session before the subagent ends
    await api._trigger("agent_end", {}, { agentId: "parent" });

    // Advance time well past the stale + hard-timeout threshold
    vi.advanceTimersByTime(30_000);

    // Stale warning should NOT have been called (timer was cleared)
    const warnCalls = (api.logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes("stale"),
    );
    expect(warnCalls).toHaveLength(0);

    vi.useRealTimers();
  });
});
