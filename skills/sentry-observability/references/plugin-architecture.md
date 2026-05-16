# Plugin Architecture

## How the plugin works

The `openclaw-plugin-sentry` plugin hooks into two OpenClaw extension points:

### 1. Diagnostic Events (`onDiagnosticEvent`)

OpenClaw emits diagnostic events when key things happen:

- `model.usage` — after each LLM call (includes tokens, cost, duration)
- `message.processed` — after processing an inbound message
- `webhook.error` — when a channel webhook fails
- `session.stuck` — when a session hasn't progressed

The plugin maps these to Sentry:

- `model.usage` → `Sentry.startInactiveSpan()` with op `ai.chat` and GenAI semantic convention attributes
- `message.processed` → `Sentry.startInactiveSpan()` with op `openclaw.message`
- `webhook.error` / `session.stuck` → `Sentry.captureMessage()`

### 2. Log Transport (`registerLogTransport`)

OpenClaw's internal logging system supports registered transports. The plugin registers one that forwards logs to `Sentry.logger.*` (structured logs API in SDK v10+).

Log format from OpenClaw: numeric keys are positional args, `_meta` contains level/name/date.

- Key `"0"` is typically the subsystem tag (e.g. `{"subsystem":"plugins"}`)
- Key `"1"` is typically the message string

### Module isolation caveat

OpenClaw bundles its code, which means the plugin-sdk and gateway can end up with separate `listeners` Sets for diagnostic events. OpenClaw patches `globalThis.__oc_diag` to share a single listener set across bundles. If this patch is missing (e.g. after an upgrade), diagnostic events won't reach the plugin.

Check for the patch:

```bash
grep "__oc_diag" $(dirname $(which openclaw))/../lib/node_modules/openclaw/dist/plugin-sdk/reply-*.js
grep "__oc_diag" $(dirname $(which openclaw))/../lib/node_modules/openclaw/dist/reply-*.js
```

Both files should reference `globalThis.__oc_diag`. If not, the diagnostic events are siloed.

## Config schema

Plugin config goes under `plugins.entries.sentry.config`:

```typescript
{
  dsn: string;              // Required — Sentry DSN
  environment?: string;     // Default: "production"
  tracesSampleRate?: number; // Default: 1.0 (0.0–1.0)
  enableLogs?: boolean;     // Default: true
}
```

## GenAI span attributes

Model usage spans include these attributes for AI observability:

| Attribute                    | Convention | Example                             |
| ---------------------------- | ---------- | ----------------------------------- |
| `gen_ai.operation.name`      | OTel GenAI | `"chat"`                            |
| `gen_ai.system`              | OTel GenAI | `"amazon-bedrock"`                  |
| `gen_ai.request.model`       | OTel GenAI | `"us.anthropic.claude-opus-4-6-v1"` |
| `gen_ai.usage.input_tokens`  | OTel GenAI | `50000`                             |
| `gen_ai.usage.output_tokens` | OTel GenAI | `2000`                              |
| `openclaw.channel`           | Custom     | `"telegram"`                        |
| `openclaw.session_key`       | Custom     | `"agent:main:main"`                 |
| `openclaw.cost_usd`          | Custom     | `0.35`                              |
| `openclaw.tokens.cache_read` | Custom     | `45000`                             |
