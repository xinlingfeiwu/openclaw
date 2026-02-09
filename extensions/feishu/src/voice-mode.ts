/**
 * VoiceReplyModeManager — 语音回复模式管理器
 * 负责判断是否应该使用语音回复，支持三种触发方式：
 * 1. 用户发送语音消息 → 单次语音回复
 * 2. 用户消息包含语音关键词 → 单次语音回复
 * 3. /tts on 指令 → 持续语音模式，直到 /tts off
 */

/** 语音关键词列表 */
const VOICE_KEYWORDS = ["语音回复", "用语音", "语音回答", "voice reply", "voice response"];

export type VoiceDecision = {
  /** 是否使用语音回复 */
  useVoice: boolean;
  /** 触发原因 */
  reason: "session-mode" | "audio-message" | "keyword" | "none";
};

export type TtsCommandResult = {
  /** 是否匹配了 /tts 指令 */
  matched: boolean;
  /** 是否应该拦截（不再转发给 AI） */
  intercepted: boolean;
  /** 回复文本（指令确认信息） */
  replyText?: string;
};

export class VoiceReplyModeManager {
  /** 持续模式状态：sessionKey → enabled */
  private sessionModes = new Map<string, boolean>();

  /**
   * 判断当前消息是否应该使用语音回复
   * @param ctx 消息上下文
   * @returns 语音决策
   */
  shouldUseVoice(ctx: { sessionKey: string; contentType: string; content: string }): VoiceDecision {
    // 1. 检查持续模式
    const sessionMode = this.sessionModes.get(ctx.sessionKey);
    if (sessionMode === true) {
      return { useVoice: true, reason: "session-mode" };
    }
    // sessionMode === false means /tts off was used;
    // only disables session mode, single-shot triggers still work

    // 2. 检查入站消息类型是否为音频
    if (ctx.contentType === "audio") {
      return { useVoice: true, reason: "audio-message" };
    }

    // 3. 检查关键词
    const lowerContent = ctx.content.toLowerCase();
    for (const keyword of VOICE_KEYWORDS) {
      if (lowerContent.includes(keyword)) {
        return { useVoice: true, reason: "keyword" };
      }
    }

    return { useVoice: false, reason: "none" };
  }

  /**
   * 处理 /tts 指令
   * @param content 消息内容
   * @param sessionKey 会话标识
   * @returns 指令处理结果
   */
  handleTtsCommand(content: string, sessionKey: string): TtsCommandResult {
    const trimmed = content.trim().toLowerCase();

    if (trimmed === "/tts on") {
      this.sessionModes.set(sessionKey, true);
      return {
        matched: true,
        intercepted: true,
        replyText: "🎙️ 语音回复模式已开启，后续消息将以语音形式回复。发送 /tts off 关闭。",
      };
    }

    if (trimmed === "/tts off") {
      this.sessionModes.set(sessionKey, false);
      return {
        matched: true,
        intercepted: true,
        replyText: "🔇 语音回复模式已关闭，将恢复文本回复。",
      };
    }

    if (trimmed === "/tts" || trimmed === "/tts status") {
      const isOn = this.sessionModes.get(sessionKey) === true;
      return {
        matched: true,
        intercepted: true,
        replyText: `🎙️ 语音回复模式：${isOn ? "开启" : "关闭"}\n\n使用方式：\n• /tts on — 开启持续语音回复\n• /tts off — 关闭语音回复\n• 发送语音消息 — 单次语音回复\n• 消息中包含「语音回复」— 单次语音回复`,
      };
    }

    return { matched: false, intercepted: false };
  }

  /**
   * 获取指定会话的持续模式状态
   */
  isSessionModeOn(sessionKey: string): boolean {
    return this.sessionModes.get(sessionKey) === true;
  }

  /**
   * 清除指定会话的模式状态
   */
  clearSession(sessionKey: string): void {
    this.sessionModes.delete(sessionKey);
  }
}

/** 全局单例 */
let instance: VoiceReplyModeManager | null = null;

export function getVoiceReplyModeManager(): VoiceReplyModeManager {
  if (!instance) {
    instance = new VoiceReplyModeManager();
  }
  return instance;
}
