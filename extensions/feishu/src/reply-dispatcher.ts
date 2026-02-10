import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type RuntimeEnv,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import type { MentionTarget } from "./mention.js";
import { resolveFeishuAccount } from "./accounts.js";
import { MediaDeliveryManager, type MediaDeliveryContext } from "./media-delivery.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu, sendMarkdownCardFeishu } from "./send.js";
import { PluginTtsEngine } from "./tts.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/**
 * Detect if text contains markdown elements that benefit from card rendering.
 * Used by auto render mode.
 */
function shouldUseCard(text: string): boolean {
  // Code blocks (fenced)
  if (/```[\s\S]*?```/.test(text)) {
    return true;
  }
  // Tables (at least header + separator row with |)
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) {
    return true;
  }
  return false;
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  /** Mention targets, will be auto-included in replies */
  mentionTargets?: MentionTarget[];
  /** Account ID for multi-account support */
  accountId?: string;
  /** Whether the inbound message triggered voice reply mode */
  voiceReplyRequested?: boolean;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const { cfg, agentId, chatId, replyToMessageId, mentionTargets, accountId, voiceReplyRequested } =
    params;

  // Resolve account for config access
  const account = resolveFeishuAccount({ cfg, accountId });

  // Media delivery manager for voice/file/image replies
  const mediaDelivery = new MediaDeliveryManager({
    log: (msg) => params.runtime.log?.(msg),
    error: (msg) => params.runtime.error?.(msg),
  });

  // Plugin-level TTS engine for converting text → voice
  const ttsConfig = account.config?.ttsVoiceReply;
  const pluginTts = new PluginTtsEngine({
    log: (msg) => params.runtime.log?.(msg),
    error: (msg) => params.runtime.error?.(msg),
    config: {
      backend: ttsConfig?.backend,
      indexTtsUrl: ttsConfig?.indexTtsUrl,
      referenceAudio: ttsConfig?.referenceAudio,
      voice: ttsConfig?.voice,
      rate: ttsConfig?.rate,
    },
  });

  const prefixContext = createReplyPrefixContext({
    cfg,
    agentId,
  });

  // Feishu doesn't have a native typing indicator API.
  // We use message reactions as a typing indicator substitute.
  let typingState: TypingIndicatorState | null = null;

  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      if (!replyToMessageId) {
        return;
      }
      typingState = await addTypingIndicator({ cfg, messageId: replyToMessageId, accountId });
      params.runtime.log?.(`feishu[${account.accountId}]: added typing indicator reaction`);
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId });
      typingState = null;
      params.runtime.log?.(`feishu[${account.accountId}]: removed typing indicator reaction`);
    },
    onStartError: (err) => {
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      });
    },
    onStopError: (err) => {
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      });
    },
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: typingCallbacks.onReplyStart,
      deliver: async (payload: ReplyPayload) => {
        params.runtime.log?.(
          `feishu[${account.accountId}] deliver called: text=${payload.text?.slice(0, 100)} mediaUrl=${payload.mediaUrl ? "yes" : "no"} audioAsVoice=${payload.audioAsVoice} voiceMode=${voiceReplyRequested}`,
        );

        // ── Plugin TTS: convert text → voice when voice mode is active ──
        if (voiceReplyRequested && payload.text?.trim()) {
          const fallbackToText = ttsConfig?.fallbackToText !== false;
          params.runtime.log?.(
            `feishu[${account.accountId}] plugin TTS: generating voice from text (${payload.text.length} chars)`,
          );

          const ttsResult = await pluginTts.synthesize(payload.text);
          if (ttsResult) {
            const deliveryCtx: MediaDeliveryContext = {
              cfg,
              chatId,
              replyToMessageId,
              accountId,
            };
            // deliverAudio expects a local file path, asVoice=true
            const result = await mediaDelivery.deliver(ttsResult.opusPath, deliveryCtx, true);
            if (result.success && result.sentAsVoice) {
              params.runtime.log?.(
                `feishu[${account.accountId}] plugin TTS voice delivered, suppressing text`,
              );
              return; // voice sent, skip text
            }
            params.runtime.log?.(
              `feishu[${account.accountId}] plugin TTS voice delivery failed: ${result.error}`,
            );
          } else {
            params.runtime.log?.(`feishu[${account.accountId}] plugin TTS synthesis failed`);
          }

          // TTS failed → fall back to text if configured
          if (!fallbackToText) {
            params.runtime.log?.(
              `feishu[${account.accountId}] plugin TTS failed, fallbackToText=false, skipping`,
            );
            return;
          }
          // Fall through to text delivery below
        }

        // ── Media delivery (non-voice: images, files) ──
        const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
        if (mediaUrls.length > 0 && !voiceReplyRequested) {
          // When NOT in voice mode, deliver media normally (images, files, etc.)
          const deliveryCtx: MediaDeliveryContext = {
            cfg,
            chatId,
            replyToMessageId,
            accountId,
          };

          for (const url of mediaUrls) {
            const result = await mediaDelivery.deliver(url, deliveryCtx, false);
            if (!result.success) {
              params.runtime.log?.(
                `feishu[${account.accountId}] media delivery failed: ${result.error}`,
              );
            }
          }

          if (!payload.text?.trim()) {
            return;
          }
        }

        // ── Text delivery (existing logic) ──
        const text = payload.text ?? "";
        if (!text.trim()) {
          params.runtime.log?.(`feishu[${account.accountId}] deliver: empty text, skipping`);
          return;
        }

        // Check render mode: auto (default), raw, or card
        const feishuCfg = account.config;
        const renderMode = feishuCfg?.renderMode ?? "auto";

        // Determine if we should use card for this message
        const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

        // Only include @mentions in the first chunk (avoid duplicate @s)
        let isFirstChunk = true;

        if (useCard) {
          // Card mode: send as interactive card with markdown rendering
          const chunks = core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode);
          params.runtime.log?.(
            `feishu[${account.accountId}] deliver: sending ${chunks.length} card chunks to ${chatId}`,
          );
          for (const chunk of chunks) {
            await sendMarkdownCardFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
              mentions: isFirstChunk ? mentionTargets : undefined,
              accountId,
            });
            isFirstChunk = false;
          }
        } else {
          // Raw mode: send as plain text with table conversion
          const converted = core.channel.text.convertMarkdownTables(text, tableMode);
          const chunks = core.channel.text.chunkTextWithMode(converted, textChunkLimit, chunkMode);
          params.runtime.log?.(
            `feishu[${account.accountId}] deliver: sending ${chunks.length} text chunks to ${chatId}`,
          );
          for (const chunk of chunks) {
            await sendMessageFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
              mentions: isFirstChunk ? mentionTargets : undefined,
              accountId,
            });
            isFirstChunk = false;
          }
        }
      },
      onError: (err, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(err)}`,
        );
        typingCallbacks.onIdle?.();
      },
      onIdle: typingCallbacks.onIdle,
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
    },
    markDispatchIdle,
  };
}
