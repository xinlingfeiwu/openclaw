import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";

// We test the core logic by exercising the hook handlers directly via
// a minimal plugin harness, without a live OpenClaw gateway.

function buildApi(overrides: Record<string, unknown> = {}) {
  const handlers: Record<string, ((ev: unknown, ctx: unknown) => unknown)[]> =
    {};
  return {
    pluginConfig: overrides,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
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

describe("checkpoint-rollback", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves checkpoint when an existing file is edited", async () => {
    const targetFile = join(tmpDir, "target.ts");
    writeFileSync(targetFile, "original content");

    const checkpointsDir = join(tmpDir, "checkpoints");
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ checkpointsDir });
    plugin.register(api as never);

    api._trigger(
      "before_tool_call",
      { toolName: "edit", params: { path: targetFile } },
      { sessionId: "test-session" },
    );

    // Checkpoint dir should be created and file saved
    const sessionDir = join(checkpointsDir, "test-session");
    expect(existsSync(sessionDir)).toBe(true);
    const files = require("node:fs").readdirSync(sessionDir);
    const checkpointFiles = files.filter((f: string) => f.endsWith(".ts"));
    expect(checkpointFiles.length).toBe(1);
    const saved = readFileSync(join(sessionDir, checkpointFiles[0]), "utf-8");
    expect(saved).toBe("original content");
  });

  it("skips checkpoint when file does not exist", async () => {
    const checkpointsDir = join(tmpDir, "checkpoints");
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ checkpointsDir });
    plugin.register(api as never);

    api._trigger(
      "before_tool_call",
      {
        toolName: "create",
        params: { path: join(tmpDir, "nonexistent.ts") },
      },
      { sessionId: "test-session" },
    );

    expect(existsSync(join(checkpointsDir, "test-session"))).toBe(false);
  });

  it("respects watchTools config — ignores tools not in list", async () => {
    const targetFile = join(tmpDir, "target.ts");
    writeFileSync(targetFile, "original");

    const checkpointsDir = join(tmpDir, "checkpoints");
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ checkpointsDir, watchTools: ["edit"] });
    plugin.register(api as never);

    // bash is not in watchTools
    api._trigger(
      "before_tool_call",
      { toolName: "bash", params: { path: targetFile } },
      { sessionId: "test-session" },
    );

    expect(existsSync(join(checkpointsDir, "test-session"))).toBe(false);
  });

  it("respects maxCheckpointsPerSession limit", async () => {
    const checkpointsDir = join(tmpDir, "checkpoints");
    const { default: plugin } = await import("./index.js");
    const api = buildApi({ checkpointsDir, maxCheckpointsPerSession: 2 });
    plugin.register(api as never);

    for (let i = 0; i < 4; i++) {
      const f = join(tmpDir, `file${i}.ts`);
      writeFileSync(f, `content ${i}`);
      api._trigger(
        "before_tool_call",
        { toolName: "edit", params: { path: f } },
        { sessionId: "sess1" },
      );
    }

    const sessionDir = join(checkpointsDir, "sess1");
    const files = require("node:fs")
      .readdirSync(sessionDir)
      .filter((f: string) => f.endsWith(".ts"));
    // Only 2 checkpoints allowed
    expect(files.length).toBe(2);
  });

  it("does not block the tool call (returns undefined)", async () => {
    const targetFile = join(tmpDir, "target.ts");
    writeFileSync(targetFile, "content");

    const { default: plugin } = await import("./index.js");
    const api = buildApi({ checkpointsDir: join(tmpDir, "cp") });
    plugin.register(api as never);

    const result = api._trigger(
      "before_tool_call",
      { toolName: "edit", params: { path: targetFile } },
      { sessionId: "s1" },
    );

    expect(result).toBeUndefined();
  });
});
