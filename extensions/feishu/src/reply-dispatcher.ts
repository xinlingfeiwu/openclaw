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
import { sendMediaFeishu } from "./media.js";
import { buildMentionedCardContent, type MentionTarget } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  sendMarkdownCardFeishu,
  sendMessageFeishu,
  splitByTableLimit,
  FEISHU_CARD_MAX_TABLES,
} from "./send.js";
import { FeishuStreamingSession } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { PluginTtsEngine } from "./tts.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

/** Maximum age (ms) for a message to receive a typing indicator reaction.
 * Messages older than this are likely replays after context compaction (#30418). */
const TYPING_INDICATOR_MAX_AGE_MS = 2 * 60_000;
const MS_EPOCH_MIN = 1_000_000_000_000;

function normalizeEpochMs(timestamp: number | undefined): number | undefined {
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  // Defensive normalization: some payloads use seconds, others milliseconds.
  // Values below 1e12 are treated as epoch-seconds.
  return timestamp < MS_EPOCH_MIN ? timestamp * 1000 : timestamp;
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  /** When true, preserve typing indicator on reply target but send messages without reply metadata */
  skipReplyToInMessages?: boolean;
  replyInThread?: boolean;
  /** True when inbound message is already inside a thread/topic context */
  threadReply?: boolean;
  rootId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
  /** Whether the inbound message triggered voice reply mode */
  voiceReplyRequested?: boolean;
  /** Epoch ms when the inbound message was created. Used to suppress typing
   *  indicators on old/replayed messages after context compaction (#30418). */
  messageCreateTimeMs?: number;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const {
    cfg,
    agentId,
    chatId,
    replyToMessageId,
    skipReplyToInMessages,
    replyInThread,
    threadReply,
    rootId,
    mentionTargets,
    accountId,
    voiceReplyRequested,
  } = params;
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
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
      // Check if typing indicator is enabled (default: true)
      if (!(account.config.typingIndicator ?? true)) {
        return;
      }
      if (!replyToMessageId) {
        return;
      }
      // Skip typing indicator for old messages — likely replays after context
      // compaction that would flood users with stale notifications (#30418).
      const messageCreateTimeMs = normalizeEpochMs(params.messageCreateTimeMs);
      if (
        messageCreateTimeMs !== undefined &&
        Date.now() - messageCreateTimeMs > TYPING_INDICATOR_MAX_AGE_MS
      ) {
        return;
      }
      // Feishu reactions persist until explicitly removed, so skip keepalive
      // re-adds when a reaction already exists. Re-adding the same emoji
      // triggers a new push notification for every call (#28660).
      if (typingState?.reactionId) {
        return;
      }
      typingState = await addTypingIndicator({
        cfg,
        messageId: replyToMessageId,
        accountId,
        runtime: params.runtime,
      });
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId, runtime: params.runtime });
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
  // Card streaming may miss thread affinity in topic contexts; use direct replies there.
  const streamingEnabled =
    !threadReplyMode && account.config?.streaming !== false && renderMode !== "raw";

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;

  const mergeStreamingText = (nextText: string) => {
    if (!streamText) {
      streamText = nextText;
      return;
    }
    if (nextText.startsWith(streamText)) {
      // Handle cumulative partial payloads where nextText already includes prior text.
      streamText = nextText;
      return;
    }
    if (streamText.endsWith(nextText)) {
      return;
    }
    streamText += nextText;
  };

  const queueStreamingUpdate = (
    nextText: string,
    options?: {
      dedupeWithLastPartial?: boolean;
    },
  ) => {
    if (!nextText) {
      return;
    }
    if (options?.dedupeWithLastPartial && nextText === lastPartial) {
      return;
    }
    if (options?.dedupeWithLastPartial) {
      lastPartial = nextText;
    }
    mergeStreamingText(nextText);
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (streaming?.isActive()) {
        await streaming.update(streamText);
      }
    });
  };

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
        await streaming.start(chatId, resolveReceiveIdType(chatId), {
          replyToMessageId,
          replyInThread: effectiveReplyInThread,
          rootId,
        });
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
      // Split into segments to avoid Feishu CardKit error 11310 (card table number over limit)
      const segments = splitByTableLimit(text, FEISHU_CARD_MAX_TABLES);
      await streaming.close(segments[0]);
      // Send overflow segments as follow-up card messages
      for (let i = 1; i < segments.length; i++) {
        await sendMarkdownCardFeishu({ cfg, to: chatId, text: segments[i], accountId });
      }
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
        // Exclude audio-as-voice media when voice mode is off — it was already
        // attempted (and intentionally skipped) in the media delivery block above.
        // Sending it here would result in a Feishu API 400 error.
        const skipAudioMedia = payload.audioAsVoice && !voiceReplyRequested;
        const mediaList = skipAudioMedia
          ? []
          : payload.mediaUrls && payload.mediaUrls.length > 0
            ? payload.mediaUrls
            : payload.mediaUrl
              ? [payload.mediaUrl]
              : [];
        const hasText = Boolean(text.trim());
        const hasMedia = mediaList.length > 0;

        if (!hasText && !hasMedia) {
          return;
        }

        if (hasText) {
          const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

          if (info?.kind === "block") {
            // Drop internal block chunks unless we can safely consume them as
            // streaming-card fallback content.
            if (!(streamingEnabled && useCard)) {
              return;
            }
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (info?.kind === "final" && streamingEnabled && useCard) {
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (streaming?.isActive()) {
            if (info?.kind === "block") {
              // Some runtimes emit block payloads without onPartial/final callbacks.
              // Mirror block text into streamText so onIdle close still sends content.
              queueStreamingUpdate(text);
            }
            if (info?.kind === "final") {
              streamText = text;
              await closeStreaming();
            }
            // Send media even when streaming handled the text
            if (hasMedia) {
              for (const mediaUrl of mediaList) {
                await sendMediaFeishu({
                  cfg,
                  to: chatId,
                  mediaUrl,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  accountId,
                });
              }
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
              // Split each chunk by table limit to avoid CardKit error 11310
              for (const segment of splitByTableLimit(chunk, FEISHU_CARD_MAX_TABLES)) {
                await sendMarkdownCardFeishu({
                  cfg,
                  to: chatId,
                  text: segment,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  mentions: first ? mentionTargets : undefined,
                  accountId,
                });
                first = false;
              }
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
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                mentions: first ? mentionTargets : undefined,
                accountId,
              });
              first = false;
            }
          }
        }

        if (hasMedia) {
          for (const mediaUrl of mediaList) {
            await sendMediaFeishu({
              cfg,
              to: chatId,
              mediaUrl,
              replyToMessageId: sendReplyToMessageId,
              replyInThread: effectiveReplyInThread,
              accountId,
            });
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
            if (!payload.text) {
              return;
            }
            queueStreamingUpdate(payload.text, { dedupeWithLastPartial: true });
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
