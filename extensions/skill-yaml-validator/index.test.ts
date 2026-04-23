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

const HOME = process.env["HOME"] ?? "/Users/leoliu";
const SKILL_DIR = `${HOME}/.openclaw/skills`;

const VALID_CONTENT = `---
name: my-skill
description: A test skill that does something useful.
---

This is the skill body content.
`;

function triggerWrite(
  api: ReturnType<typeof makeFakeApi>,
  toolName: string,
  path: string,
  content: string,
) {
  return api._trigger(
    "before_tool_call",
    { toolName, params: { path, content } },
    { sessionId: "s1" },
  );
}

describe("skill-yaml-validator plugin", () => {
  it("allows write to skill file with valid content", async () => {
    const api = await loadPlugin({ skillPaths: [SKILL_DIR] });
    const result = await triggerWrite(api, "create", `${SKILL_DIR}/my-skill.md`, VALID_CONTENT);
    expect(result[0]).toBeUndefined();
  });

  it("blocks write with missing name field", async () => {
    const api = await loadPlugin({ skillPaths: [SKILL_DIR] });
    const content = `---
description: A test skill.
---
Body here.
`;
    const result = await triggerWrite(api, "create", `${SKILL_DIR}/my-skill.md`, content);
    expect(result[0]).toMatchObject({
      block: true,
      blockReason: expect.stringContaining("name"),
    });
  });

  it("blocks write with missing description field", async () => {
    const api = await loadPlugin({ skillPaths: [SKILL_DIR] });
    const content = `---
name: my-skill
---
Body here.
`;
    const result = await triggerWrite(api, "create", `${SKILL_DIR}/my-skill.md`, content);
    expect(result[0]).toMatchObject({
      block: true,
      blockReason: expect.stringContaining("description"),
    });
  });

  it("blocks write to unsupported subdirectory", async () => {
    const api = await loadPlugin({ skillPaths: [SKILL_DIR] });
    const badPath = `${SKILL_DIR}/private/my-skill.md`;
    const result = await triggerWrite(api, "create", badPath, VALID_CONTENT);
    expect(result[0]).toMatchObject({
      block: true,
      blockReason: expect.stringContaining("private"),
    });
  });

  it("allows write to an allowed subdirectory (references)", async () => {
    const api = await loadPlugin({ skillPaths: [SKILL_DIR] });
    const refPath = `${SKILL_DIR}/references/note.md`;
    const result = await triggerWrite(api, "create", refPath, VALID_CONTENT);
    expect(result[0]).toBeUndefined();
  });

  it("does nothing when enabled=false", async () => {
    const api = await loadPlugin({ enabled: false });
    const result = await triggerWrite(api, "create", `${SKILL_DIR}/my-skill.md`, "no frontmatter");
    expect(result).toHaveLength(0);
  });
});
