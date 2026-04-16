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

// Skills dir prompt pattern shown to the agent
const SKILL_CREATION_PROMPT = `<skill_auto_create>
LEARNING OPPORTUNITY DETECTED: This session involved several tool operations that may represent a reusable workflow pattern.

Please review this conversation and consider creating a Skill file to capture the workflow. If there is a clear, reusable pattern:

1. Summarize the task pattern in 1-2 sentences
2. Use the skill management tool (or write a markdown file to ~/.openclaw/skills/auto-created/) with:
   - A descriptive filename (e.g., "deploy-docker-service.md")
   - A clear title and description
   - Step-by-step instructions extracted from this session
   - Any commands, patterns, or tricks discovered

Only create a skill if the workflow is genuinely reusable and not already covered by existing skills. Skip if this was a one-off task.
</skill_auto_create>`;

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
      const sessionId = ctx.sessionId ?? ctx.agentId ?? "default";
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

      return { prependContext: SKILL_CREATION_PROMPT };
    });
  },
});
