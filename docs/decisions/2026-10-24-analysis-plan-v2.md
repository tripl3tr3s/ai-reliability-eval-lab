# ADR: report analysis plan v2

| Field | Value |
| --- | --- |
| Date | 2026-10-24 |
| Status | Accepted. Phase 3 of the statistical-rigor upgrade, on `feat/report-statistics-v2`. Pre-registered: no live v3 run exists. |
| Depends on | [Scoring contract lock](2026-10-24-scoring-contract-lock-and-termination-reasons.md) (PR #3), [binary methods checked against evalstats](2026-10-24-binary-methods-checked-against-evalstats.md) (PR #4) |
| Related | [thresholds-v3 gate](2026-10-24-thresholds-v3-bonett-price-gate.md) (PR #5), which applies the same primary outcome and interval to the go-live decision |

## Context

The report led with a row-level table (every run counted as one observation), its main intervals were percentile bootstraps, McNemar was the exact conditional test, pass^k was the plug-in estimate, p95 latency and cost per task used successful runs only, and nothing said how runs stopped or what the intervals cover. The plan fixed on 2026-10-24 makes the binary every-repeat-passed outcome primary, with methods evalstats uses for binary data at every sample size.

## Decision

`summary.json` gains these keys under `statistics`, all additive. Existing keys are unchanged, and the bootstrap sections stay, labelled legacy.

| Key | What it holds | Method |
| --- | --- | --- |
| `method.version`, `method.reference`, `method.primaryEstimand`, `method.intervals` | `stats-methods-v2`, evalstats 0.3.3, `all-pass`, and the method id behind each block | `src/stats/methods.ts` |
| `primary` | Per arm and metric: cases passing every repeat, Wilson 95%, rank band. Per pair: discordant counts, Bonett-Price interval at the Sidak level, McNemar mid-p, Shaffer-adjusted p, verdict | Wilson, Bonett-Price, mid-p, Sidak, Shaffer |
| `secondary` | Mean per-case pass rate with Wilson on per-case rates; paired difference with the case-clustered Bonett-Price interval and its inverted p-value, Shaffer-adjusted | Multi-run, not validated by evalstats; informs, never decides |
| `stability` | Mixed cases, ICC(1) with design effect, unbiased pass^k and pass@k at k = smallest repeat count | Labelled `validated: false` |
| `outcomes` | Runs by outcome and by `terminationReason` (`not_recorded` for older rows) | Counts |
| `sensitivity` | The primary comparisons repeated without every case that had a bounded or failed run in any arm | Same as primary |
| `efficiency` | Mean cost and latency per case over every run; paired geometric-mean ratio with a Student t interval on the mean log ratio; a cost-and-quality label per arm | Student t (`t_interval_ci_1d`), checked against evalstats and scipy |
| `scope` | What the intervals cover and what they do not | Text |

Rules fixed here:

1. **Multiplicity.** Sidak at a 95% family level over the comparisons of one metric: no correction for the two v3 arms, 98.30% per interval for the three v2 arms. Shaffer adjusts the p-values within a metric. Metrics are not pooled into one family; the report describes, and the gate decides with an intersection-union rule that needs no correction.
2. **Verdicts.** A configuration is named better only when its interval excludes zero. The p-values are reported beside it and do not drive it; Shaffer's step-down can be less conservative than Sidak, so with three or more arms a row can show an adjusted p below 0.05 and no verdict. From four arms the Shaffer counts are the full set, which is stricter than evalstats 0.3.3 (fixtures cover up to three groups). Each comparison counts the paired cases whose arms have a different number of scored repeats, which only missing runs produce. "No significant difference" is never read as equivalence; the scope statement says so.
3. **Rank band.** For each arm and metric, 1 plus the arms significantly better, to the number of arms minus those significantly worse.
4. **Cost and latency** are averaged per case over every run, so failing does not make an arm cheaper. Cases with a zero mean cost in either arm have no ratio; they are left out and counted (`casesWithoutCost`). The ratio is not estimable when fewer than two cases remain (every mock run) or the log ratios have no spread; the t interval then reports nothing instead of a zero-width point. Latency includes provider queueing and is descriptive only.
5. **Cost and quality label.** An arm is dominated only when another arm is significantly better on primary completion and significantly cheaper. It is on the frontier when every other arm is significantly worse than it on one of the two, and ambiguous otherwise.
6. **Layout.** The headline table shows the primary outcome per arm. The row-level table and its per-run bootstraps move to an appendix after Reproducibility, which now names the statistics version.

`pnpm report:mock:v3` builds the mock v3 report and runs `report-check`, which fails when the methods version is stale or a block is missing or short. CI runs it.

## Alternatives considered

- **Logit-t on per-case rates and a paired t on rate differences** for the secondary. Dropped in phase 2: evalstats' default for binary multi-run data is the Wilson and Bonett-Price family above.
- **Replace the bootstrap sections.** Kept and labelled legacy instead, so a report written before this change can be compared line by line.
- **Pareto on latency.** Rejected: latency is not reproducible across runs of the same configuration.
- **A seeded noisy mock profile** so CI exercises non-degenerate intervals. Deferred to its own PR after the thresholds-v3 gate merges, because its expected gate decision depends on which thresholds the branch has.

## Consequences

- The report no longer leads with a number that counts repeats as independent observations.
- Every interval in `primary` and `secondary` has nonzero width, so a mock run with identical arms shows the width 90 or 30 cases allow (about plus or minus 3 points at 90 cases).
- `report.md` and `index.html` change layout. Byte-identical replay still holds: every new method is deterministic.
