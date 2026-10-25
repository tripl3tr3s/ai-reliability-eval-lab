# ADR: small-sample binary methods, checked against evalstats

| Field | Value |
| --- | --- |
| Date | 2026-10-24 |
| Status | Accepted. Phase 2 of the statistical-rigor upgrade, implemented on `feat/stats-methods-v2`. Not yet used by the report or the gate (phases 3 and 4). |
| Related | [Case as unit of analysis](2026-10-10-case-as-unit-of-analysis.md), [three-way gate](2026-10-10-three-way-gate-with-versioned-thresholds.md) |
| Reference | evalstats 0.3.3 (MIT, github.com/ianarawjo/evalstats), wheel sha256 `6210f51f7d6c476644e7d8a5854c5a9600b773f3980dd52ed8ae83964d1b5a7e` |

## Context

The gate decides non-inferiority on a percentile paired bootstrap (`src/gate/decision.ts`), and the report shows percentile cluster bootstraps and an exact McNemar test. evalstats, which was built and simulation-validated for evals with N < 100, does not use bootstrap intervals by default at these sizes and recommends against the exact conditional McNemar test. The primary estimand chosen for the next analysis plan is **every repeat passed**, one binary outcome per case, with the per-case pass rate as a secondary estimand.

Before writing code, the evalstats source was read at version 0.3.3 to confirm its defaults (`config.AUTO_ANALYZE_METHOD_TABLE` and the functions below), instead of relying on summaries of the paper.

## Decision

New functions in `src/stats`, dependency-free, under `STATS_METHODS_VERSION = "stats-methods-v2"`:

| Function | evalstats counterpart | Use |
| --- | --- | --- |
| `bonettPriceInterval` | `bonett_price_paired_ci` | Paired difference of the primary binary outcome. evalstats' default for binary data at every N |
| `mcnemarMidP` | `tests._mcnemar_midp_p` | p-value paired with the single-run Bonett-Price interval |
| `bonettPriceClusterInterval` | `bonett_price_paired_ci_multirun_cluster` | Paired difference of per-case pass rates over repeats (secondary) |
| `pValueByInversion` | `paired._p_value_by_inversion` | p-value for the clustered interval: evalstats validates no p-value on multi-run data, so it uses the interval's dual |
| `wilsonOnCaseRates` | `wilson_ci_1d` on per-case means ("Wilson flat") | Marginal interval on per-case rates |
| `sidakConfidence` | `paired._sidak_simultaneous_cis` | Simultaneous intervals, evalstats' default for binary data at every N |
| `shafferAdjust` | `stats_utils._shaffer_adjusted_pvalues` | p-value adjustment for three or more arms |
| `iccOneWay` | none (see below) | Stability summary per arm |
| `passPowerKUnbiased`, `passAtKUnbiased` | none | Unbiased replacements for the plug-in pass^k and pass@k |

Wilson and Clopper-Pearson already existed. Clopper-Pearson stays as the one-sided bound for critical errors: a safety limit should be conservative, and Wilson would loosen it (0 of 90 gives 2.9% instead of 3.3%).

### Where this deliberately departs from evalstats

1. **Clustered, not shrunk, multi-run Bonett-Price.** evalstats 0.3.3 routes multi-run binary data to `bonett_price_paired_ci_multirun_shrunk`. That variant uses u_i = mean over r of |A_ir - B_ir|, which pairs repeat r of one arm with repeat r of the other. That pairing means something only when runs share a seed across arms. In this benchmark repeats are independent draws with no shared seed, so u_i would change if repeats were relabelled. The clustered variant uses only the per-case rate differences, so it does not depend on repeat labels. evalstats' own calibration sweep also reports a better worst case for it (minimum coverage 0.944 against 0.930), at about 6% more width.
2. **Shaffer for three or more arms at any N.** evalstats switches to the Romano-Wolf bootstrap step-down at N >= 30. Shaffer controls the family-wise error at every N without resampling and costs some power. Only the three-arm v2 report is affected, since v3 compares two arms.
3. **Standard ICC(1).** evalstats estimates an ICC only inside `wilson_nested_de`, approximating the within-case variance as p(1 - p) and clipping to [0, 1]. The report needs the textbook one-way ANOVA ICC(1), with the adjusted group size k0 for unequal repeats and without clipping, so a negative value is visible. Its reference values come from an independent numpy implementation, not from evalstats.

### Scope moved out of this phase

The first plan also listed logit-t, a paired t-interval, and the Wilcoxon signed-rank test. evalstats routes binary data with repeats to the Bonett-Price family and Wilson, so none of them is needed for the quality metrics. A t-interval returns in phase 3 for cost and latency, which are unbounded.

## Validation

- `tests/stats/reference/evalstats_reference.py` imports the evalstats functions above and writes `tests/stats/reference/evalstats-fixtures.json`: 96 reference cases plus 5 ICC and pass^k cases. The file records evalstats 0.3.3, numpy 2.5.4, scipy 1.18.1, Python 3.12.12, the seed, and the script's sha256. `tests/stats/evalstats.test.ts` fails if the script changes without the fixtures being regenerated. The script is run by hand with `uv`; CI stays Node-only and secretless.
- Agreement: values that use a normal quantile agree within 1e-9 (the limit of `normalQuantile`, Acklam's approximation; the tests allow 1e-8). Exact values (mid-p, Shaffer, ICC, pass^k) agree within 1e-15.
- `tests/stats/coverage.test.ts` runs 2 000 seeded simulations per scenario. The criteria were fixed before the first run: mean coverage within 2 points of 95%, no scenario below 90%, and up to 99% for the conservative Bonett-Price forms. Observed:

| Method | n = 30 (mean / min) | n = 90 (mean / min) |
| --- | --- | --- |
| Wilson, 19 true rates from 0.05 to 0.95 | 95.3% / 92.6% | 95.5% / 94.0% |
| Bonett-Price, 8 discordance and difference scenarios | 97.9% / 94.4% | 96.7% / 94.6% |
| Clustered Bonett-Price, 5 repeats, 3 scenarios | 98.4% / 98.0% | 96.8% / 96.4% |

## Consequences

- Phase 3 (report) and phase 4 (gate on `thresholds-v3`) can switch to these methods. The percentile bootstrap stays in the code for `thresholds-v1` and `thresholds-v2`, so earlier decisions replay unchanged.
- Bonett-Price never gives a zero-width interval, so ambiguity register item 1 (the zero-width bootstrap interval) disappears under `thresholds-v3`.
- The clustered interval and the ICC are multi-run methods. evalstats does not yet publish validation for multi-run methods, so `STATS_METHODS` labels both as not yet validated, and the report must say so.
- Regenerating the fixtures needs network access and about 25 Python packages in uv's cache. Nothing in CI depends on it.
