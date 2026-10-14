---
name: adr-writing
description: Write an Architecture Decision Record for a decision that is costly to reverse. Use when choosing between technologies, designs or approaches, or when asked to record a decision.
---

# Writing an ADR

Write one ADR per decision, as `adr/NNNN-short-title.md` (numbered, never renumbered).

```markdown
# NNNN. <Decision in a few words>

- Status: proposed | accepted | superseded by NNNN
- Date: YYYY-MM-DD

## Context
The forces at play: the problem, constraints, quality attributes that matter, what we know and do not know.

## Options
| Option | Pros | Cons | Cost / effort | Reversible? |
|---|---|---|---|---|

## Decision
We will … because …

## Consequences
What becomes easier, what becomes harder, what we must now do, and what would make us revisit this.
```

Rules:
- Include at least two real options; "keep the current approach" counts.
- The decision sentence names the option and the main reason.
- Consequences include the downsides you accept.
- Also record it on the team with the `record_decision` tool (same title and decision).
- Generalized descriptions only; no confidential names or details.
