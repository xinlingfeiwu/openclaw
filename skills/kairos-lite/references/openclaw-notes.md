# OpenClaw Notes for Kairos Lite

This skill should be used with explicit user opt-in and bounded schedules.

## OpenClaw-specific guidance

- Prefer `openclaw cron add` for recurring jobs; never edit `~/.openclaw/openclaw.json` directly.
- Use explicit message delivery inside the job when proactive reporting is required.
- Give every proactive job an expiry/review point.
- Keep briefs short and user-facing.
- Avoid hidden mutation; background jobs should report what they changed.

## Good fits in this workspace

- daily repo patrols
- timed follow-up checks
- expiry-bound reminder jobs
- concise operational reports
