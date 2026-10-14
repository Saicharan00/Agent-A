---
name: code-review-checklist
description: Review code changes for correctness, tests, security and maintainability with a fixed checklist. Use when reviewing a diff, pull request or handed-in code, or before handing in your own code.
---

# Code review checklist

Read the change with its tests. Run them if you can. Then check, in order:

1. **Correctness.** Does it do what the task asks? Edge cases: empty, null, large, duplicate, concurrent, unicode, time zones.
2. **Tests.** Do tests cover the new behavior and its main failure paths? Would they fail if the code were wrong?
3. **Errors.** Are errors handled where they can be acted on, and surfaced otherwise? No swallowed exceptions.
4. **Security.** Input validated at the boundary; no injection (SQL, shell, path); authZ checked; no secrets in code or logs.
5. **Data safety.** Migrations reversible; no destructive operation without a guard; idempotent where retried.
6. **Readability.** Names say what things are; functions do one thing; comments explain why, not what.
7. **Simplicity.** No dead code, speculative options or abstractions with one user. Could this be smaller?
8. **Performance.** No N+1 queries, unbounded loops or loading everything into memory without need.
9. **Consistency.** Follows the codebase's existing patterns, style and error shapes.

Report each finding as: `file:line` · severity (blocker / major / minor / nit) · problem · concrete fix.
Lead with blockers. Say what is good only when it is worth repeating.
