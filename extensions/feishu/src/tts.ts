/**
 * PluginTtsEngine — 插件级 TTS 引擎
 * 将文本转换为语音文件，用于 /tts on 时将 payload.text 转换为语音消息
 *
 * 后端优先级：
 * 1. IndexTTS-2（Gradio API，零样本声音克隆，高质量中文语音）
 * 2. macOS `say` 命令（内置 Tingting 中文语音，低延迟 fallback）
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AudioConverter } from "./audio.js";

export type TtsResult = {
  /** Path to opus file ready for Feishu upload */
  opusPath: string;
  /** Duration in milliseconds */
  durationMs: number;
};

export type TtsConfig = {
  /** TTS backend: "indextts" (default) or "say" (macOS built-in) */
  backend?: "indextts" | "say";
  /** IndexTTS-2 Gradio API base URL (default: http://localhost:7860) */
  indexTtsUrl?: string;
  /** Path to voice reference audio for IndexTTS-2 voice cloning */
  referenceAudio?: string;
  /** macOS say voice name (fallback, default: "Tingting" for zh_CN) */
  voice?: string;
  /** Speech rate for macOS say (words per minute) */
  rate?: number;
};

type LogFn = (msg: string) => void;

const TMP_DIR = path.join(os.tmpdir(), "openclaw-feishu-tts");

/**
 * Strip markdown formatting to produce clean text for TTS.
 */
function stripMarkdownForTts(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^[-*_]{3,}$/gm, "")
    .replace(/^[\s]*[-*+]\s+/gm, "")
    .replace(/^[\s]*\d+\.\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ────────────────────────────────────────
// IndexTTS-2 Backend (Gradio 5.x API)
// ────────────────────────────────────────

class IndexTtsBackend {
  private baseUrl: string;
  private referenceAudio: string;
  private log: LogFn;
  private errorLog: LogFn;
  /** Cached Gradio upload path for reference audio */
  private uploadedRefPath: string | null = null;

  constructor(params: { baseUrl: string; referenceAudio: string; log: LogFn; error: LogFn }) {
    this.baseUrl = params.baseUrl.replace(/\/$/, "");
    this.referenceAudio = params.referenceAudio;
    this.log = params.log;
    this.errorLog = params.error;
  }

  /** Check if IndexTTS-2 server is reachable */
  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/gradio_api/info`, {
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Upload reference audio to Gradio server (cached after first upload).
   */
  private async ensureReferenceUploaded(): Promise<string | null> {
    if (this.uploadedRefPath) return this.uploadedRefPath;

    try {
      const fileData = await fs.readFile(this.referenceAudio);
      const fileName = path.basename(this.referenceAudio);
      const blob = new Blob([fileData]);
      const formData = new FormData();
      formData.append("files", blob, fileName);

      const resp = await fetch(`${this.baseUrl}/gradio_api/upload`, {
        method: "POST",
        body: formData,
      });
      if (!resp.ok) {
        this.errorLog(`[IndexTTS] upload failed: ${resp.status}`);
        return null;
      }

      const paths = (await resp.json()) as string[];
      if (!paths.length) return null;

      this.uploadedRefPath = paths[0];
      this.log(`[IndexTTS] reference audio uploaded: ${this.uploadedRefPath}`);
      return this.uploadedRefPath;
    } catch (err) {
      this.errorLog(`[IndexTTS] upload error: ${String(err)}`);
      return null;
    }
  }

  /**
   * Synthesize text using IndexTTS-2 API.
   * @returns local path to generated WAV file, or null on failure
   */
  async synthesize(text: string): Promise<string | null> {
    const refPath = await this.ensureReferenceUploaded();
    if (!refPath) return null;

    // Start generation via Gradio queue API
    const callResp = await fetch(`${this.baseUrl}/gradio_api/call/gen_single`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [
          "Use emotion vectors",
          { path: refPath, meta: { _type: "gradio.FileData" } },
          text,
          null, // emo_ref_path
          0.85, // emo_weight (strong emotion expression)
          // emotion vectors: Happy, Angry, Sad, Afraid, Disgusted, Melancholic, Surprised, Calm
          0.45,
          0,
          0,
          0,
          0,
          0.5,
          0.2,
          0.6,
          "", // emo_text
          false, // emo_random
          120, // max_text_tokens_per_segment
          // generation params
          true, // do_sample
          0.8, // top_p
          30, // top_k
          0.8, // temperature
          0.0, // length_penalty
          3, // num_beams
          10.0, // repetition_penalty
          1500, // max_mel_tokens
        ],
      }),
    });
    if (!callResp.ok) {
      this.errorLog(`[IndexTTS] call failed: ${callResp.status}`);
      return null;
    }

    const { event_id } = (await callResp.json()) as { event_id: string };
    this.log(`[IndexTTS] generation started: event_id=${event_id}`);

    // Poll SSE endpoint for completion
    return await this.pollResult(event_id);
  }

  /**
   * Poll SSE stream for generation result.
   * IndexTTS-2 typically takes 10-60s depending on text length.
   */
  private async pollResult(eventId: string): Promise<string | null> {
    const url = `${this.baseUrl}/gradio_api/call/gen_single/${eventId}`;

    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(600_000), // 10 minute timeout
      });
      if (!resp.ok || !resp.body) {
        this.errorLog(`[IndexTTS] poll failed: ${resp.status}`);
        return null;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event: complete")) {
            // Next data line has the result
            const dataLine = lines[lines.indexOf(line) + 1];
            if (dataLine?.startsWith("data: ")) {
              const data = JSON.parse(dataLine.slice(6));
              const result = Array.isArray(data) ? data[0] : data;
              const wavPath = result?.value?.path ?? result?.path;
              if (wavPath) {
                this.log(`[IndexTTS] generation complete: ${wavPath}`);
                return wavPath;
              }
            }
          }
          if (line.startsWith("event: error")) {
            this.errorLog("[IndexTTS] generation error from server");
            return null;
          }
        }
      }

      // Parse any remaining buffer
      if (buffer.includes("event: complete")) {
        const dataMatch = buffer.match(/data:\s*(\[.+\])/);
        if (dataMatch) {
          const data = JSON.parse(dataMatch[1]);
          const result = Array.isArray(data) ? data[0] : data;
          const wavPath = result?.value?.path ?? result?.path;
          if (wavPath) {
            this.log(`[IndexTTS] generation complete: ${wavPath}`);
            return wavPath;
          }
        }
      }

      this.errorLog("[IndexTTS] SSE stream ended without result");
      return null;
    } catch (err) {
      this.errorLog(`[IndexTTS] poll error: ${String(err)}`);
      return null;
    }
  }
}

// ────────────────────────────────────────
// macOS Say Backend (fallback)
// ────────────────────────────────────────

class MacSayBackend {
  private voice: string;
  private rate?: number;
  private log: LogFn;
  private errorLog: LogFn;

  constructor(params: { voice: string; rate?: number; log: LogFn; error: LogFn }) {
    this.voice = params.voice;
    this.rate = params.rate;
    this.log = params.log;
    this.errorLog = params.error;
  }

  async isAvailable(): Promise<boolean> {
    return process.platform === "darwin";
  }

  /** Generate AIFF file from text via macOS say command */
  async synthesize(text: string, outputPath: string): Promise<boolean> {
    const args = ["-v", this.voice, "-o", outputPath];
    if (this.rate) args.push("-r", String(this.rate));

    return new Promise((resolve) => {
      const proc = spawn("say", args);
      proc.stdin.write(text);
      proc.stdin.end();

      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk;
      });
      proc.on("close", (code) => {
        if (code !== 0) {
          this.errorLog(`[MacSay] exited ${code}: ${stderr.slice(0, 200)}`);
          resolve(false);
          return;
        }
        resolve(true);
      });
      proc.on("error", (err) => {
        this.errorLog(`[MacSay] not found: ${String(err)}`);
        resolve(false);
      });
    });
  }
}

// ────────────────────────────────────────
// PluginTtsEngine (orchestrator)
// ────────────────────────────────────────

export class PluginTtsEngine {
  private log: LogFn;
  private errorLog: LogFn;
  private audioConverter: AudioConverter;
  private config: TtsConfig;
  private indexTts: IndexTtsBackend | null;
  private macSay: MacSayBackend;

  constructor(params: { log: LogFn; error: LogFn; config?: TtsConfig }) {
    this.log = params.log;
    this.errorLog = params.error;
    this.config = params.config ?? {};
    this.audioConverter = new AudioConverter({ log: params.log, error: params.error });

    // Initialize IndexTTS backend if reference audio is configured
    if (this.config.referenceAudio) {
      this.indexTts = new IndexTtsBackend({
        baseUrl: this.config.indexTtsUrl ?? "http://localhost:7860",
        referenceAudio: this.config.referenceAudio,
        log: params.log,
        error: params.error,
      });
    } else {
      this.indexTts = null;
    }

    this.macSay = new MacSayBackend({
      voice: this.config.voice ?? "Tingting",
      rate: this.config.rate,
      log: params.log,
      error: params.error,
    });
  }

  /**
   * 将文本转换为 opus 语音文件
   * 优先使用 IndexTTS-2（高质量声音克隆），失败时回退到 macOS say
   */
  async synthesize(text: string): Promise<TtsResult | null> {
    const cleaned = stripMarkdownForTts(text);
    if (!cleaned) {
      this.log("[PluginTTS] empty text after markdown strip, skipping");
      return null;
    }

    const maxChars = 2000;
    const truncated = cleaned.length > maxChars ? cleaned.slice(0, maxChars) + "……" : cleaned;

    await fs.mkdir(TMP_DIR, { recursive: true, mode: 0o700 });

    const backend = this.config.backend ?? (this.indexTts ? "indextts" : "say");

    // Try IndexTTS-2 first
    if (backend === "indextts" && this.indexTts) {
      const available = await this.indexTts.isAvailable();
      if (available) {
        this.log(`[PluginTTS] using IndexTTS-2 backend (${truncated.length} chars)`);
        const wavPath = await this.indexTts.synthesize(truncated);
        if (wavPath) {
          const result = await this.audioConverter.convertToOpus(wavPath);
          if (result) {
            this.log(
              `[PluginTTS] IndexTTS-2 → opus: ${result.opusPath} duration=${result.durationMs}ms`,
            );
            return { opusPath: result.opusPath, durationMs: result.durationMs };
          }
        }
        this.errorLog("[PluginTTS] IndexTTS-2 failed, falling back to macOS say");
      } else {
        this.log("[PluginTTS] IndexTTS-2 server not available, falling back to macOS say");
      }
    }

    // Fallback: macOS say
    if (await this.macSay.isAvailable()) {
      this.log(`[PluginTTS] using macOS say backend (${truncated.length} chars)`);
      const aiffPath = path.join(TMP_DIR, `tts_${crypto.randomUUID()}.aiff`);
      const ok = await this.macSay.synthesize(truncated, aiffPath);
      if (ok) {
        const result = await this.audioConverter.convertToOpus(aiffPath);
        try {
          await fs.unlink(aiffPath);
        } catch {
          /* ignore */
        }
        if (result) {
          this.log(
            `[PluginTTS] macOS say → opus: ${result.opusPath} duration=${result.durationMs}ms`,
          );
          return { opusPath: result.opusPath, durationMs: result.durationMs };
        }
      }
    }

    this.errorLog("[PluginTTS] all backends failed");
    return null;
  }

  /** Clean up old TTS temp files (older than 1 hour) */
  async cleanupOldFiles(): Promise<void> {
    try {
      const files = await fs.readdir(TMP_DIR);
      const now = Date.now();
      for (const f of files) {
        const fp = path.join(TMP_DIR, f);
        const stat = await fs.stat(fp);
        if (now - stat.mtimeMs > 3600_000) {
          await fs.unlink(fp);
        }
      }
    } catch {
      // dir may not exist yet
    }
  }
}
