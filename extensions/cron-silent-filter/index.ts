import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// Exact marker text produced by channel-hints cron guidance (hermes scheduler.py pattern)
const SILENT_EXACT = "[SILENT]";

type CronSilentConfig = {
  enabled?: boolean;
  /** Additional marker strings to suppress (exact match after trim). Default: [] */
  extraMarkers?: string[];
};

export default definePluginEntry({
  id: "cron-silent-filter",
  name: "Cron Silent Filter",
  description:
    'Suppresses outbound delivery when the agent replies with exactly "[SILENT]" (the cron no-op marker from channel-hints). Ported from hermes-agent scheduler.py silent delivery suppression.',
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as CronSilentConfig;
    if (cfg.enabled === false) {
      return;
    }

    const extra = Array.isArray(cfg.extraMarkers) ? cfg.extraMarkers : [];
    const markers = new Set([SILENT_EXACT, ...extra]);

    api.on("message_sending", (event, _ctx) => {
      const ev = event as { content?: string };
      const text = ev.content?.trim() ?? "";
      if (markers.has(text)) {
        api.logger.debug?.(`cron-silent-filter: suppressing [SILENT] reply`);
        return { cancel: true };
      }
      return undefined;
    });
  },
});
