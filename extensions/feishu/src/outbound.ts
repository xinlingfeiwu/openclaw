import fs from "fs";
import path from "path";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { MediaDeliveryManager } from "./media-delivery.js";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";

function normalizePossibleLocalImagePath(text: string | undefined): string | null {
  const raw = text?.trim();
  if (!raw) return null;

  // Only auto-convert when the message is a pure path-like payload.
  // Avoid converting regular sentences that merely contain a path.
  const hasWhitespace = /\s/.test(raw);
  if (hasWhitespace) return null;

  // Ignore links/data URLs; those should stay in normal mediaUrl/text paths.
  if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) return null;

  const ext = path.extname(raw).toLowerCase();
  const isImageExt = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(
    ext,
  );
  if (!isImageExt) return null;

  if (!path.isAbsolute(raw)) return null;
  if (!fs.existsSync(raw)) return null;

  // Fix race condition: wrap statSync in try-catch to handle file deletion
  // between existsSync and statSync
  try {
    if (!fs.statSync(raw).isFile()) return null;
  } catch {
    // File may have been deleted or became inaccessible between checks
    return null;
  }

  return raw;
}

function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

async function sendOutboundText(params: {
  cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
  to: string;
  text: string;
  accountId?: string;
}) {
  const { cfg, to, text, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const renderMode = account.config?.renderMode ?? "auto";

  if (renderMode === "card" || (renderMode === "auto" && shouldUseCard(text))) {
    return sendMarkdownCardFeishu({ cfg, to, text, accountId });
  }

  return sendMessageFeishu({ cfg, to, text, accountId });
}

/** Audio extensions that need opus conversion before sending */
const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".opus", ".m4a", ".aac", ".flac"]);

function isAudioUrl(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  const ext = pathname.toLowerCase().replace(/.*(\.\w+)$/, "$1");
  return AUDIO_EXTS.has(ext);
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId }) => {
    // Scheme A compatibility shim:
    // when upstream accidentally returns a local image path as plain text,
    // auto-upload and send as Feishu image message instead of leaking path text.
    const localImagePath = normalizePossibleLocalImagePath(text);
    if (localImagePath) {
      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl: localImagePath,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        console.error(`[feishu] local image path auto-send failed:`, err);
        // fall through to plain text as last resort
      }
    }

    const result = await sendOutboundText({
      cfg,
      to,
      text,
      accountId: accountId ?? undefined,
    });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, mediaLocalRoots }) => {
    // Send text first if provided
    if (text?.trim()) {
      await sendOutboundText({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
      });
    }

    // Upload and send media if URL or local path provided
    if (mediaUrl) {
      try {
        // Audio files need opus conversion + msg_type "audio"
        if (isAudioUrl(mediaUrl)) {
          const delivery = new MediaDeliveryManager({
            log: (msg) => console.log(`[feishu] ${msg}`),
            error: (msg) => console.error(`[feishu] ${msg}`),
          });
          const result = await delivery.deliver(
            mediaUrl,
            { cfg, chatId: to, accountId: accountId ?? undefined },
            true,
          );
          if (result.success) {
            return { channel: "feishu", messageId: "audio-sent", chatId: to };
          }
          // Fall through to fallback text
          throw new Error(result.error ?? "audio delivery failed");
        }

        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl,
          accountId: accountId ?? undefined,
          mediaLocalRoots,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        // Log the error for debugging
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        // Fallback to URL link if upload fails
        const fallbackText = `📎 ${mediaUrl}`;
        const result = await sendOutboundText({
          cfg,
          to,
          text: fallbackText,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      }
    }

    // No media URL, just return text result
    const result = await sendOutboundText({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
    });
    return { channel: "feishu", ...result };
  },
};
