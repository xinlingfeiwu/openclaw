import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// A stable, byte-identical marker appended to every system prompt.
// Because it never changes between turns, Anthropic's automatic prefix-cache
// can cache the entire system prompt up to (and including) this boundary,
// cutting repeated input-token costs by up to 75%.
const DEFAULT_ANCHOR = "<!-- openclaw:system-context-boundary -->";

type PromptCacheAnchorConfig = {
  enabled?: boolean;
  anchor?: string;
};

export default definePluginEntry({
  id: "prompt-cache-anchor",
  name: "Prompt Cache Anchor",
  description:
    "Appends a stable, byte-identical anchor to the system prompt so Anthropic automatic prefix-cache hits cover the full system context.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as PromptCacheAnchorConfig;
    if (cfg.enabled === false) {
      return;
    }

    const anchor =
      typeof cfg.anchor === "string" && cfg.anchor.trim().length > 0 ? cfg.anchor : DEFAULT_ANCHOR;

    // appendSystemContext: position after all other system context fragments.
    // Must stay byte-identical every turn for the cache to hit.
    api.on("before_prompt_build", (_event, _ctx) => {
      return { appendSystemContext: anchor };
    });
  },
});
