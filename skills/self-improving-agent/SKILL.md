# Self-Improving Agent Skill

_Based on pskoett/self-improving-agent v1.0.11 — manually installed_

## When to Activate

Activate this skill when **any** of these occur:

1. A command or tool call fails unexpectedly
2. The user corrects your behavior or output
3. You discover a better approach after already trying something
4. You repeat a mistake you've made before

## Core Protocol

### Step 1 — Capture the Learning

Immediately write to the agent's daily memory file (`memory/YYYY-MM-DD.md`):

```markdown
## [Self-Improvement Log HH:MM]

- **Trigger**: [what happened — error message / user correction / insight]
- **Wrong approach**: [what you did or assumed]
- **Correct approach**: [what actually works]
- **Rule**: [one-line rule to remember]
```

### Step 2 — Update AGENTS.md (if systemic)

If the lesson applies broadly (not just today), add a concise rule to `AGENTS.md` under a `## Lessons Learned` section.

### Step 3 — Check Before Repeating

Before attempting any task similar to a past failure:

1. Scan today's memory file for relevant lessons
2. Scan AGENTS.md `## Lessons Learned`
3. Apply the lesson proactively

## Format Example

```markdown
## [Self-Improvement Log 14:32]

- **Trigger**: ffmpeg loudnorm failed with `print_format=quiet` — Invalid argument
- **Wrong approach**: Used `loudnorm=I=-16:TP=-1.5:LRA=11:print_format=quiet`
- **Correct approach**: Remove `print_format` param — not supported in this ffmpeg build
- **Rule**: Never use `print_format` in ffmpeg loudnorm filter on this machine
```

## Scope

- This skill applies to ALL agents (main + product/tech/finance/market sub-agents)
- Each agent writes to their own workspace memory file
- Shared systemic lessons go into each agent's AGENTS.md

## Key Principle

**Never make the same mistake twice.** Every failure is data. Capture it, learn from it, move on.
