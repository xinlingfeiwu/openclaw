# OpenClaw Team Mapping

Use this mapping when coordinating the five-agent team in this workspace.

## Coordinator

- main agent (小灵): planning, routing, synthesis, final user response

## Workers

- product (小析): requirements, research, PRD, competitive analysis
- tech (小匠): implementation, debugging, architecture, DevOps
- finance (小算): budgeting, risk, compliance, unit economics
- market (小络): GTM, content, growth, distribution

## Recommended phase mapping

- research -> product / market / finance depending on domain
- synthesis -> main agent
- implementation -> tech
- verification -> tech or a separate verification pass by main agent using verification-gate

## Rule of thumb

The coordinator owns decomposition and integration.
Workers own bounded execution with explicit deliverables.
