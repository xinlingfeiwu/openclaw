/**
 * AudioConverter — 音频格式转换工具类
 * 负责将 MP3/WAV 等格式转换为飞书要求的 Opus 格式，并检测音频时长
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type AudioConversionResult = {
  opusPath: string;
  durationMs: number;
};

type LogFn = (msg: string) => void;

export class AudioConverter {
  private log: LogFn;
  private errorLog: LogFn;

  constructor(params: { log: LogFn; error: LogFn }) {
    this.log = params.log;
    this.errorLog = params.error;
  }

  /**
   * 将音频文件转换为 Opus 格式
   * @param sourcePath 源音频文件路径（MP3/WAV/M4A 等）
   * @returns 转换结果（opus 路径 + 时长），失败返回 null
   */
  async convertToOpus(sourcePath: string): Promise<AudioConversionResult | null> {
    const destDir = path.join(os.tmpdir(), "openclaw-feishu-audio");
    await fs.mkdir(destDir, { recursive: true, mode: 0o700 });
    const opusPath = path.join(destDir, `${crypto.randomUUID()}.opus`);

    const ok = await this.runFfmpeg([
      "-y",
      "-i",
      sourcePath,
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
      "-ar",
      "48000",
      "-ac",
      "1",
      opusPath,
    ]);

    if (!ok) {
      this.errorLog("[AudioConverter] ffmpeg opus conversion failed");
      return null;
    }

    const durationMs = await this.detectDuration(opusPath);
    this.log(`[AudioConverter] opus conversion ok: ${opusPath} duration=${durationMs}ms`);
    return { opusPath, durationMs };
  }

  /**
   * 检测音频文件时长（毫秒）
   * 使用 ffprobe 获取精确时长
   */
  async detectDuration(filePath: string): Promise<number> {
    return new Promise((resolve) => {
      const proc = spawn("ffprobe", [
        "-v",
        "quiet",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        filePath,
      ]);

      let output = "";
      proc.stdout.on("data", (chunk) => {
        output += chunk;
      });
      proc.on("close", (code) => {
        if (code !== 0) {
          this.errorLog("[AudioConverter] ffprobe failed, using fallback duration");
          resolve(5000); // fallback 5s
          return;
        }
        const seconds = parseFloat(output.trim());
        if (isNaN(seconds) || seconds <= 0) {
          resolve(5000);
          return;
        }
        resolve(Math.round(seconds * 1000));
      });
      proc.on("error", () => {
        this.errorLog("[AudioConverter] ffprobe not found, using fallback duration");
        resolve(5000);
      });
    });
  }

  /**
   * 执行 ffmpeg 命令
   */
  private runFfmpeg(args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("ffmpeg", args);
      proc.on("close", (code) => resolve(code === 0));
      proc.on("error", () => {
        this.errorLog("[AudioConverter] ffmpeg not found");
        resolve(false);
      });
    });
  }
}
