import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

describe("skill-curator", () => {
  let tmpSkillsDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpSkillsDir = join(tmpdir(), `skill-curator-test-${Date.now()}`);
    mkdirSync(tmpSkillsDir, { recursive: true });
  });

  it("does not register hooks when enabled=false", async () => {
    const { api, hooks } = makeMockApi({ enabled: false });
    const mod = await import("./index.js");
    mod.default.register(api as never);
    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it("registers gateway_start, before_prompt_build, agent_end", async () => {
    const { api, hooks } = makeMockApi({ skillsDir: tmpSkillsDir, intervalDays: 0 });
    const mod = await import("./index.js");
    mod.default.register(api as never);
    expect(hooks["gateway_start"]).toBeDefined();
    expect(hooks["before_prompt_build"]).toBeDefined();
    expect(hooks["agent_end"]).toBeDefined();
  });

  it("triggers audit after gateway_start when last run is never", async () => {
    const { api, hooks } = makeMockApi({ skillsDir: tmpSkillsDir, intervalDays: 7 });
    const mod = await import("./index.js");
    mod.default.register(api as never);

    // No state file → last run = never → should trigger
    await hooks["gateway_start"]!({}, {});

    // Inject a stale agent-created skill
    const skillContent = "# Old Skill\ncreated_by_agent: true\nSome content.";
    writeFileSync(join(tmpSkillsDir, "old-skill.md"), skillContent, "utf8");

    const result = await hooks["before_prompt_build"]!({}, {});
    expect(result).toBeDefined();
    const r = result as { appendContext?: string };
    expect(r.appendContext).toContain("Skill Curator");
  });

  it("does not trigger audit when interval has not elapsed", async () => {
    const stateFile = join(tmpSkillsDir, ".curator_state.json");
    writeFileSync(
      stateFile,
      JSON.stringify({ lastRunAt: Date.now(), runCount: 1, paused: false, pinnedSkills: [] }),
      "utf8",
    );

    const { api, hooks } = makeMockApi({ skillsDir: tmpSkillsDir, intervalDays: 7 });
    const mod = await import("./index.js");
    mod.default.register(api as never);

    await hooks["gateway_start"]!({}, {});
    const result = await hooks["before_prompt_build"]!({}, {});
    expect(result).toBeUndefined();
  });

  it("respects paused flag and skips audit", async () => {
    const stateFile = join(tmpSkillsDir, ".curator_state.json");
    writeFileSync(
      stateFile,
      JSON.stringify({ lastRunAt: 0, runCount: 0, paused: true, pinnedSkills: [] }),
      "utf8",
    );

    const { api, hooks } = makeMockApi({ skillsDir: tmpSkillsDir, intervalDays: 0 });
    const mod = await import("./index.js");
    mod.default.register(api as never);

    await hooks["gateway_start"]!({}, {});
    const result = await hooks["before_prompt_build"]!({}, {});
    expect(result).toBeUndefined();
  });

  it("agent_end hook does not throw", async () => {
    const { api, hooks } = makeMockApi({ skillsDir: tmpSkillsDir });
    const mod = await import("./index.js");
    mod.default.register(api as never);
    await expect(hooks["agent_end"]!({}, {})).resolves.toBeUndefined();
  });

  afterEach(() => {
    if (existsSync(tmpSkillsDir)) {
      rmSync(tmpSkillsDir, { recursive: true, force: true });
    }
  });
});
