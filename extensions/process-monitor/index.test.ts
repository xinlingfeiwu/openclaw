import { describe, it, expect, vi, beforeEach } from "vitest";

function buildApi(overrides: Record<string, unknown> = {}) {
  const handlers: Record<string, ((ev: unknown, ctx: unknown) => unknown)[]> =
    {};
  return {
    pluginConfig: overrides,
    logger: { info: vi.fn(), warn: vi.fn() },
    on(name: string, fn: (ev: unknown, ctx: unknown) => unknown) {
      handlers[name] ??= [];
      handlers[name].push(fn);
    },
    _trigger(name: string, ev: unknown, ctx: unknown) {
      let result: unknown;
      for (const fn of handlers[name] ?? []) {
        result = fn(ev, ctx);
      }
      return result;
    },
  };
}

describe("process-monitor", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("ignores tool calls below threshold", async () => {
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ longRunningThresholdMs: 5000 });
    plugin.register(api as never);

    api._trigger("before_tool_call", { toolName: "bash", toolCallId: "c1" }, {});
    api._trigger("after_tool_call", {
      toolName: "bash",
      toolCallId: "c1",
      durationMs: 100,
      params: { command: "echo hello" },
    }, { sessionId: "s1" });

    const ctx = api._trigger("before_prompt_build", {}, {});
    expect(ctx).toBeUndefined();
  });

  it("registers long-running process and injects context", async () => {
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ longRunningThresholdMs: 100 });
    plugin.register(api as never);

    api._trigger("before_tool_call", { toolName: "bash", toolCallId: "c2" }, {});
    api._trigger("after_tool_call", {
      toolName: "bash",
      toolCallId: "c2",
      durationMs: 8000,
      params: { command: "npm run build" },
    }, { sessionId: "s1" });

    const result = api._trigger("before_prompt_build", {}, {}) as { appendSystemContext: string } | undefined;
    expect(result).toBeDefined();
    expect(result?.appendSystemContext).toContain("<process_monitor>");
    expect(result?.appendSystemContext).toContain("npm run build");
  });

  it("does not track non-bash tools", async () => {
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ longRunningThresholdMs: 100 });
    plugin.register(api as never);

    api._trigger("before_tool_call", { toolName: "read_file", toolCallId: "c3" }, {});
    api._trigger("after_tool_call", {
      toolName: "read_file",
      toolCallId: "c3",
      durationMs: 9000,
      params: { path: "/some/file" },
    }, { sessionId: "s1" });

    const ctx = api._trigger("before_prompt_build", {}, {});
    expect(ctx).toBeUndefined();
  });

  it("returns nothing when plugin disabled", async () => {
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ enabled: false });
    plugin.register(api as never);

    // No handlers registered → _trigger returns undefined
    const ctx = api._trigger("before_prompt_build", {}, {});
    expect(ctx).toBeUndefined();
  });

  it("limits context to last 5 long-running commands", async () => {
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ longRunningThresholdMs: 100, maxTracked: 20 });
    plugin.register(api as never);

    for (let i = 0; i < 8; i++) {
      api._trigger("before_tool_call", { toolName: "bash", toolCallId: `c${i}` }, {});
      api._trigger("after_tool_call", {
        toolName: "bash",
        toolCallId: `c${i}`,
        durationMs: 6000,
        params: { command: `job-${i}` },
      }, { sessionId: "s1" });
    }

    const result = api._trigger("before_prompt_build", {}, {}) as { appendSystemContext: string } | undefined;
    // Should only show last 5
    const lines = result?.appendSystemContext?.split("\n").filter((l) => l.startsWith("- "));
    expect(lines?.length).toBeLessThanOrEqual(5);
  });
});
