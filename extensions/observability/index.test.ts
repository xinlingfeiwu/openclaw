import { describe, it, expect, vi, beforeEach } from "vitest";

type HookHandler = (event: unknown, ctx: unknown) => unknown;

function makeMockApi(config: unknown) {
  const hooks: Record<string, HookHandler> = {};
  return {
    api: {
      pluginConfig: config,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn().mockImplementation((name: string, fn: HookHandler) => {
        hooks[name] = fn;
      }),
    },
    hooks,
  };
}

describe("observability", () => {
  beforeEach(() => {
    vi.resetModules();
    // Clear env vars
    delete process.env["OPENCLAW_LANGFUSE_PUBLIC_KEY"];
    delete process.env["OPENCLAW_LANGFUSE_SECRET_KEY"];
  });

  it("does not register hooks when enabled=false", async () => {
    const { api, hooks } = makeMockApi({ enabled: false });
    const mod = await import("./index.js");
    mod.default.register(api as never);
    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it("does not register hooks when credentials are missing", async () => {
    const { api, hooks } = makeMockApi({});
    const mod = await import("./index.js");
    mod.default.register(api as never);
    // No credentials → hooks not registered, just info logged
    expect(Object.keys(hooks)).toHaveLength(0);
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("no Langfuse credentials"),
    );
  });

  it("registers all hooks when credentials provided in config", async () => {
    const { api, hooks } = makeMockApi({
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      baseUrl: "https://langfuse.example.com",
    });
    const mod = await import("./index.js");
    mod.default.register(api as never);
    // No before_agent_start — trace is lazily opened on first model_call_started.
    expect(hooks["before_agent_start"]).toBeUndefined();
    expect(hooks["model_call_started"]).toBeDefined();
    expect(hooks["model_call_ended"]).toBeDefined();
    expect(hooks["before_tool_call"]).toBeDefined();
    expect(hooks["after_tool_call"]).toBeDefined();
    expect(hooks["agent_end"]).toBeDefined();
  });

  it("reads credentials from environment variables", async () => {
    process.env["OPENCLAW_LANGFUSE_PUBLIC_KEY"] = "pk-env-key";
    process.env["OPENCLAW_LANGFUSE_SECRET_KEY"] = "sk-env-key";
    const { api, hooks } = makeMockApi({});
    const mod = await import("./index.js");
    mod.default.register(api as never);
    expect(hooks["model_call_started"]).toBeDefined();
  });

  it("before_tool_call returns undefined (no blocking behavior)", async () => {
    process.env["OPENCLAW_LANGFUSE_PUBLIC_KEY"] = "pk-lf-test";
    process.env["OPENCLAW_LANGFUSE_SECRET_KEY"] = "sk-lf-test";
    const { api, hooks } = makeMockApi({});
    const mod = await import("./index.js");
    mod.default.register(api as never);

    // No active session → should not throw and should return undefined
    const result = await hooks["before_tool_call"](
      { toolName: "bash", params: {}, toolCallId: "tc1" },
      { sessionId: "no-session" },
    );
    expect(result).toBeUndefined();
  });

  it("agent_end with no active session does not throw", async () => {
    process.env["OPENCLAW_LANGFUSE_PUBLIC_KEY"] = "pk-lf-test";
    process.env["OPENCLAW_LANGFUSE_SECRET_KEY"] = "sk-lf-test";
    const { api, hooks } = makeMockApi({});
    const mod = await import("./index.js");
    mod.default.register(api as never);

    await expect(
      hooks["agent_end"]({ success: true }, { sessionId: "nonexistent" }),
    ).resolves.toBeUndefined();
  });

  it("respects sampleRate=0 — model_call_started returns without creating trace", async () => {
    process.env["OPENCLAW_LANGFUSE_PUBLIC_KEY"] = "pk-lf-test";
    process.env["OPENCLAW_LANGFUSE_SECRET_KEY"] = "sk-lf-test";
    const { api, hooks } = makeMockApi({ sampleRate: 0 });
    const mod = await import("./index.js");
    mod.default.register(api as never);

    // With sampleRate=0 all samples are skipped; should not throw
    await expect(
      hooks["model_call_started"]({ callId: "c1", model: "gpt-5.4" }, { sessionId: "s-sample" }),
    ).resolves.toBeUndefined();
  });
});
