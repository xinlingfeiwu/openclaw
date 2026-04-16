import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// Think-block open/close tag pairs — ported from hermes stream_consumer.py
// These tags wrap reasoning scratchpad content models emit before their final answer.
const THINK_TAG_PAIRS: Array<[RegExp, RegExp]> = [
  [/<REASONING_SCRATCHPAD>/i, /<\/REASONING_SCRATCHPAD>/i],
  [/<think>/i, /<\/think>/i],
  [/<reasoning>/i, /<\/reasoning>/i],
  [/<THINKING>/i, /<\/THINKING>/i],
  [/<thinking>/i, /<\/thinking>/i],
  [/<thought>/i, /<\/thought>/i],
];

// Build a single regex that matches any open tag (used for fast rejection)
const OPEN_TAG_RE = /<(?:REASONING_SCRATCHPAD|think|reasoning|THINKING|thinking|thought)>/i;

type ThinkBlockFilterConfig = {
  enabled?: boolean;
  /** Replace removed blocks with a placeholder (default: false — silent removal) */
  placeholder?: string;
};

/**
 * Strip think-block content from a reply string.
 * Handles nested tags conservatively: the first matching close tag ends the block.
 * Any unclosed open tag causes the remainder to be stripped (model is mid-thought).
 */
function stripThinkBlocks(text: string, placeholder: string): string {
  if (!OPEN_TAG_RE.test(text)) {
    return text;
  }

  let result = text;
  for (const [openRe, closeRe] of THINK_TAG_PAIRS) {
    let safety = 0;
    while (safety++ < 20) {
      const openMatch = openRe.exec(result);
      if (!openMatch) {
        break;
      }

      const closeMatch = closeRe.exec(result);
      if (closeMatch && closeMatch.index > openMatch.index) {
        // Remove from open tag start to close tag end
        const before = result.slice(0, openMatch.index);
        const after = result.slice(closeMatch.index + closeMatch[0].length);
        result = before + placeholder + after;
      } else {
        // No matching close tag — strip from open tag to end of string
        result = result.slice(0, openMatch.index) + placeholder;
        break;
      }
    }
  }

  return result.trim();
}

export default definePluginEntry({
  id: "think-block-filter",
  name: "Think Block Filter",
  description:
    "Strips model reasoning scratchpad blocks (<think>, <THINKING>, <reasoning>, etc.) from agent replies before delivery, keeping responses clean and concise.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as ThinkBlockFilterConfig;
    if (cfg.enabled === false) {
      return;
    }

    const placeholder = typeof cfg.placeholder === "string" ? cfg.placeholder : "";

    api.on("before_agent_reply", (event, _ctx) => {
      const ev = event as { cleanedBody?: string };
      if (!ev.cleanedBody) {
        return undefined;
      }

      const filtered = stripThinkBlocks(ev.cleanedBody, placeholder);
      if (filtered === ev.cleanedBody) {
        return undefined;
      }

      // Return a modified reply — return void to let core handle delivery unchanged,
      // or signal the modified text via the reply payload shape
      ev.cleanedBody = filtered;
      return undefined;
    });
  },
});
