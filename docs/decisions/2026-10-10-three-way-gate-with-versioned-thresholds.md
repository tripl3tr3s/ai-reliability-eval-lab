# ADR: three-way go-live gate with versioned thresholds

| Field | Value |
| --- | --- |
| Date | 2026-10-10 |
| Status | Accepted. Implemented on `feat/go-live-gate` (`6a4db31`, `ca16cf9`), not yet merged. Threshold values are uncalibrated starting values. |
| Related | [Design note](../design-note.md), [unit of analysis ADR](2026-10-10-case-as-unit-of-analysis.md), [severity ADR](2026-10-10-derive-severity-by-rule.md) |

## Context

Nothing in the repository could fail a build on a quality regression. `compareBaseline` used hardcoded margins on point estimates and was reachable only from one test. A two-way pass or fail decision on 30 cases would have to either pass when it cannot tell or block when nothing was observed.

## Decision

1. `pnpm gate` returns PASS (exit 0), BLOCK (exit 1), or INCONCLUSIVE (exit 2). INCONCLUSIVE is a failing exit code and recommends more cases.
2. Thresholds live in `config/thresholds.v1.json`, validated by a zod schema at load. The file carries a version, a date, an owner, the severity rules version it was calibrated against, and a written rationale per threshold. A rationale shorter than 20 characters is a validation error.
3. Decision order:
   - BLOCK if any deterministic check fails (dataset integrity, row schema, known case ids, unique runs, complete repeats, both arms on the same cases, severity rules version match).
   - BLOCK if critical errors were observed and the one-sided Clopper-Pearson upper bound on the share of critical cases exceeds the limit.
   - BLOCK if a paired difference has its whole interval below the non-inferiority margin.
   - INCONCLUSIVE if an interval contains the margin, if there are fewer cases than the minimum, or if the critical bound exceeds the limit with no critical error observed.
   - PASS otherwise.
4. The comparison is candidate against reference, either two configurations in one file or the same configuration in a candidate file and a baseline file. Baselines are raw JSONL, never a report.
5. The output (`gate.json`, `gate.md`) records the sha256 of the raw file, baseline, dataset, thresholds, and config, computed over file bytes. No wall-clock value enters the result.
6. When the arms agree on every case, the bootstrap interval has zero width. The behaviour is an explicit threshold, `zeroWidthInterval.policy`: `warn` (default) passes with a warning, `inconclusive` refuses to pass.

## Alternatives considered

- **Literal reading of the original rule** ("BLOCK if the lower bound falls below the margin, INCONCLUSIVE if the interval spans it"). The two conditions overlap. The standard non-inferiority reading was implemented.
- **BLOCK whenever the critical bound exceeds the limit.** Rejected: a clean 4-case smoke run would be reported as harmful. BLOCK is reserved for evidence of harm.
- **Default `zeroWidthInterval.policy` to `inconclusive`.** Statistically stricter, but PASS becomes unreachable at 30 cases and the CI mock gate would always fail. Left as a one-line reviewed change for when the dataset grows.
- **Extend `src/baseline.ts`.** Rejected: its contract is point-estimate based. It is left unchanged and unused by the CLI.
- **Multiplicity correction across the three metrics.** Not applied. PASS requires all three, which does not inflate wrong passes. Wrong blocks are somewhat above nominal, the conservative direction.

## Consequences

- At n = 30 the 10% critical limit is zero tolerance: zero critical cases gives 9.5%, one gives 14.9%.
- A 3 point margin can be confirmed only when the arms almost never disagree. One to three cases failing every repeat gives INCONCLUSIVE; about four gives BLOCK. Recovery (8 cases) will often be INCONCLUSIVE.
- Changing a threshold requires a new version, date, and rationale in a reviewed change (CONTRIBUTING).
- `experimentIsComplete` in `src/report.ts` still uses a different rule (zero `bounded` or `failed` rows). The two are documented, not reconciled.
