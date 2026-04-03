#!/usr/bin/env python3
"""Create an OpenClaw-friendly proactive job spec.

This extends the upstream Kairos Lite helper with fields that map more directly
onto OpenClaw cron/job practices used in this workspace.
"""

from __future__ import annotations

import argparse
import json


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--schedule", required=True, help="Cron expression")
    parser.add_argument("--tz", default="Asia/Shanghai")
    parser.add_argument("--expiry-days", type=int, default=7)
    parser.add_argument("--session-target", default="isolated")
    parser.add_argument("--notify", choices=["none", "brief", "report"], default="brief")
    args = parser.parse_args()

    spec = {
        "name": args.name,
        "schedule": {"kind": "cron", "expr": args.schedule, "tz": args.tz},
        "sessionTarget": args.session_target,
        "payload": {"kind": "agentTurn", "message": args.prompt},
        "expiry_days": args.expiry_days,
        "notify": args.notify,
        "notes": [
            "Create/manage via openclaw cron add, not by editing openclaw.json directly.",
            "If user-visible delivery matters, send explicitly inside the task via message tool.",
        ],
    }
    print(json.dumps(spec, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
