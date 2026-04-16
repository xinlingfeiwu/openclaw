import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

const DEFAULT_MAX_PROMPT_LENGTH = 800;

// Default simple patterns: short greetings, factual lookups, status questions
const DEFAULT_SIMPLE_PATTERNS = [
  /^(hi|hello|hey|thanks?|thank you|ok|okay|yes|no|sure)[.!?]?\s*$/i,
  /^what('s| is) (the )?(time|date|weather|status)\??$/i,
  /^(translate|翻译)[:\s]/i,
  /^(summarize|summary|sum up)[:\s]/i,
];

// Default complex patterns: deep analysis, coding, architecture, math
const DEFAULT_COMPLEX_PATTERNS = [
  /\b(implement|refactor|architect|design|analyze|debug|review)\b/i,
  /\b(algorithm|complexity|optimize|performance|security)\b/i,
  /\b(深度|分析|架构|重构|实现|调试)\b/,
  /```|`[^`]{20,}`/, // code blocks / inline code
  /\b(vs|compare|difference|tradeoff|pros.cons)\b/i,
];

type SmartRouterConfig = {
  enabled?: boolean;
  fastModel?: string;
  fastProvider?: string;
  simplePatterns?: string[];
  complexPatterns?: string[];
  maxPromptLengthForFast?: number;
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
): "fast" | "primary" {
  const trimmed = prompt.trim();

  // Long prompts → primary
  if (trimmed.length > maxLen) {
    return "primary";
  }

  // Complex signal → primary (takes priority)
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

    const simplePatterns = compilePatterns(cfg.simplePatterns, DEFAULT_SIMPLE_PATTERNS);
    const complexPatterns = compilePatterns(cfg.complexPatterns, DEFAULT_COMPLEX_PATTERNS);

    api.on("before_model_resolve", (event, _ctx) => {
      const prompt = (event as { prompt?: string }).prompt ?? "";
      const decision = classifyPrompt(prompt, simplePatterns, complexPatterns, maxLen);

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
