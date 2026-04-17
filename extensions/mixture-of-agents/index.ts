import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// MoA: parallel multi-model reasoning + aggregation synthesis.
// Use sparingly — costs 3-5x tokens vs a single call.
// Inspired by hermes-agent tools/mixture_of_agents_tool.py

// Strip control characters and hard-limit size to prevent injection from rogue reference models.
function sanitizeModelResponse(text: string): string {
  // eslint-disable-next-line no-control-regex -- intentionally stripping C0 control chars except \t(9)\n(10)\r(13)
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, 50_000);
}

type MixtureOfAgentsConfig = {
  enabled?: boolean;
  /** Reference models to query in parallel. Each entry: "provider/model" */
  referenceModels?: string[];
  /** Aggregator model for synthesis. Default: primary model */
  aggregatorProvider?: string;
  aggregatorModel?: string;
  /** Timeout per reference model in ms. Default: 60000 */
  referenceTimeoutMs?: number;
  /** Timeout for aggregation in ms. Default: 90000 */
  aggregatorTimeoutMs?: number;
};

function collectText(payloads: Array<{ text?: string; isError?: boolean }> | undefined): string {
  return (payloads ?? [])
    .filter((p) => !p.isError && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
}

function makeTmpDir(): string {
  const base = process.env.OPENCLAW_TMP ?? os.tmpdir();
  return mkdtempSync(path.join(base, "openclaw-moa-"));
}

export default definePluginEntry({
  id: "mixture-of-agents",
  name: "Mixture of Agents",
  description:
    "Multi-provider reasoning synthesizer. Use sparingly for genuinely difficult analysis — queries multiple models in parallel and synthesizes their responses. Costs 3-5x more than a single call.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as MixtureOfAgentsConfig;
    if (cfg.enabled === false) {
      return;
    }

    const defaultReferenceModels = ["github-copilot/gpt-4.1", "deepseek/deepseek-chat"];

    const referenceModels: Array<{ provider: string; model: string }> = (
      Array.isArray(cfg.referenceModels) && cfg.referenceModels.length > 0
        ? cfg.referenceModels
        : defaultReferenceModels
    )
      .map((m) => {
        const parts = m.split("/");
        return { provider: parts[0] ?? "unknown", model: parts.slice(1).join("/") };
      })
      .filter((m) => m.provider && m.model);

    const aggProvider =
      typeof cfg.aggregatorProvider === "string" && cfg.aggregatorProvider.trim()
        ? cfg.aggregatorProvider.trim()
        : undefined;
    const aggModel =
      typeof cfg.aggregatorModel === "string" && cfg.aggregatorModel.trim()
        ? cfg.aggregatorModel.trim()
        : undefined;
    const refTimeout = cfg.referenceTimeoutMs ?? 60_000;
    const aggTimeout = cfg.aggregatorTimeoutMs ?? 90_000;

    api.registerTool(
      {
        name: "mixture_of_agents",
        label: "Mixture of Agents",
        description:
          "Query multiple AI models in parallel on a hard problem and synthesize their responses into a single high-quality answer. Use SPARINGLY — only for genuinely complex, high-stakes analysis where multiple perspectives add real value. Costs 3-5x more than a single model call.",
        parameters: Type.Object({
          prompt: Type.String({
            description:
              "The analysis question or task to send to all reference models. Be specific and complete — this exact prompt is sent to each model.",
          }),
          context: Type.Optional(
            Type.String({
              description:
                "Optional additional context (code, data, background) to include with the prompt.",
            }),
          ),
        }),
        async execute(_toolCallId, params, _signal) {
          const p = params as { prompt: string; context?: string };
          if (!p.prompt?.trim()) {
            return {
              details: null as unknown,
              content: [{ type: "text" as const, text: "Error: prompt is required" }],
            };
          }

          const fullPrompt = p.context?.trim()
            ? `${p.prompt.trim()}\n\nContext:\n${p.context.trim()}`
            : p.prompt.trim();

          api.logger.info?.(
            `mixture-of-agents: querying ${referenceModels.length} reference models in parallel`,
          );

          // Run all reference models in parallel
          const refPromises = referenceModels.map(async ({ provider, model }) => {
            const tmpDir = makeTmpDir();
            try {
              const result = await api.runtime.agent.runEmbeddedPiAgent({
                sessionId: `moa-ref-${provider}-${model}-${Date.now()}`,
                sessionFile: path.join(tmpDir, "session.json"),
                workspaceDir: api.config?.agents?.defaults?.workspace ?? process.cwd(),
                config: api.config,
                prompt: fullPrompt,
                timeoutMs: refTimeout,
                runId: `moa-${Date.now()}`,
                provider,
                model,
                disableTools: true,
              } as Parameters<typeof api.runtime.agent.runEmbeddedPiAgent>[0]);
              const text = collectText(
                typeof result === "object" && result !== null && "payloads" in result
                  ? (result as { payloads?: Array<{ text?: string; isError?: boolean }> }).payloads
                  : undefined,
              );
              return { provider, model, text, error: null };
            } catch (e) {
              return { provider, model, text: "", error: String(e) };
            } finally {
              try {
                rmSync(tmpDir, { recursive: true, force: true });
              } catch {}
            }
          });

          const refResults = await Promise.all(refPromises);
          const successful = refResults.filter((r) => r.text && !r.error);

          if (successful.length === 0) {
            const errors = refResults.map((r) => `${r.provider}/${r.model}: ${r.error}`).join("\n");
            return {
              details: null as unknown,
              content: [{ type: "text" as const, text: `All reference models failed:\n${errors}` }],
            };
          }

          api.logger.info?.(
            `mixture-of-agents: got ${successful.length}/${referenceModels.length} responses, aggregating`,
          );

          // Build aggregation prompt — sanitize model responses to prevent injection
          const refSection = successful
            .map(
              (r, i) =>
                `## Response ${i + 1} (${r.provider}/${r.model})\n\n${sanitizeModelResponse(r.text ?? "")}`,
            )
            .join("\n\n---\n\n");

          const aggregationPrompt =
            `You are synthesizing multiple AI model responses to produce the best possible answer.\n\n` +
            `Original question:\n${fullPrompt}\n\n` +
            `---\n\n` +
            `Reference responses:\n\n${refSection}\n\n` +
            `---\n\n` +
            `Synthesize the above responses into a single comprehensive, accurate, and well-structured answer. ` +
            `Identify areas of agreement, resolve conflicts by reasoning carefully, and incorporate the best insights from each response. ` +
            `Do not simply concatenate — produce a unified, coherent answer.`;

          // Use aggregator (or fall back to primary model)
          const defaultsModel = api.config?.agents?.defaults?.model;
          const primaryRaw =
            typeof defaultsModel === "string"
              ? defaultsModel
              : typeof defaultsModel === "object" &&
                  defaultsModel !== null &&
                  "primary" in defaultsModel
                ? (defaultsModel as { primary?: unknown }).primary
                : undefined;
          const primary = typeof primaryRaw === "string" ? primaryRaw : "";
          const primaryParts = primary.split("/");
          const resolvedAggProvider = aggProvider ?? primaryParts[0] ?? "github-copilot";
          const resolvedAggModel = aggModel ?? primaryParts.slice(1).join("/") ?? "gpt-5.4";

          const aggTmpDir = makeTmpDir();
          try {
            const aggResult = await api.runtime.agent.runEmbeddedPiAgent({
              sessionId: `moa-agg-${Date.now()}`,
              sessionFile: path.join(aggTmpDir, "session.json"),
              workspaceDir: api.config?.agents?.defaults?.workspace ?? process.cwd(),
              config: api.config,
              prompt: aggregationPrompt,
              timeoutMs: aggTimeout,
              runId: `moa-agg-${Date.now()}`,
              provider: resolvedAggProvider,
              model: resolvedAggModel,
              disableTools: true,
            } as Parameters<typeof api.runtime.agent.runEmbeddedPiAgent>[0]);

            const synthesized = collectText(
              typeof aggResult === "object" && aggResult !== null && "payloads" in aggResult
                ? (aggResult as { payloads?: Array<{ text?: string; isError?: boolean }> }).payloads
                : undefined,
            );

            if (!synthesized) {
              // Fall back to best reference response
              const best = successful[0];
              return {
                details: null as unknown,
                content: [
                  {
                    type: "text" as const,
                    text: `[Aggregation failed, showing best reference response from ${best.provider}/${best.model}]\n\n${best.text}`,
                  },
                ],
              };
            }

            return {
              details: null as unknown,
              content: [{ type: "text" as const, text: synthesized }],
            };
          } finally {
            try {
              rmSync(aggTmpDir, { recursive: true, force: true });
            } catch {}
          }
        },
      },
      { name: "mixture_of_agents" },
    );
  },
});
