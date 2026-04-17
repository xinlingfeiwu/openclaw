import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_CONTEXT_CHARS = 8_000;
const DEFAULT_FILE_READ_TOOLS = ["read_file", "view", "cat", "read", "str_replace_editor"];

// Context file names to look for, in priority order (first match wins per directory)
const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules"];

type SubdirectoryHintsConfig = {
  enabled?: boolean;
  maxDepth?: number;
  maxContextChars?: number;
  fileReadTools?: string[];
};

/**
 * Walk ancestor directories up to maxDepth levels looking for a context file.
 * Returns { filePath, content } for the first match found, or null.
 */
function findContextFile(
  startDir: string,
  maxDepth: number,
): { filePath: string; content: string } | null {
  let dir = resolve(startDir);
  for (let depth = 0; depth < maxDepth; depth++) {
    for (const name of CONTEXT_FILES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        try {
          const content = readFileSync(candidate, "utf8");
          return { filePath: candidate, content };
        } catch {
          // Skip unreadable file
        }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    } // Reached filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Extract the directory of a file path mentioned in tool parameters.
 * Handles both plain strings and JSON argument objects with common path keys.
 */
function extractDir(toolParams: unknown): string | null {
  let filePath: string | null = null;

  if (typeof toolParams === "string") {
    filePath = toolParams;
  } else if (toolParams && typeof toolParams === "object") {
    const p = toolParams as Record<string, unknown>;
    for (const key of ["path", "file_path", "filename", "file", "filepath"]) {
      if (typeof p[key] === "string") {
        filePath = p[key];
        break;
      }
    }
  }

  if (!filePath) {
    return null;
  }

  // Only handle absolute paths or paths that look like real file paths
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.startsWith("-")) {
    return null;
  }

  try {
    return dirname(resolve(trimmed));
  } catch {
    return null;
  }
}

export default definePluginEntry({
  id: "subdirectory-hints",
  name: "Subdirectory Hints",
  description:
    "Lazy AGENTS.md/CLAUDE.md/.cursorrules context injection. When the agent reads a file, discovers and silently appends context files from the directory and its ancestors. Deduplicates per session. Ported from hermes-agent/tools/subdirectory_hints.py.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as SubdirectoryHintsConfig;
    if (cfg.enabled === false) {
      return;
    }

    const maxDepth =
      typeof cfg.maxDepth === "number" && cfg.maxDepth > 0 ? cfg.maxDepth : DEFAULT_MAX_DEPTH;

    const maxContextChars =
      typeof cfg.maxContextChars === "number" && cfg.maxContextChars > 0
        ? cfg.maxContextChars
        : DEFAULT_MAX_CONTEXT_CHARS;

    const fileReadTools = Array.isArray(cfg.fileReadTools)
      ? cfg.fileReadTools
      : DEFAULT_FILE_READ_TOOLS;

    // toolCallId → dirPath (pending lookups from before_tool_call)
    const pendingLookups = new Map<string, string>();
    // Directories whose context file has already been injected this session
    const loadedDirs = new Set<string>();

    api.on("before_tool_call", (event, ctx) => {
      const ev = event as { toolName?: string; params?: unknown };
      const toolName = ev.toolName ?? ctx.toolName;
      if (!fileReadTools.includes(toolName ?? "")) {
        return;
      }

      const dir = extractDir(ev.params);
      if (!dir) {
        return;
      }

      if (ctx.toolCallId) {
        pendingLookups.set(ctx.toolCallId, dir);
      }
    });

    api.on("tool_result_persist", (event, ctx) => {
      const toolCallId = ctx.toolCallId;
      if (!toolCallId) {
        return undefined;
      }

      const dir = pendingLookups.get(toolCallId);
      pendingLookups.delete(toolCallId);
      if (!dir) {
        return undefined;
      }

      // Check if this directory chain has already been injected
      if (loadedDirs.has(dir)) {
        return undefined;
      }

      const found = findContextFile(dir, maxDepth);
      if (!found) {
        return undefined;
      }

      // Mark the directory of the found context file as loaded
      const contextDir = dirname(found.filePath);
      if (loadedDirs.has(contextDir)) {
        return undefined;
      }
      loadedDirs.add(dir);
      loadedDirs.add(contextDir);

      // Truncate if needed
      const content =
        found.content.length > maxContextChars
          ? found.content.slice(0, maxContextChars) +
            `\n[... truncated at ${maxContextChars} chars]`
          : found.content;

      const suffix = `\n\n[📁 Context from ${found.filePath}]\n${content}`;

      // Build new message with appended context (AgentMessage union — handle via runtime shape)
      const msg = event.message as unknown as Record<string, unknown>;
      let newMessage: unknown;
      if (typeof msg.content === "string") {
        newMessage = { ...msg, content: msg.content + suffix };
      } else if (Array.isArray(msg.content)) {
        // Append a text block
        newMessage = {
          ...msg,
          content: [...msg.content, { type: "text", text: suffix.trim() }],
        };
      } else {
        // Unknown shape — skip injection
        return undefined;
      }

      api.logger.info?.(
        `subdirectory-hints: injected context from ${found.filePath} (${content.length} chars)`,
      );
      return { message: newMessage as import("@mariozechner/pi-agent-core").AgentMessage };
    });
  },
});
