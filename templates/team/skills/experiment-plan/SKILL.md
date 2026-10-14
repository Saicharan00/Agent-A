---
name: experiment-plan
description: Plan an ML or data experiment before running it - hypothesis, data, metrics, baseline and success criteria. Use before training models, running A/B tests or comparing approaches.
---

# Experiment plan

Write `experiment-plan.md` before any training run:

```markdown
# Experiment: <name>

## Hypothesis
If we <change>, then <metric> will <improve by X> because <reason>.

## Decision this informs
What we will do differently depending on the result.

## Data
Source (synthetic/public), size, time range, split strategy (random / time-based / grouped) and why.
Known risks: leakage, label noise, imbalance, drift.

## Metrics
Primary metric (tied to the decision), secondary metrics, guardrail metrics that must not get worse.

## Baseline
The simplest thing that could work, and its expected score.

## Runs
| Run | Change vs baseline | Config | Seed(s) |
|---|---|---|---|

## Success criteria
The threshold that counts as a win, and the minimum effect size worth shipping.

## Results (fill in after)
Table with mean ± spread across seeds, error analysis by segment, conclusion, next experiment.
```

Rules: one variable per run; fix seeds; record data and code versions; report the baseline next to every result.
