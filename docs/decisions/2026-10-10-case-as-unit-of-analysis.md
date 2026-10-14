# ADR: the case is the unit of analysis

| Field | Value |
| --- | --- |
| Date | 2026-10-10 |
| Status | Accepted. Implemented on `feat/go-live-gate` (`add842e`, `d3854f7`), not yet merged. |
| Related | [Design note](../design-note.md), [gate decision ADR](2026-10-10-three-way-gate-with-versioned-thresholds.md) |

## Context

The benchmark runs 30 cases, 3 configurations, 5 repeats. `aggregateScores` in `src/scoring.ts` pooled the 150 rows of a configuration and bootstrapped them as independent observations. Repeats of one case share a prompt, fixture, and fault schedule, so they are correlated and every published `ci95` was too narrow. `src/baseline.ts` computed an interval but decided on the point estimate. There was no statistics code beyond a row-level bootstrap, and no statistics dependency.

## Decision

1. Every interval and test treats the case as the independent unit (n = 30). Per-configuration intervals use a cluster bootstrap that resamples cases and keeps all repeats together. Comparisons between configurations are paired within case.
2. Statistics live in `src/stats` with no dependencies: Wilson, Clopper-Pearson (bisection on the exact binomial tail), exact McNemar, seeded percentile bootstrap, pass@k and pass^k per case, and a minimum detectable effect helper.
3. Correctness is established against scipy reference constants pasted into the tests. The generating script is kept in `tests/stats/reference/scipy_reference.py`.
4. McNemar needs one binary outcome per case. The primary rule is "every repeat passed"; "majority passed" is reported as a sensitivity check.
5. The existing row-level `ci95` fields stay in `summary.json` unchanged and are labelled row-level. New case-level statistics are added next to them.
6. The report states what the sample size can and cannot detect, computed from n and the observed discordance.
7. The report command takes run timestamps from telemetry events, never from the wall clock, so the same raw JSONL gives byte-identical output.

## Alternatives considered

- **Keep pooling rows.** Rejected: it overstates certainty by treating 5 correlated repeats as 5 samples.
- **Replace the old `ci95` fields.** Rejected: it changes the meaning of published fields. Adding and labelling is backward compatible.
- **Add a statistics library.** Rejected: the functions needed are small, and an independent reference check is stronger evidence than trusting a dependency.
- **BCa bootstrap.** Deferred: better coverage at small n, but more code to verify. Percentile is simple and reproducible.
- **Unbiased pass^k estimator.** Not used: the plug-in formulas p^k and 1 - (1 - p)^k were specified. They are biased when k equals the number of repeats.

## Consequences

- Intervals are wider and honest. With 30 cases, a paired difference is detectable only when roughly a quarter of cases disagree.
- More repeats no longer look like more evidence. The way to narrow an interval is more cases.
- `buildReport` runs 18 bootstraps of 10 000 resamples and takes several hundred milliseconds.
- Two sets of intervals exist in `summary.json`. Readers must use the case-level ones for decisions.
- Without `--events`, report timestamps read `unknown`.
