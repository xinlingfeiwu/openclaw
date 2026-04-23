import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { expandHomePrefix } from "openclaw/plugin-sdk/infra-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

const DEFAULT_WATCH_TOOLS = new Set([
  "str_replace_based_edit_tool",
  "write_file",
  "create_file",
  "edit",
  "create",
]);

type CheckpointConfig = {
  enabled?: boolean;
  checkpointsDir?: string;
  maxCheckpointsPerSession?: number;
  watchTools?: string[];
};

type CheckpointEntry = {
  sessionId: string;
  toolName: string;
  filePath: string;
  originalContent: string;
  savedAt: string;
  checkpointFile: string;
};

function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function extractFilePath(params: Record<string, unknown>): string {
  return ((params.path ?? params.file_path ?? params.filename ?? "") as string).trim();
}

export default definePluginEntry({
  id: "checkpoint-rollback",
  name: "Checkpoint & Rollback",
  description: "Saves file originals before destructive edits to ~/.openclaw/checkpoints/.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as CheckpointConfig;
    if (cfg.enabled === false) {
      return;
    }

    const checkpointsDir = expandHomePrefix(
      typeof cfg.checkpointsDir === "string" && cfg.checkpointsDir.trim()
        ? cfg.checkpointsDir
        : "~/.openclaw/checkpoints",
    );

    const maxCheckpoints =
      typeof cfg.maxCheckpointsPerSession === "number" && cfg.maxCheckpointsPerSession > 0
        ? cfg.maxCheckpointsPerSession
        : 50;

    const watchTools =
      Array.isArray(cfg.watchTools) && cfg.watchTools.length > 0
        ? new Set(cfg.watchTools)
        : DEFAULT_WATCH_TOOLS;

    // Per-session checkpoint counter
    const sessionCounters = new Map<string, number>();

    api.on("before_tool_call", (event, ctx) => {
      const ev = event as {
        toolName?: string;
        params?: Record<string, unknown>;
      };
      const toolName = ev.toolName ?? ctx.toolName ?? "";
      if (!watchTools.has(toolName)) {
        return undefined;
      }

      const params = ev.params ?? {};
      const filePath = extractFilePath(params);
      if (!filePath) {
        return undefined;
      }

      const absPath = resolve(filePath);
      const original = readFileSafe(absPath);
      if (original === null) {
        // File doesn't exist yet — nothing to checkpoint
        return undefined;
      }

      const sessionId = ctx.sessionId ?? ctx.agentId ?? "default";
      const count = sessionCounters.get(sessionId) ?? 0;
      if (count >= maxCheckpoints) {
        api.logger.warn?.(
          `checkpoint-rollback: max checkpoints (${maxCheckpoints}) reached for session ${sessionId}, skipping`,
        );
        return undefined;
      }
      sessionCounters.set(sessionId, count + 1);

      // Save checkpoint: checkpointsDir/<sessionId>/<timestamp>-<basename>
      const sessionDir = join(checkpointsDir, sessionId);
      if (!existsSync(sessionDir)) {
        mkdirSync(sessionDir, { recursive: true });
      }

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const checkpointFile = join(sessionDir, `${ts}-${basename(absPath)}`);

      const entry: CheckpointEntry = {
        sessionId,
        toolName,
        filePath: absPath,
        originalContent: original,
        savedAt: new Date().toISOString(),
        checkpointFile,
      };

      try {
        // Save original file content
        writeFileSync(checkpointFile, original);
        // Save manifest entry alongside
        const manifestPath = join(sessionDir, "manifest.jsonl");
        const { originalContent: _, ...manifestEntry } = entry;
        writeFileSync(
          manifestPath,
          readFileSafe(manifestPath)?.concat(JSON.stringify(manifestEntry) + "\n") ??
            JSON.stringify(manifestEntry) + "\n",
        );
        api.logger.info?.(
          `checkpoint-rollback: saved checkpoint for "${basename(absPath)}" → ${checkpointFile}`,
        );
      } catch (e) {
        api.logger.warn?.(`checkpoint-rollback: failed to save checkpoint: ${String(e)}`);
      }

      return undefined; // Don't block the tool call
    });
  },
});
