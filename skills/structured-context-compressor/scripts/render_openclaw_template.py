#!/usr/bin/env python3
"""Render an OpenClaw-oriented continuation template.

This adapts the upstream nine-part context compressor to the continuation style
that works well for OpenClaw handoffs, compacted sessions, and sub-agent result
summaries.
"""

SECTIONS = [
    "## Decisions",
    "## Open TODOs",
    "## Constraints/Rules",
    "## Pending user asks",
    "## Exact identifiers",
    "## Files changed/read",
    "## Commands / validations run",
    "## Current status",
    "## Next aligned step",
]


def main() -> int:
    for section in SECTIONS:
        print(section)
        print("- ")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
