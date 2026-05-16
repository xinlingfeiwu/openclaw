import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// Hermes-aligned thresholds: 160 chars and 28 words are the upper bounds for
// fast-model routing. Prompts exceeding either limit go to the primary model.
const DEFAULT_MAX_PROMPT_LENGTH = 160;
const DEFAULT_MAX_PROMPT_WORDS = 28;

// Default simple patterns: short greetings, factual lookups, status questions
const DEFAULT_SIMPLE_PATTERNS = [
  /^(hi|hello|hey|thanks?|thank you|ok|okay|yes|no|sure)[.!?]?\s*$/i,
  /^what('s| is) (the )?(time|date|weather|status)\??$/i,
  /^(translate|翻译)[:\s]/i,
  /^(summarize|summary|sum up)[:\s]/i,
];

// Hermes full 46-keyword complex vocabulary list. Any match → primary model.
const COMPLEX_KEYWORDS = new Set([
  "debug",
  "debugging",
  "implement",
  "implementation",
  "refactor",
  "patch",
  "traceback",
  "stacktrace",
  "exception",
  "error",
  "analyze",
  "analysis",
  "investigate",
  "architecture",
  "design",
  "compare",
  "benchmark",
  "optimize",
  "optimise",
  "review",
  "terminal",
  "shell",
  "tool",
  "tools",
  "pytest",
  "test",
  "tests",
  "plan",
  "planning",
  "delegate",
  "subagent",
  "cron",
  "docker",
  "kubernetes",
  // Added in hermes v0.10.0 (34 → 46)
  "scaffold",
  "bootstrap",
  "deploy",
  "deployment",
  "migrate",
  "migration",
  "integration",
  "performance",
  "regression",
  "pipeline",
  "microservices",
  "workflow",
]);

// Default complex patterns: multi-line code, backticks, URLs, CJK analysis terms
const DEFAULT_COMPLEX_PATTERNS = [
  /\b(architect|algorithm|complexity|performance|security)\b/i,
  /\b(深度|分析|架构|重构|实现|调试)\b/,
  /```/, // any code block
  /\b(vs|compare|difference|tradeoff|pros.cons)\b/i,
];

type SmartRouterConfig = {
  enabled?: boolean;
  fastModel?: string;
  fastProvider?: string;
  simplePatterns?: string[];
  complexPatterns?: string[];
  maxPromptLengthForFast?: number;
  maxPromptWordsForFast?: number;
};

function compilePatterns(raw: string[] | undefined, defaults: RegExp[]): RegExp[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return defaults;
  }
  return raw
    .map((p) => {
      try {
        return new RegExp(p, "i");
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
}

function classifyPrompt(
  prompt: string,
  simplePatterns: RegExp[],
  complexPatterns: RegExp[],
  maxLen: number,
  maxWords: number,
): "fast" | "primary" {
  const trimmed = prompt.trim();

  // Length limit → primary
  if (trimmed.length > maxLen) {
    return "primary";
  }

  // Word count limit → primary
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount > maxWords) {
    return "primary";
  }

  // Multi-line → complex task, primary
  if ((trimmed.match(/\n/g) ?? []).length > 1) {
    return "primary";
  }

  // Any backtick → likely code reference, primary
  if (trimmed.includes("`")) {
    return "primary";
  }

  // Contains URL → primary
  if (/https?:\/\/\S+/.test(trimmed)) {
    return "primary";
  }

  // Check hermes 46-keyword complex vocabulary
  const words = trimmed.toLowerCase().split(/\W+/).filter(Boolean);
  for (const word of words) {
    if (COMPLEX_KEYWORDS.has(word)) {
      return "primary";
    }
  }

  // Complex pattern → primary (takes priority over simple patterns)
  for (const pat of complexPatterns) {
    if (pat.test(trimmed)) {
      return "primary";
    }
  }

  // Simple signal → fast
  for (const pat of simplePatterns) {
    if (pat.test(trimmed)) {
      return "fast";
    }
  }

  return "primary";
}

export default definePluginEntry({
  id: "smart-router",
  name: "Smart Model Router",
  description:
    "Routes simple queries to a fast/cheap model and complex queries to the primary model.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as SmartRouterConfig;

    if (cfg.enabled === false) {
      return;
    }

    const fastModel =
      typeof cfg.fastModel === "string" && cfg.fastModel.trim() ? cfg.fastModel.trim() : undefined;
    const fastProvider =
      typeof cfg.fastProvider === "string" && cfg.fastProvider.trim()
        ? cfg.fastProvider.trim()
        : undefined;

    if (!fastModel) {
      api.logger.warn?.(
        "smart-router: fastModel not configured — routing disabled. Set plugins.entries.smart-router.config.fastModel",
      );
      return;
    }

    const maxLen =
      typeof cfg.maxPromptLengthForFast === "number" && cfg.maxPromptLengthForFast > 0
        ? cfg.maxPromptLengthForFast
        : DEFAULT_MAX_PROMPT_LENGTH;

    const maxWords =
      typeof cfg.maxPromptWordsForFast === "number" && cfg.maxPromptWordsForFast > 0
        ? cfg.maxPromptWordsForFast
        : DEFAULT_MAX_PROMPT_WORDS;

    const simplePatterns = compilePatterns(cfg.simplePatterns, DEFAULT_SIMPLE_PATTERNS);
    const complexPatterns = compilePatterns(cfg.complexPatterns, DEFAULT_COMPLEX_PATTERNS);

    api.on("before_model_resolve", (event, _ctx) => {
      const prompt = (event as { prompt?: string }).prompt ?? "";
      const decision = classifyPrompt(prompt, simplePatterns, complexPatterns, maxLen, maxWords);

      if (decision === "fast") {
        api.logger.info?.(
          `smart-router: routing to fast model ${fastModel} (prompt: "${prompt.slice(0, 60)}")`,
        );
        return {
          modelOverride: fastModel,
          ...(fastProvider ? { providerOverride: fastProvider } : {}),
        };
      }

      return undefined;
    });
  },
});
