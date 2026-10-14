---
name: design-review
description: Review a system or component design and give prioritized, actionable feedback. Use when asked to review a design doc, architecture, API or data model.
---

# Design review

Read the design end to end first, then go through these questions:

1. **Problem fit.** Does it solve the stated problem for the stated users? Is anything solved that nobody asked for?
2. **Simplicity.** Is there a simpler design that meets the same requirements? Count the moving parts.
3. **Boundaries.** Does each component have one responsibility? Are interfaces explicit and versioned where needed?
4. **Data.** One source of truth per entity? Consistency model stated? Retention and access defined?
5. **Failure.** What happens when each dependency is slow or down? Timeouts, retries, idempotency, back-pressure?
6. **Scale and cost.** Are the numbers written down (requests/s, data size, growth)? Where is the first bottleneck?
7. **Security.** Trust boundaries, authN/authZ, secrets, untrusted input (see `threat-model-lite`).
8. **Operability.** Can it be deployed, observed, rolled back and debugged at 3 a.m.?
9. **Reversibility.** Which decisions are hard to undo, and do they have ADRs?

Output a table, most important first:

| # | Severity (blocker / major / minor) | Finding | Why it matters | Suggested change |
|---|---|---|---|---|

End with a one-line verdict: approve, approve with changes, or rework, and the top thing to fix.
