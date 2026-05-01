import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the api module
const mockApi = {
  pluginConfig: null as unknown,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  on: vi.fn(),
};

type HookHandler = (event: unknown, ctx: unknown) => unknown;

function collectHooks() {
  const hooks: Record<string, HookHandler> = {};
  mockApi.on.mockImplementation((name: string, fn: HookHandler) => {
    hooks[name] = fn;
  });
  return hooks;
}

describe("tool-loop-guard", () => {
  beforeEach(() => {
    vi.resetModules();
    mockApi.on.mockReset();
    mockApi.logger.info.mockReset();
    mockApi.logger.error.mockReset();
  });

  it("does not register hooks when enabled=false", async () => {
    mockApi.pluginConfig = { enabled: false };
    const hooks = collectHooks();
    const mod = await import("./index.js");
    mod.default.register(mockApi as never);
    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it("registers before_tool_call, after_tool_call, agent_end, before_prompt_build with defaults", async () => {
    mockApi.pluginConfig = {};
    const hooks = collectHooks();
    const mod = await import("./index.js");
    mod.default.register(mockApi as never);
    expect(hooks["before_tool_call"]).toBeDefined();
    expect(hooks["after_tool_call"]).toBeDefined();
    expect(hooks["agent_end"]).toBeDefined();
    expect(hooks["before_prompt_build"]).toBeDefined();
  });

  it("injects warning after 2 consecutive exact failures (default threshold)", async () => {
    mockApi.pluginConfig = {};
    const hooks = collectHooks();
    const mod = await import("./index.js");
    mod.default.register(mockApi as never);

    const ctx = { sessionId: "sess-warn" };
    const failEvent = { toolName: "bash", params: { cmd: "rm -f x" }, error: "command failed" };

    // First failure
    await hooks["after_tool_call"]!(failEvent, ctx);
    let result = await hooks["before_prompt_build"]!({}, ctx);
    expect(result).toBeUndefined(); // not yet at threshold

    // Second failure (threshold = 2, reaches it)
    await hooks["after_tool_call"]!(failEvent, ctx);
    result = await hooks["before_prompt_build"]!({}, ctx);
    expect(result).toBeDefined();
    const r = result as { appendContext?: string };
    expect(r.appendContext).toContain("Tool Loop Guard");
    expect(r.appendContext).toContain("bash");
  });

  it("does not hard-stop when hardStopEnabled=false (default)", async () => {
    mockApi.pluginConfig = { hardStopEnabled: false };
    const hooks = collectHooks();
    const mod = await import("./index.js");
    mod.default.register(mockApi as never);

    const ctx = { sessionId: "sess-noblock" };
    const failEvent = { toolName: "write_file", params: { path: "/x" }, error: "fail" };

    // Exceed block threshold
    for (let i = 0; i < 6; i++) {
      await hooks["after_tool_call"]!(failEvent, ctx);
    }
    const blockResult = await hooks["before_tool_call"]!(
      { toolName: "write_file", params: { path: "/x" } },
      ctx,
    );
    expect(blockResult).toBeUndefined();
  });

  it("hard-stops on mutating tool when hardStopEnabled=true and threshold exceeded", async () => {
    mockApi.pluginConfig = { hardStopEnabled: true, exactFailureBlockAfter: 3 };
    const hooks = collectHooks();
    const mod = await import("./index.js");
    mod.default.register(mockApi as never);

    const ctx = { sessionId: "sess-block" };
    const failEvent = { toolName: "bash", params: { cmd: "dangerous" }, error: "fail" };

    for (let i = 0; i < 4; i++) {
      await hooks["after_tool_call"]!(failEvent, ctx);
    }
    const blockResult = await hooks["before_tool_call"]!(
      { toolName: "bash", params: { cmd: "dangerous" } },
      ctx,
    );
    expect(blockResult).toMatchObject({ block: true });
  });

  it("cleans up session state on agent_end", async () => {
    mockApi.pluginConfig = {};
    const hooks = collectHooks();
    const mod = await import("./index.js");
    mod.default.register(mockApi as never);

    const ctx = { sessionId: "sess-cleanup" };
    await hooks["after_tool_call"]!({ toolName: "bash", params: {}, error: "fail" }, ctx);
    await hooks["after_tool_call"]!({ toolName: "bash", params: {}, error: "fail" }, ctx);
    await hooks["agent_end"]!({}, ctx);

    // After cleanup, no warnings should be injected
    const result = await hooks["before_prompt_build"]!({}, ctx);
    expect(result).toBeUndefined();
  });
});
