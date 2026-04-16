import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// ============================================================
// Guidance texts ported from hermes-agent/agent/prompt_builder.py
// ============================================================

const TOOL_USE_ENFORCEMENT_GUIDANCE = `# Tool-use enforcement
You MUST use your tools to take action — do not describe what you would do \
or plan to do without actually doing it. When you say you will perform an \
action (e.g. 'I will run the tests', 'Let me check the file', 'I will create \
the project'), you MUST immediately make the corresponding tool call in the same \
response. Never end your turn with a promise of future action — execute it now.
Keep working until the task is actually complete. Do not stop with a summary of \
what you plan to do next time. If you have tools available that can accomplish \
the task, use them instead of telling the user what you would do.
Every response should either (a) contain tool calls that make progress, or \
(b) deliver a final result to the user. Responses that only describe intentions \
without acting are not acceptable.`;

const OPENAI_MODEL_EXECUTION_GUIDANCE = `# Execution discipline
<tool_persistence>
- Use tools whenever they improve correctness, completeness, or grounding.
- Do not stop early when another tool call would materially improve the result.
- If a tool returns empty or partial results, retry with a different query or strategy before giving up.
- Keep calling tools until: (1) the task is complete, AND (2) you have verified the result.
</tool_persistence>

<mandatory_tool_use>
NEVER answer these from memory or mental computation — ALWAYS use a tool:
- Arithmetic, math, calculations → use terminal or execute_code
- Hashes, encodings, checksums → use terminal (e.g. sha256sum, base64)
- Current time, date, timezone → use terminal (e.g. date)
- System state: OS, CPU, memory, disk, ports, processes → use terminal
- File contents, sizes, line counts → use read_file, search_files, or terminal
- Git history, branches, diffs → use terminal
- Current facts (weather, news, versions) → use web_search
Your memory and user profile describe the USER, not the system you are running on. \
The execution environment may differ from what the user profile says about their personal setup.
</mandatory_tool_use>

<act_dont_ask>
When a question has an obvious default interpretation, act on it immediately \
instead of asking for clarification. Examples:
- 'Is port 443 open?' → check THIS machine (don't ask 'open where?')
- 'What OS am I running?' → check the live system (don't use user profile)
- 'What time is it?' → run \`date\` (don't guess)
Only ask for clarification when the ambiguity genuinely changes what tool you would call.
</act_dont_ask>

<prerequisite_checks>
- Before taking an action, check whether prerequisite discovery, lookup, or context-gathering steps are needed.
- Do not skip prerequisite steps just because the final action seems obvious.
- If a task depends on output from a prior step, resolve that dependency first.
</prerequisite_checks>

<verification>
Before finalizing your response:
- Correctness: does the output satisfy every stated requirement?
- Grounding: are factual claims backed by tool outputs or provided context?
- Formatting: does the output match the requested format or schema?
- Safety: if the next step has side effects (file writes, commands, API calls), confirm scope before executing.
</verification>

<missing_context>
- If required context is missing, do NOT guess or hallucinate an answer.
- Use the appropriate lookup tool when missing information is retrievable (search_files, web_search, read_file, etc.).
- Ask a clarifying question only when the information cannot be retrieved by tools.
- If you must proceed with incomplete information, label assumptions explicitly.
</missing_context>`;

const GOOGLE_MODEL_OPERATIONAL_GUIDANCE = `# Google model operational directives
Follow these operational rules strictly:
- **Absolute paths:** Always construct and use absolute file paths for all file system operations. Combine the project root with relative paths.
- **Verify first:** Use read_file/search_files to check file contents and project structure before making changes. Never guess at file contents.
- **Dependency checks:** Never assume a library is available. Check package.json, requirements.txt, Cargo.toml, etc. before importing.
- **Conciseness:** Keep explanatory text brief — a few sentences, not paragraphs. Focus on actions and results over narration.
- **Parallel tool calls:** When you need to perform multiple independent operations (e.g. reading several files), make all the tool calls in a single response rather than sequentially.
- **Non-interactive commands:** Use flags like -y, --yes, --non-interactive to prevent CLI tools from hanging on prompts.
- **Keep going:** Work autonomously until the task is fully resolved. Don't stop with a plan — execute it.`;

const MEMORY_GUIDANCE = `# Memory guidance
You have persistent memory across sessions. Save durable facts using the memory \
tool: user preferences, environment details, tool quirks, and stable conventions. \
Memory is injected into every turn, so keep it compact and focused on facts that \
will still matter later.
Prioritize what reduces future user steering — the most valuable memory is one \
that prevents the user from having to correct or remind you again. \
User preferences and recurring corrections matter more than procedural task details.
Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO \
state to memory; use session_search to recall those from past transcripts. \
If you've discovered a new way to do something, solved a problem that could be \
necessary later, save it as a skill with the skill tool.`;

const SKILLS_GUIDANCE = `# Skills guidance
After completing a complex task (5+ tool calls), fixing a tricky error, \
or discovering a non-trivial workflow, save the approach as a \
skill with skill_manage so you can reuse it next time.
When using a skill and finding it outdated, incomplete, or wrong, \
patch it immediately with skill_manage(action='patch') — don't wait to be asked. \
Skills that aren't maintained become liabilities.`;

// Model name substrings that trigger GPT execution guidance
const GPT_MODEL_PATTERNS = ["gpt", "codex", "copilot", "o1", "o3", "o4"];
const _GEMINI_MODEL_PATTERNS = ["gemini", "gemma"];

type ModelGuidanceConfig = {
  enabled?: boolean;
  /** "gpt" | "gemini" | "auto" — auto detects from primary model config */
  modelFamily?: string;
  /** Inject MEMORY_GUIDANCE into system prompt. Default: true */
  injectMemoryGuidance?: boolean;
  /** Inject SKILLS_GUIDANCE into system prompt. Default: true */
  injectSkillsGuidance?: boolean;
  /** Inject tool-use enforcement guidance. Default: true */
  injectToolUseEnforcement?: boolean;
};

export default definePluginEntry({
  id: "model-guidance",
  name: "Model Guidance",
  description:
    "Injects model-specific execution guidance and memory/skill guidance to reduce narration and improve discipline.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as ModelGuidanceConfig;

    if (cfg.enabled === false) {
      return;
    }

    const family = (cfg.modelFamily ?? "gpt").toLowerCase();
    const injectMemory = cfg.injectMemoryGuidance !== false;
    const injectSkills = cfg.injectSkillsGuidance !== false;
    const injectToolUse = cfg.injectToolUseEnforcement !== false;

    api.on("before_prompt_build", (_event, _ctx) => {
      const parts: string[] = [];

      if (injectToolUse) {
        parts.push(TOOL_USE_ENFORCEMENT_GUIDANCE);
      }

      // Model-specific execution discipline
      if (
        family === "auto"
          ? GPT_MODEL_PATTERNS.some((p) => family.includes(p))
          : family === "gpt" || family === "copilot"
      ) {
        parts.push(OPENAI_MODEL_EXECUTION_GUIDANCE);
      } else if (family === "gemini") {
        parts.push(GOOGLE_MODEL_OPERATIONAL_GUIDANCE);
      } else if (family === "gpt") {
        // default: inject GPT guidance (most users here are on gpt-5.4)
        parts.push(OPENAI_MODEL_EXECUTION_GUIDANCE);
      }

      if (injectMemory) {
        parts.push(MEMORY_GUIDANCE);
      }

      if (injectSkills) {
        parts.push(SKILLS_GUIDANCE);
      }

      if (parts.length === 0) {
        return undefined;
      }

      const guidance = parts.join("\n\n");
      api.logger.info?.(
        `model-guidance: injecting ${parts.length} guidance block(s) for modelFamily=${family}`,
      );

      return { appendSystemContext: guidance };
    });
  },
});
