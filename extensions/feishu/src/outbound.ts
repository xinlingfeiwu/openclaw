import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { MediaDeliveryManager } from "./media-delivery.js";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu } from "./send.js";

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
    const result = await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    // Send text first if provided
    if (text?.trim()) {
      await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
    }

    // Upload and send media if URL provided
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
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        // Log the error for debugging
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        // Fallback to URL link if upload fails
        const fallbackText = `📎 ${mediaUrl}`;
        const result = await sendMessageFeishu({
          cfg,
          to,
          text: fallbackText,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      }
    }

    // No media URL, just return text result
    const result = await sendMessageFeishu({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
    });
    return { channel: "feishu", ...result };
  },
};
