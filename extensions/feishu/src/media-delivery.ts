import type { ClawdbotConfig } from "openclaw/plugin-sdk";
/**
 * MediaDeliveryManager — 出站媒体投递管理
 * 负责将 AI 回复中的媒体内容（语音、图片、文件）投递到飞书
 *
 * TempFileManager — 临时文件生命周期管理
 * 跟踪和清理转码过程中产生的临时文件
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AudioConverter, type AudioConversionResult } from "./audio.js";
import { sendMediaFeishu, uploadFileFeishu, sendAudioFeishu } from "./media.js";

export type MediaDeliveryContext = {
  cfg: ClawdbotConfig;
  chatId: string;
  replyToMessageId?: string;
  accountId?: string;
};

export type MediaDeliveryResult = {
  success: boolean;
  /** media was sent as voice bubble (vs regular file) */
  sentAsVoice: boolean;
  error?: string;
};

type LogFn = (msg: string) => void;

// ────────────────────────────────────────
// TempFileManager
// ────────────────────────────────────────

export class TempFileManager {
  private tracked: string[] = [];

  /** Track a temp file for later cleanup */
  track(filePath: string): void {
    this.tracked.push(filePath);
  }

  /** Remove all tracked temp files */
  async cleanup(): Promise<void> {
    for (const fp of this.tracked) {
      try {
        await fs.unlink(fp);
      } catch {
        // file may already be gone
      }
    }
    this.tracked = [];
  }
}

// ────────────────────────────────────────
// MediaDeliveryManager
// ────────────────────────────────────────

/** Detect media category from URL or file path */
type MediaCategory = "audio" | "image" | "file";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".opus", ".m4a", ".aac", ".flac"]);

export class MediaDeliveryManager {
  private log: LogFn;
  private errorLog: LogFn;
  private audioConverter: AudioConverter;
  private tempFiles: TempFileManager;

  constructor(params: { log: LogFn; error: LogFn }) {
    this.log = params.log;
    this.errorLog = params.error;
    this.audioConverter = new AudioConverter({ log: params.log, error: params.error });
    this.tempFiles = new TempFileManager();
  }

  /**
   * 投递媒体文件到飞书
   * @param mediaUrl 媒体文件 URL 或本地路径
   * @param ctx 飞书投递上下文
   * @param asVoice 是否作为语音消息发送（仅对音频有效）
   */
  async deliver(
    mediaUrl: string,
    ctx: MediaDeliveryContext,
    asVoice: boolean,
  ): Promise<MediaDeliveryResult> {
    const category = this.detectMediaCategory(mediaUrl);
    this.log(
      `[MediaDelivery] delivering ${category} media (asVoice=${asVoice}): ${mediaUrl.slice(0, 120)}`,
    );

    try {
      if (category === "audio" && asVoice) {
        return await this.deliverAudio(mediaUrl, ctx);
      }
      // When voice mode is off and media is audio, skip it (text fallback handles reply)
      if (category === "audio" && !asVoice) {
        this.log("[MediaDelivery] skipping audio (voice mode off)");
        return { success: false, sentAsVoice: false, error: "voice mode off" };
      }
      // For images and files, delegate to the existing sendMediaFeishu
      await sendMediaFeishu({
        cfg: ctx.cfg,
        to: ctx.chatId,
        mediaUrl,
        replyToMessageId: ctx.replyToMessageId,
        accountId: ctx.accountId,
      });
      return { success: true, sentAsVoice: false };
    } catch (err) {
      this.errorLog(`[MediaDelivery] failed to deliver ${category}: ${String(err)}`);
      return { success: false, sentAsVoice: false, error: String(err) };
    } finally {
      await this.tempFiles.cleanup();
    }
  }

  /**
   * 语音消息投递：下载 → 转 opus → 上传飞书 → 发送语音卡片
   */
  private async deliverAudio(
    mediaUrl: string,
    ctx: MediaDeliveryContext,
  ): Promise<MediaDeliveryResult> {
    // 1. Resolve audio to local file
    const localPath = await this.resolveToLocalFile(mediaUrl);
    if (!localPath) {
      this.errorLog(
        `[MediaDelivery] audio file not found or inaccessible: ${mediaUrl.slice(0, 120)}`,
      );
      return { success: false, sentAsVoice: false, error: "Failed to resolve audio file" };
    }

    // 2. Convert to opus (skip if already opus)
    let opusResult: AudioConversionResult;
    const ext = path.extname(localPath).toLowerCase();
    if (ext === ".opus" || ext === ".ogg") {
      const durationMs = await this.audioConverter.detectDuration(localPath);
      opusResult = { opusPath: localPath, durationMs };
    } else {
      const converted = await this.audioConverter.convertToOpus(localPath);
      if (!converted) {
        return { success: false, sentAsVoice: false, error: "Opus conversion failed" };
      }
      opusResult = converted;
      this.tempFiles.track(converted.opusPath);
    }

    // 3. Upload as file with type=opus + duration
    const { fileKey } = await uploadFileFeishu({
      cfg: ctx.cfg,
      file: opusResult.opusPath,
      fileName: `voice_${Date.now()}.opus`,
      fileType: "opus",
      duration: opusResult.durationMs,
      accountId: ctx.accountId,
    });

    // 4. Send audio message (msg_type: "audio")
    await sendAudioFeishu({
      cfg: ctx.cfg,
      to: ctx.chatId,
      fileKey,
      replyToMessageId: ctx.replyToMessageId,
      accountId: ctx.accountId,
    });

    this.log(`[MediaDelivery] voice sent: duration=${opusResult.durationMs}ms`);
    return { success: true, sentAsVoice: true };
  }

  /**
   * 将 URL 或路径解析为本地文件路径
   * 远程 URL 会先下载到临时目录
   */
  private async resolveToLocalFile(urlOrPath: string): Promise<string | null> {
    // Local path
    if (urlOrPath.startsWith("/") || urlOrPath.startsWith("~")) {
      const resolved = urlOrPath.startsWith("~")
        ? urlOrPath.replace("~", process.env.HOME ?? "")
        : urlOrPath;
      try {
        await fs.access(resolved);
        return resolved;
      } catch {
        this.errorLog(`[MediaDelivery] local file not found: ${resolved}`);
        return null;
      }
    }

    // Remote URL — download to temp file
    try {
      const response = await fetch(urlOrPath);
      if (!response.ok) {
        this.errorLog(`[MediaDelivery] fetch failed: ${response.status}`);
        return null;
      }

      const tmpDir = path.join(os.tmpdir(), "openclaw-feishu-media");
      await fs.mkdir(tmpDir, { recursive: true, mode: 0o700 });

      const ext = path.extname(new URL(urlOrPath).pathname) || ".bin";
      const tmpPath = path.join(tmpDir, `dl_${Date.now()}${ext}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(tmpPath, buffer);
      this.tempFiles.track(tmpPath);

      return tmpPath;
    } catch (err) {
      this.errorLog(`[MediaDelivery] download failed: ${String(err)}`);
      return null;
    }
  }

  /** 判断媒体类型 */
  private detectMediaCategory(urlOrPath: string): MediaCategory {
    let pathname: string;
    try {
      pathname = new URL(urlOrPath).pathname;
    } catch {
      pathname = urlOrPath;
    }
    const ext = path.extname(pathname).toLowerCase();
    if (IMAGE_EXTS.has(ext)) return "image";
    if (AUDIO_EXTS.has(ext)) return "audio";
    return "file";
  }
}
