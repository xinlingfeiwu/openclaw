# OpenClaw Adaptation Notes

This skill is installed in a shared skills directory for all five agents.

## Why this adaptation exists

OpenClaw handoffs often work better with an operational continuation format than
with a purely narrative summary. In practice, the highest-value sections are:

1. Decisions
2. Open TODOs
3. Constraints/Rules
4. Pending user asks
5. Exact identifiers
6. Files changed/read
7. Commands / validations run
8. Current status
9. Next aligned step

## Usage

Standard upstream template:

```bash
python3 {baseDir}/scripts/render_template.py
```

OpenClaw-oriented template:

```bash
python3 {baseDir}/scripts/render_openclaw_template.py
```

## Mapping from upstream nine sections

- primary request and intent -> Pending user asks / Current status
- key technical concepts -> Constraints/Rules
- files and code sections -> Files changed/read
- errors and fixes -> Commands / validations run + Current status
- problem solving -> Decisions
- all user messages -> Pending user asks / Constraints/Rules
- pending tasks -> Open TODOs
- current work -> Current status
- next aligned step -> Next aligned step
