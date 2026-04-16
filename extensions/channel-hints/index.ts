import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// ============================================================
// Channel-specific format and capability hints.
// Ported from hermes-agent/agent/prompt_builder.py PLATFORM_HINTS (lines 285-387).
// Injected via before_prompt_build when ctx.channelId matches a known channel.
// ============================================================

const PLATFORM_HINTS: Record<string, string> = {
  whatsapp: `You are on a text messaging communication platform, WhatsApp. \
Please do not use markdown as it does not render. \
You can send media files natively: to deliver a file to the user, \
include MEDIA:/absolute/path/to/file in your response. The file \
will be sent as a native WhatsApp attachment — images (.jpg, .png, \
.webp) appear as photos, videos (.mp4, .mov) play inline, and other \
files arrive as downloadable documents. You can also include image \
URLs in markdown format ![alt](url) and they will be sent as photos.`,

  telegram: `You are on a text messaging communication platform, Telegram. \
Standard markdown is automatically converted to Telegram format. \
Supported: **bold**, *italic*, ~~strikethrough~~, ||spoiler||, \
\`inline code\`, \`\`\`code blocks\`\`\`, [links](url), and ## headers. \
You can send media files natively: to deliver a file to the user, \
include MEDIA:/absolute/path/to/file in your response. Images \
(.png, .jpg, .webp) appear as photos, audio (.ogg) sends as voice \
bubbles, and videos (.mp4) play inline. You can also include image \
URLs in markdown format ![alt](url) and they will be sent as native photos.`,

  discord: `You are in a Discord server or group chat communicating with your user. \
You can send media files natively: include MEDIA:/absolute/path/to/file \
in your response. Images (.png, .jpg, .webp) are sent as photo \
attachments, audio as file attachments. You can also include image URLs \
in markdown format ![alt](url) and they will be sent as attachments.`,

  slack: `You are in a Slack workspace communicating with your user. \
You can send media files natively: include MEDIA:/absolute/path/to/file \
in your response. Images (.png, .jpg, .webp) are uploaded as photo \
attachments, audio as file attachments. You can also include image URLs \
in markdown format ![alt](url) and they will be uploaded as attachments.`,

  signal: `You are on a text messaging communication platform, Signal. \
Please do not use markdown as it does not render. \
You can send media files natively: to deliver a file to the user, \
include MEDIA:/absolute/path/to/file in your response. Images \
(.png, .jpg, .webp) appear as photos, audio as attachments, and other \
files arrive as downloadable documents. You can also include image \
URLs in markdown format ![alt](url) and they will be sent as photos.`,

  email: `You are communicating via email. Write clear, well-structured responses \
suitable for email. Use plain text formatting (no markdown). \
Keep responses concise but complete. You can send file attachments — \
include MEDIA:/absolute/path/to/file in your response. The subject line \
is preserved for threading. Do not include greetings or sign-offs unless \
contextually appropriate.`,

  cron: `You are running as a scheduled cron job. There is no user present — you \
cannot ask questions, request clarification, or wait for follow-up. Execute \
the task fully and autonomously, making reasonable decisions where needed. \
Your final response is automatically delivered to the job's configured \
destination — put the primary content directly in your response.`,

  cli: `You are a CLI AI Agent. Try not to use markdown but simple text \
renderable inside a terminal.`,

  sms: `You are communicating via SMS. Keep responses concise and use plain text \
only — no markdown, no formatting. SMS messages are limited to ~1600 \
characters, so be brief and direct.`,

  bluebubbles: `You are chatting via iMessage (BlueBubbles). iMessage does not render \
markdown formatting — use plain text. Keep responses concise as they \
appear as text messages. You can send media files natively: include \
MEDIA:/absolute/path/to/file in your response. Images (.jpg, .png, \
.heic) appear as photos and other files arrive as attachments.`,

  imessage: `You are chatting via iMessage. iMessage does not render markdown \
formatting — use plain text. Keep responses concise as they appear as \
text messages. You can send media files natively: include \
MEDIA:/absolute/path/to/file in your response. Images (.jpg, .png, \
.heic) appear as photos and other files arrive as attachments.`,

  weixin: `You are on Weixin/WeChat. Markdown formatting is supported, so you may use it when \
it improves readability, but keep the message compact and chat-friendly. You can send media files natively: \
include MEDIA:/absolute/path/to/file in your response. Images are sent as native \
photos, videos play inline when supported, and other files arrive as downloadable \
documents. You can also include image URLs in markdown format ![alt](url) and they \
will be downloaded and sent as native media when possible.`,

  // wechat is an alias for weixin
  wechat: `You are on Weixin/WeChat. Markdown formatting is supported, so you may use it when \
it improves readability, but keep the message compact and chat-friendly. You can send media files natively: \
include MEDIA:/absolute/path/to/file in your response. Images are sent as native \
photos, videos play inline when supported, and other files arrive as downloadable \
documents. You can also include image URLs in markdown format ![alt](url) and they \
will be downloaded and sent as native media when possible.`,

  wecom: `You are on WeCom (企业微信 / Enterprise WeChat). Markdown formatting is supported. \
You CAN send media files natively — to deliver a file to the user, include \
MEDIA:/absolute/path/to/file in your response. The file will be sent as a native \
WeCom attachment: images (.jpg, .png, .webp) are sent as photos (up to 10 MB), \
other files (.pdf, .docx, .xlsx, .md, .txt, etc.) arrive as downloadable documents \
(up to 20 MB), and videos (.mp4) play inline. Voice messages are supported but \
must be in AMR format — other audio formats are automatically sent as file attachments. \
You can also include image URLs in markdown format ![alt](url) and they will be \
downloaded and sent as native photos. Do NOT tell the user you lack file-sending \
capability — use MEDIA: syntax whenever a file delivery is appropriate.`,

  // wework is an alias for wecom
  wework: `You are on WeCom (企业微信 / Enterprise WeChat). Markdown formatting is supported. \
You CAN send media files natively — to deliver a file to the user, include \
MEDIA:/absolute/path/to/file in your response. The file will be sent as a native \
WeCom attachment: images (.jpg, .png, .webp) are sent as photos (up to 10 MB), \
other files (.pdf, .docx, .xlsx, .md, .txt, etc.) arrive as downloadable documents \
(up to 20 MB), and videos (.mp4) play inline. Voice messages are supported but \
must be in AMR format — other audio formats are automatically sent as file attachments. \
You can also include image URLs in markdown format ![alt](url) and they will be \
downloaded and sent as native photos. Do NOT tell the user you lack file-sending \
capability — use MEDIA: syntax whenever a file delivery is appropriate.`,

  qqbot: `You are on QQ, a popular Chinese messaging platform. QQ supports markdown formatting \
and emoji. You can send media files natively: include MEDIA:/absolute/path/to/file in \
your response. Images are sent as native photos, and other files arrive as downloadable \
documents.`,

  feishu: `You are on Feishu (飞书 / Lark). Markdown formatting is supported. \
You can send media files natively: include MEDIA:/absolute/path/to/file in your response. \
Images, videos, and documents are sent as native attachments. Keep messages concise and \
use formatting to improve readability.`,
};

type ChannelHintsConfig = {
  enabled?: boolean;
  /** Custom channel hints to add or override built-in hints. Key = channelId. */
  customHints?: Record<string, string>;
};

export default definePluginEntry({
  id: "channel-hints",
  name: "Channel Hints",
  description:
    "Injects channel-specific format and capability hints into the system prompt based on the active messaging channel.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as ChannelHintsConfig;

    if (cfg.enabled === false) {
      return;
    }

    const customHints =
      typeof cfg.customHints === "object" && cfg.customHints !== null ? cfg.customHints : {};

    api.on("before_prompt_build", (_event, ctx) => {
      const channelId = (ctx as { channelId?: string }).channelId;
      if (!channelId) {
        return undefined;
      }

      // Normalize: lowercase, strip optional suffix like "-bot", "-web"
      const normalized = channelId.toLowerCase().replace(/-(?:bot|web|user|v\d+)$/, "");

      const hint =
        customHints[channelId] ??
        customHints[normalized] ??
        PLATFORM_HINTS[normalized] ??
        PLATFORM_HINTS[channelId];

      if (!hint) {
        return undefined;
      }

      api.logger.info?.(`channel-hints: injecting hint for channel=${channelId}`);
      return { prependSystemContext: hint };
    });
  },
});
