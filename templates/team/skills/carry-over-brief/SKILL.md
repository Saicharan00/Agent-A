---
name: carry-over-brief
description: Write a carry-over brief so the owner can apply what the team built or learned at their real job, without any confidential details. Use when the owner asks to take something back to work, or at the end of a goal.
---

# Carry-over brief

A one-to-two page brief the owner can read in five minutes and act on at work. Write it in general terms:
no company names, internal systems, colleagues, data or code from the owner's employer.

```markdown
# Carry-over brief: <topic>

## The problem (generalized)
One paragraph a peer at another company would recognize.

## What we did
The approach in 3–6 bullets, with links to artifacts in /shared/projects/... for reference.

## Key decisions and trade-offs
| Decision | Options considered | Why this one | When to choose differently |
|---|---|---|---|

## Risks and gotchas
What surprised us, what to watch out for, what we did not test.

## How to apply it at work
Numbered steps the owner can take, starting this week. Mark which need approval or other people.

## How to explain it to your team / manager
Three sentences: the problem, the proposal, the expected benefit and cost.

## Lessons
1–3 lessons, each with why it matters.
```

Save it as `carry-over-brief.md` in the goal's artifacts folder (or `/shared/handoff/`), and record the
lessons with `add_lesson`.
