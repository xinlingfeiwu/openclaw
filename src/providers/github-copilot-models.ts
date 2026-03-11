import type { ModelDefinitionConfig } from "../config/types.js";
import { buildCopilotIdeHeaders } from "./github-copilot-headers.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

// Copilot model ids vary by plan/org and can change.
// We keep this list intentionally broad; if a model isn't available Copilot will
// return an error and users can remove it from their config.
const DEFAULT_MODEL_IDS = [
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "gpt-4o",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "o1",
  "o1-mini",
  "o3-mini",
] as const;

export function getDefaultCopilotModelIds(): string[] {
  return [...DEFAULT_MODEL_IDS];
}

function isCopilotModelAvailable(model: unknown): model is {
  id: string;
  model_picker_enabled?: boolean;
  policy?: { state?: string };
} {
  if (!model || typeof model !== "object") {
    return false;
  }
  const asRecord = model as Record<string, unknown>;
  if (typeof asRecord.id !== "string" || asRecord.id.trim().length === 0) {
    return false;
  }
  if (asRecord.model_picker_enabled === false) {
    return false;
  }
  const policy = asRecord.policy;
  if (policy && typeof policy === "object") {
    const state = (policy as Record<string, unknown>).state;
    if (typeof state === "string" && state !== "enabled") {
      return false;
    }
  }
  return true;
}

export async function discoverCopilotModelIds(params: {
  token: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const token = params.token.trim();
  const baseUrl = params.baseUrl.trim().replace(/\/+$/, "");
  if (!token) {
    throw new Error("Copilot token required");
  }
  if (!baseUrl) {
    throw new Error("Copilot base URL required");
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const res = await fetchImpl(`${baseUrl}/models`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...buildCopilotIdeHeaders(),
    },
  });
  if (!res.ok) {
    throw new Error(`Copilot model discovery failed: HTTP ${res.status}`);
  }

  const json = (await res.json()) as { data?: unknown };
  if (!Array.isArray(json.data)) {
    throw new Error("Copilot model discovery response missing data array");
  }

  const modelIds = new Set<string>();
  for (const model of json.data) {
    if (!isCopilotModelAvailable(model)) {
      continue;
    }
    modelIds.add(model.id.trim());
  }
  return [...modelIds];
}

// Claude and Gemini models on GitHub Copilot only support the chat completions
// endpoint (/v1/chat/completions), not the Responses API (/v1/responses).
// GPT/OpenAI models support both; we prefer Responses API for those.
function copilotModelApi(modelId: string): "openai-responses" | "openai-completions" {
  if (modelId.startsWith("claude-") || modelId.startsWith("gemini-")) {
    return "openai-completions";
  }
  return "openai-responses";
}

export function buildCopilotModelDefinition(modelId: string): ModelDefinitionConfig {
  const id = modelId.trim();
  if (!id) {
    throw new Error("Model id required");
  }
  return {
    id,
    name: id,
    // pi-coding-agent's registry schema doesn't know about a "github-copilot" API.
    // We keep the provider id as "github-copilot" so pi-ai attaches Copilot-specific
    // headers. The api field selects the endpoint: Claude/Gemini models use chat
    // completions; GPT/OpenAI models use the Responses API.
    api: copilotModelApi(id),
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    headers: buildCopilotIdeHeaders(),
  };
}
