---
name: threat-model-lite
description: Run a lightweight STRIDE threat model for a feature or system in about 30 minutes. Use when designing or reviewing anything that handles user input, credentials, personal data or external integrations.
---

# Threat model (lite)

Write `threat-model.md`:

1. **What are we building?** One paragraph and a data-flow sketch (Mermaid): actors, components, data stores,
   and the **trust boundaries** between them.
2. **Assets.** What is worth protecting: data, credentials, availability, money, reputation.
3. **Entry points.** Every place untrusted input enters: APIs, files, queues, webhooks, UI, dependencies.
4. **Threats (STRIDE)** per entry point or boundary:

| Element | Spoofing | Tampering | Repudiation | Info disclosure | Denial of service | Elevation of privilege |
|---|---|---|---|---|---|---|

5. **Top risks.** Rank by likelihood × impact. For the top 5:

| Risk | Likelihood | Impact | Mitigation | Owner | Status |
|---|---|---|---|---|---|

6. **Out of scope / accepted risks**, with the reason.

Prefer mitigations that remove a class of problem (parameterized queries, least privilege, secrets in a store)
over ones that patch one instance. Model only systems the team builds; never probe real or third-party systems.
