# OpenClaw Copilot Instructions

## Build, Test, and Lint

```bash
# Install dependencies
pnpm install

# Type-check and build
pnpm build

# Lint and format
pnpm check              # runs tsc + oxlint + oxfmt
pnpm lint:fix           # auto-fix lint issues

# Run all tests
pnpm test

# Run a single test file
pnpm test src/utils.test.ts

# Run tests matching a pattern
pnpm test -t "pattern"

# Watch mode
pnpm test:watch

# Coverage
pnpm test:coverage

# Live tests (requires API keys)
OPENCLAW_LIVE_TEST=1 pnpm test:live

# E2E tests
pnpm test:e2e
```

Run the full gate before committing: `pnpm build && pnpm check && pnpm test`

## Architecture Overview

OpenClaw is a multi-channel AI gateway that connects messaging platforms (WhatsApp, Telegram, Discord, Slack, Signal, iMessage) to AI providers. It runs as a CLI with an optional macOS menubar app.

### Core Components

- **Gateway** (`src/gateway/`): HTTP/WebSocket server that bridges messaging channels to AI agents
- **Channels** (`src/telegram/`, `src/discord/`, `src/slack/`, `src/signal/`, `src/imessage/`, `src/web/`): Platform-specific adapters
- **Routing** (`src/routing/`): Message routing, allowlists, and pairing logic
- **Agents** (`src/agents/`): AI provider integrations and tool definitions
- **CLI** (`src/cli/`, `src/commands/`): Commander-based CLI wiring
- **Plugin SDK** (`src/plugin-sdk/`): Extension API for third-party plugins

### Multi-Platform Apps

- **macOS** (`apps/macos/`): SwiftUI menubar app wrapping the gateway
- **iOS** (`apps/ios/`): SwiftUI mobile client
- **Android** (`apps/android/`): Kotlin/Compose mobile client
- **Shared** (`apps/shared/`): Cross-platform Swift package (OpenClawKit)

### Extensions

Plugins live under `extensions/*` as workspace packages. Each has its own `package.json`. Runtime deps go in `dependencies`; avoid `workspace:*` in dependencies.

## Key Conventions

### TypeScript Style

- ESM modules with strict typing; avoid `any`
- Formatting via Oxlint + Oxfmt (not Prettier/ESLint)
- Tests colocated as `*.test.ts`; E2E tests as `*.e2e.test.ts`
- Keep files under ~500-700 LOC; split when it improves clarity

### CLI Patterns

- Use `src/cli/progress.ts` for spinners/progress bars (wraps `osc-progress` + `@clack/prompts`)
- Use `src/terminal/table.ts` for status output tables
- Use `src/terminal/palette.ts` for colors (no hardcoded ANSI)
- Dependency injection via `createDefaultDeps` pattern

### Naming

- **OpenClaw** for product/docs headings
- **openclaw** for CLI command, package name, paths, config keys

### Channel Changes

When modifying routing, allowlists, pairing, command gating, or onboarding, consider all channels:

- Core: Telegram, Discord, Slack, Signal, iMessage, WhatsApp (web)
- Extensions: MS Teams, Matrix, Zalo, voice-call, etc.

### SwiftUI (iOS/macOS)

Prefer `@Observable`/`@Bindable` (Observation framework) over `ObservableObject`/`@StateObject`.

### Tool Schemas

- Avoid `Type.Union`, `anyOf`/`oneOf`/`allOf` in tool input schemas
- Use `stringEnum`/`optionalStringEnum` for string enums
- Avoid `format` as a property name (reserved in some validators)

### Documentation

- Docs hosted on Mintlify at docs.openclaw.ai
- Internal links: root-relative, no `.md` extension (e.g., `[Config](/configuration)`)
- Avoid em dashes and apostrophes in headings (breaks anchor links)

## Commit Guidelines

- Use `scripts/committer "<msg>" <file...>` to commit (keeps staging scoped)
- Action-oriented messages: `CLI: add verbose flag to send`
- Add changelog entries for user-facing changes (reference PR/issue number)
