import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

const DEFAULT_TOOL_CALL_THRESHOLD = 5;
const DEFAULT_MAX_PER_SESSION = 1;
const DEFAULT_INTERESTING_TOOLS = new Set([
  "bash",
  "computer",
  "write_file",
  "create_file",
  "edit_file",
  "run_terminal_cmd",
  "str_replace_based_edit_tool",
  "create",
  "edit",
]);

// Exact hermes _SKILL_REVIEW_PROMPT text — focused on non-trivial workflows discovered through trial and error
const SKILL_CREATION_PROMPT = `<skill_review>
Review the conversation above and consider saving a reusable skill. Focus on:
- Did this session involve a non-trivial approach that required trial and error, or changing course?
- Was there a workflow, trick, or fix that would be hard to recall or reinvent next time?
If something stands out, save it using the skill_manage tool (or write a markdown file to ~/.openclaw/skills/).
Include: a clear title, the approach in concise steps, any key commands or patterns, and gotchas to avoid.
If a relevant skill already exists, update it with what was learned here.
If nothing is worth saving, just say "Nothing to save." and stop.
</skill_review>`;

const MAX_EXISTING_SKILLS_SHOWN = 50;

function resolveSkillsDir(dir: string | undefined): string {
  const raw = typeof dir === "string" ? dir : "~/.openclaw/skills";
  const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  const resolved = resolve(expanded);
  const home = homedir();
  if (resolved.startsWith(home + "/") || resolved === home) {
    return resolved;
  }
  return join(home, ".openclaw", "skills");
}

function scanExistingSkillTitles(skillsDir: string): string[] {
  try {
    if (!existsSync(skillsDir)) {
      return [];
    }
    const files = readdirSync(skillsDir).filter((f) => f.endsWith(".md") && !f.startsWith("."));
    const titles: string[] = [];
    for (const file of files.slice(0, MAX_EXISTING_SKILLS_SHOWN)) {
      try {
        const content = readFileSync(join(skillsDir, file), "utf8");
        const firstLine = content.split("\n")[0]?.trim() ?? "";
        const title = firstLine.startsWith("# ")
          ? firstLine.slice(2).trim()
          : file.replace(/\.md$/, "");
        titles.push(title);
      } catch {
        // skip unreadable files
      }
    }
    return titles;
  } catch {
    return [];
  }
}

function buildSkillPrompt(basePrompt: string, existingTitles: string[]): string {
  if (existingTitles.length === 0) {
    return basePrompt;
  }
  const dedupeHint =
    `\n\nExisting skills (titles only — avoid duplicates; update an existing skill if relevant):\n` +
    existingTitles.map((t) => `- ${t}`).join("\n");
  // Insert the dedup hint before the closing </skill_review> tag.
  const closingTag = "</skill_review>";
  const closingIdx = basePrompt.lastIndexOf(closingTag);
  if (closingIdx === -1) {
    return basePrompt + dedupeHint;
  }
  return basePrompt.slice(0, closingIdx).trimEnd() + dedupeHint + "\n" + closingTag;
}

type SkillAutoCreateConfig = {
  enabled?: boolean;
  toolCallThreshold?: number;
  maxPerSession?: number;
  interestingTools?: string[];
  skillsDir?: string;
};

// Per-session tracking: sessionId → { toolCallCount, promptsIssued, toolNames }
const sessionState = new Map<
  string,
  { toolCallCount: number; promptsIssued: number; toolNames: Set<string> }
>();

function getSessionState(sessionId: string) {
  let state = sessionState.get(sessionId);
  if (!state) {
    state = { toolCallCount: 0, promptsIssued: 0, toolNames: new Set() };
    sessionState.set(sessionId, state);
  }
  return state;
}

export default definePluginEntry({
  id: "skill-auto-create",
  name: "Skill Auto-Create",
  description:
    "After N interesting tool calls in a session, prompts the agent to create a reusable Skill file.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as SkillAutoCreateConfig;

    if (cfg.enabled === false) {
      return;
    }

    const threshold =
      typeof cfg.toolCallThreshold === "number" && cfg.toolCallThreshold > 0
        ? cfg.toolCallThreshold
        : DEFAULT_TOOL_CALL_THRESHOLD;

    const maxPerSession =
      typeof cfg.maxPerSession === "number" && cfg.maxPerSession >= 0
        ? cfg.maxPerSession
        : DEFAULT_MAX_PER_SESSION;

    const interestingTools =
      Array.isArray(cfg.interestingTools) && cfg.interestingTools.length > 0
        ? new Set(cfg.interestingTools)
        : DEFAULT_INTERESTING_TOOLS;

    // Track interesting tool calls per session
    api.on("after_tool_call", (event, ctx) => {
      const sessionId = ctx.sessionId ?? ctx.agentId ?? "default";
      const toolName = (event as { toolName?: string }).toolName ?? ctx.toolName ?? "";
      if (!toolName || !interestingTools.has(toolName)) {
        return;
      }
      const state = getSessionState(sessionId);
      state.toolCallCount++;
      state.toolNames.add(toolName);
    });

    // Inject skill creation prompt when threshold is met
    api.on("before_prompt_build", async (event, ctx) => {
      // before_prompt_build ctx provides conversationId; after_tool_call provides sessionId.
      // In production these are the same value — check both so tests and runtime align.
      const ctx_ = ctx as Record<string, unknown>;
      const sessionId =
        (ctx_.sessionId as string | undefined) ??
        (ctx_.agentId as string | undefined) ??
        (ctx_.conversationId as string | undefined) ??
        "default";
      const state = getSessionState(sessionId);

      if (state.toolCallCount < threshold) {
        return undefined;
      }
      if (maxPerSession > 0 && state.promptsIssued >= maxPerSession) {
        return undefined;
      }

      state.promptsIssued++;

      api.logger.info?.(
        `skill-auto-create: injecting skill creation prompt (${state.toolCallCount} tool calls in session ${sessionId}, tools: ${[...state.toolNames].join(",")})`,
      );

      const skillsDir = resolveSkillsDir(cfg.skillsDir);
      const existingTitles = scanExistingSkillTitles(skillsDir);
      const prompt = buildSkillPrompt(SKILL_CREATION_PROMPT, existingTitles);

      return { prependContext: prompt };
    });

    // Clean up per-session state when session ends to prevent unbounded map growth.
    api.on("agent_end", (_event, ctx) => {
      const sessionId = ctx.sessionId ?? ctx.agentId ?? "default";
      sessionState.delete(sessionId);
    });
  },
});
