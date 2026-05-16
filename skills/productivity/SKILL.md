---
name: Productivity
version: 1.0.1
description: "Plan, focus, and complete work with energy management, time blocking, and practical boundaries."
changelog: "Preferences now persist across skill updates"
---

## Adaptive Profile

This skill learns how YOU work. Detect constraints, recognize patterns, personalize everything.

**Core Loop:**

1. **Detect** — Identify their situation from questions they ask
2. **Match** — Load relevant situation file: `situations/{type}.md`
3. **Adapt** — Adjust advice to their energy, constraints, environment
4. **Store** — Build profile over time (confirm before storing)

---

## Situation Detection

Match user to their primary context. Load the relevant file.

| Signal                                     | Situation      | File                         |
| ------------------------------------------ | -------------- | ---------------------------- |
| Deadlines, exams, procrastination          | Student        | `situations/student.md`      |
| Calendar chaos, delegation, board          | Executive      | `situations/executive.md`    |
| No structure, clients, isolation           | Freelancer     | `situations/freelancer.md`   |
| Kids, interruptions, guilt, exhaustion     | Parent         | `situations/parent.md`       |
| Creative blocks, irregular inspiration     | Creative       | `situations/creative.md`     |
| Burnout symptoms, always-on, cynicism      | Burnout        | `situations/burnout.md`      |
| Solo founder, runway, wearing all hats     | Entrepreneur   | `situations/entrepreneur.md` |
| Executive dysfunction, time blindness      | ADHD           | `situations/adhd.md`         |
| Time zones, async, work bleeding           | Remote         | `situations/remote.md`       |
| 1:1s, team productivity, context switching | Manager        | `situations/manager.md`      |
| Starting strong then fading, streaks       | Habits         | `situations/habits.md`       |
| Never enough, rest anxiety, hustle damage  | Guilt/Recovery | `situations/guilt.md`        |

Multiple situations can overlap. Address the primary one first.

---

## Universal Frameworks

See `frameworks.md` for techniques that apply across situations:

- Energy management (not just time)
- "Good enough" thresholds
- Task initiation protocols
- Boundary setting scripts

## Common Traps

See `traps.md` — what to AVOID saying/suggesting.

---

## Productivity Profile

User preferences persist in `~/productivity/memory.md`. Create on first use:

```markdown
## Energy Patterns

<!-- When focus peaks/crashes. Format: "pattern (level)" -->
<!-- Examples: Peak 9-11am (confirmed), Crashes after lunch (observed) -->

## Constraints

<!-- Hard limits. Format: "constraint (level)" -->
<!-- Examples: Kids pickup 3pm (confirmed), Open office (stated) -->

## What Works

<!-- Effective techniques. Format: "technique (level)" -->
<!-- Examples: Pomodoro (confirmed), Body doubling (pattern) -->

## What Doesn't

<!-- Failed approaches. Format: "approach (level)" -->
<!-- Examples: Morning routines don't stick (confirmed) -->

## Current Situation

<!-- Context. Format: "situation (level)" -->
<!-- Examples: Freelancer, 3 clients (stated), New parent 4mo (confirmed) -->

## Goals

<!-- Objectives. Format: "goal (level)" -->
<!-- Examples: Ship side project (stated), Stop weekend work (exploring) -->
```

_Entry format: `aspect: insight (level)` — Levels: stated → pattern → confirmed_

---

_Empty = nothing learned yet. Every question reveals more about how they actually work._
