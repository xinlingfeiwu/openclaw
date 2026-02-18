import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { MediaDeliveryManager, type MediaDeliveryContext } from "./media-delivery.js";
import { buildMentionedCardContent, type MentionTarget } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";
import { FeishuStreamingSession } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { PluginTtsEngine } from "./tts.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  mentionTargets?: MentionTarget[];
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
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

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

  let typingState: TypingIndicatorState | null = null;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      if (!replyToMessageId) {
        return;
      }
      typingState = await addTypingIndicator({ cfg, messageId: replyToMessageId, accountId });
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId });
      typingState = null;
    },
    onStartError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      }),
    onStopError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      }),
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const renderMode = account.config?.renderMode ?? "auto";
  const streamingEnabled = account.config?.streaming !== false && renderMode !== "raw";

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;

  const startStreaming = () => {
    if (!streamingEnabled || streamingStartPromise || streaming) {
      return;
    }
    streamingStartPromise = (async () => {
      const creds =
        account.appId && account.appSecret
          ? { appId: account.appId, appSecret: account.appSecret, domain: account.domain }
          : null;
      if (!creds) {
        return;
      }

      streaming = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      try {
        await streaming.start(chatId, resolveReceiveIdType(chatId));
      } catch (error) {
        params.runtime.error?.(`feishu: streaming start failed: ${String(error)}`);
        streaming = null;
      }
    })();
  };

  const closeStreaming = async () => {
    if (streamingStartPromise) {
      await streamingStartPromise;
    }
    await partialUpdateQueue;
    if (streaming?.isActive()) {
      let text = streamText;
      if (mentionTargets?.length) {
        text = buildMentionedCardContent(mentionTargets, text);
      }
      await streaming.close(text);
    }
    streaming = null;
    streamingStartPromise = null;
    streamText = "";
    lastPartial = "";
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: () => {
        if (streamingEnabled && renderMode === "card") {
          startStreaming();
        }
        void typingCallbacks.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
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

        // ── Text delivery ──
        const text = payload.text ?? "";
        if (!text.trim()) {
          return;
        }

        const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

        if ((info?.kind === "block" || info?.kind === "final") && streamingEnabled && useCard) {
          startStreaming();
          if (streamingStartPromise) {
            await streamingStartPromise;
          }
        }

        if (streaming?.isActive()) {
          if (info?.kind === "final") {
            streamText = text;
            await closeStreaming();
          }
          return;
        }

        let first = true;
        if (useCard) {
          for (const chunk of core.channel.text.chunkTextWithMode(
            text,
            textChunkLimit,
            chunkMode,
          )) {
            await sendMarkdownCardFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
              mentions: first ? mentionTargets : undefined,
              accountId,
            });
            first = false;
          }
        } else {
          const converted = core.channel.text.convertMarkdownTables(text, tableMode);
          for (const chunk of core.channel.text.chunkTextWithMode(
            converted,
            textChunkLimit,
            chunkMode,
          )) {
            await sendMessageFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
              mentions: first ? mentionTargets : undefined,
              accountId,
            });
            first = false;
          }
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onCleanup: () => {
        typingCallbacks.onCleanup?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text || payload.text === lastPartial) {
              return;
            }
            lastPartial = payload.text;
            streamText = payload.text;
            partialUpdateQueue = partialUpdateQueue.then(async () => {
              if (streamingStartPromise) {
                await streamingStartPromise;
              }
              if (streaming?.isActive()) {
                await streaming.update(streamText);
              }
            });
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
