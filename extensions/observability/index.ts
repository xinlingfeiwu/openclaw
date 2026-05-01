import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

type ObservabilityConfig = {
  enabled?: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  sampleRate?: number;
  maxChars?: number;
};

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";
const DEFAULT_MAX_CHARS = 12_000;

// Minimal Langfuse interface — avoids hard runtime dependency on the langfuse npm package.
// The actual object is obtained via dynamic import; if the package is absent, all hooks are inert.
type LangfuseTrace = {
  id: string;
  generation(opts: Record<string, unknown>): LangfuseGeneration;
  span(opts: Record<string, unknown>): LangfuseSpan;
  update(opts: Record<string, unknown>): void;
};
type LangfuseGeneration = { id: string; end(opts: Record<string, unknown>): void };
type LangfuseSpan = { id: string; end(opts: Record<string, unknown>): void };
type LangfuseInstance = {
  trace(opts: Record<string, unknown>): LangfuseTrace;
  flushAsync(): Promise<void>;
};

function truncate(value: unknown, maxChars: number): string {
  const str = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return str.length > maxChars ? str.slice(0, maxChars) + "…[truncated]" : str;
}

function makeSessionKey(ctx: unknown): string {
  return (
    (ctx as { sessionId?: string }).sessionId ?? (ctx as { agentId?: string }).agentId ?? "default"
  );
}

// Per-session trace state — keyed by session key
type TraceState = {
  traceId: string;
  activeGenerationId?: string;
  activeSpanIds: Map<string, string>; // toolCallId → spanId
  langfuse: LangfuseInstance;
  trace: LangfuseTrace;
  [key: string]: unknown; // for dynamic span/generation storage
};

const activeSessions = new Map<string, TraceState>();

export default definePluginEntry({
  id: "observability",
  name: "Observability (Langfuse)",
  description:
    "Traces OpenClaw conversations, LLM calls, and tool usage to Langfuse. Fail-open: inert when 'langfuse' npm package is missing or credentials are not configured. Inspired by hermes-agent/plugins/observability/langfuse.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as ObservabilityConfig;
    if (cfg.enabled === false) {
      return;
    }

    const publicKey = cfg.publicKey ?? process.env["OPENCLAW_LANGFUSE_PUBLIC_KEY"] ?? "";
    const secretKey = cfg.secretKey ?? process.env["OPENCLAW_LANGFUSE_SECRET_KEY"] ?? "";
    const baseUrl = cfg.baseUrl ?? process.env["OPENCLAW_LANGFUSE_BASE_URL"] ?? DEFAULT_BASE_URL;

    if (!publicKey || !secretKey) {
      api.logger.info?.("observability: no Langfuse credentials configured — tracing disabled");
      return;
    }

    const sampleRate =
      typeof cfg.sampleRate === "number" && cfg.sampleRate >= 0 && cfg.sampleRate <= 1
        ? cfg.sampleRate
        : 1.0;
    const maxChars =
      typeof cfg.maxChars === "number" && cfg.maxChars > 0 ? cfg.maxChars : DEFAULT_MAX_CHARS;

    // Lazily load the langfuse SDK via Function-based dynamic import to bypass TypeScript's
    // static module resolution. This keeps langfuse as a truly optional runtime dependency.
    let langfusePromise: Promise<LangfuseInstance | null> | null = null;
    function getLangfuse(): Promise<LangfuseInstance | null> {
      if (!langfusePromise) {
        langfusePromise = (
          new Function('return import("langfuse")')() as Promise<Record<string, unknown>>
        )
          .then((mod) => {
            const LangfuseClass = (mod["Langfuse"] ?? mod["default"]) as new (
              opts: Record<string, unknown>,
            ) => LangfuseInstance;
            return new LangfuseClass({
              publicKey,
              secretKey,
              baseUrl,
              flushAt: 10,
              flushInterval: 5000,
            });
          })
          .catch((err: unknown) => {
            api.logger.warn?.(
              `observability: langfuse package not available — tracing disabled (${String(err)})`,
            );
            return null;
          });
      }
      return langfusePromise;
    }

    function shouldSample(): boolean {
      return sampleRate >= 1.0 || Math.random() < sampleRate;
    }

    // Lazily ensure a trace exists for the session (called on first model_call_started).
    async function ensureTrace(ctx: unknown): Promise<TraceState | null> {
      const sessionKey = makeSessionKey(ctx);
      if (activeSessions.has(sessionKey)) {
        return activeSessions.get(sessionKey)!;
      }
      if (!shouldSample()) {
        return null;
      }
      const lf = await getLangfuse();
      if (!lf) {
        return null;
      }
      const agentId = (ctx as { agentId?: string }).agentId ?? "unknown";
      const trace = lf.trace({
        name: `openclaw:${agentId}`,
        metadata: {
          agentId,
          sessionKey,
          channelId: (ctx as { channelId?: string }).channelId,
        },
      });
      const state: TraceState = {
        traceId: trace.id,
        activeSpanIds: new Map(),
        langfuse: lf,
        trace,
      };
      activeSessions.set(sessionKey, state);
      return state;
    }

    // Open a Langfuse generation when LLM call starts (also lazily opens the trace).
    api.on("model_call_started", async (event, ctx) => {
      const session = await ensureTrace(ctx);
      if (!session) {
        return;
      }
      const ev = event as { callId?: string; model?: string; provider?: string };
      const generation = session.trace.generation({
        id: ev.callId,
        name: `llm:${ev.model ?? "unknown"}`,
        model: ev.model,
        metadata: { provider: ev.provider },
        startTime: new Date(),
      });
      session.activeGenerationId = generation.id;
      session[`_gen:${ev.callId ?? "default"}`] = generation;
    });

    // Close the generation when LLM call ends.
    api.on("model_call_ended", async (event, ctx) => {
      const sessionKey = makeSessionKey(ctx);
      const session = activeSessions.get(sessionKey);
      if (!session) {
        return;
      }
      const ev = event as {
        callId?: string;
        durationMs?: number;
        outcome?: string;
        errorCategory?: string;
        requestPayloadBytes?: number;
        responseStreamBytes?: number;
      };
      const generation = session[`_gen:${ev.callId ?? "default"}`] as
        | LangfuseGeneration
        | undefined;
      if (!generation) {
        return;
      }
      generation.end({
        endTime: new Date(),
        statusMessage: ev.outcome === "error" ? (ev.errorCategory ?? "error") : undefined,
        level: ev.outcome === "error" ? "ERROR" : "DEFAULT",
        metadata: {
          durationMs: ev.durationMs,
          requestBytes: ev.requestPayloadBytes,
          responseBytes: ev.responseStreamBytes,
        },
      });
      delete session[`_gen:${ev.callId ?? "default"}`];
    });

    // Open a span when a tool call starts.
    api.on("before_tool_call", async (event, ctx) => {
      const sessionKey = makeSessionKey(ctx);
      const session = activeSessions.get(sessionKey);
      if (!session) {
        return undefined;
      }
      const ev = event as { toolName?: string; params?: unknown; toolCallId?: string };
      const toolCallId = ev.toolCallId ?? ev.toolName ?? "unknown";

      const span = session.trace.span({
        name: `tool:${ev.toolName ?? "unknown"}`,
        input: truncate(ev.params, maxChars),
        startTime: new Date(),
      });
      session.activeSpanIds.set(toolCallId, span.id);
      session[`_span:${toolCallId}`] = span;

      return undefined;
    });

    // Close the span after a tool call finishes.
    api.on("after_tool_call", async (event, ctx) => {
      const sessionKey = makeSessionKey(ctx);
      const session = activeSessions.get(sessionKey);
      if (!session) {
        return;
      }
      const ev = event as {
        toolName?: string;
        toolCallId?: string;
        result?: unknown;
        error?: string;
        durationMs?: number;
      };
      const toolCallId = ev.toolCallId ?? ev.toolName ?? "unknown";
      const span = session[`_span:${toolCallId}`] as LangfuseSpan | undefined;
      if (!span) {
        return;
      }
      span.end({
        endTime: new Date(),
        output: ev.error ? undefined : truncate(ev.result, maxChars),
        statusMessage: ev.error ? truncate(ev.error, 1000) : undefined,
        level: ev.error ? "ERROR" : "DEFAULT",
        metadata: { durationMs: ev.durationMs },
      });
      session.activeSpanIds.delete(toolCallId);
      delete session[`_span:${toolCallId}`];
    });

    // End the trace and flush when the agent ends.
    api.on("agent_end", async (event, ctx) => {
      const sessionKey = makeSessionKey(ctx);
      const session = activeSessions.get(sessionKey);
      if (!session) {
        return;
      }
      const ev = event as { success?: boolean; error?: string };
      try {
        session.trace.update({
          output: ev.success === false ? truncate(ev.error ?? "failed", maxChars) : undefined,
          metadata: { success: ev.success !== false },
        });
        await session.langfuse.flushAsync();
      } catch (e) {
        api.logger.warn?.(`observability: flush error: ${String(e)}`);
      } finally {
        activeSessions.delete(sessionKey);
      }
    });
  },
});
