# ADR: gate dataset v3 with Bonett-Price on the all-pass outcome (thresholds-v3)

| Field | Value |
| --- | --- |
| Date | 2026-10-24 |
| Status | Accepted. Phase 4 of the statistical-rigor upgrade, on `feat/gate-thresholds-v3`. Pre-registered: no live v3 run exists. |
| Depends on | [Scoring contract lock](2026-10-24-scoring-contract-lock-and-termination-reasons.md) (PR #3), [binary methods checked against evalstats](2026-10-24-binary-methods-checked-against-evalstats.md) (PR #4) |
| Supersedes | `config/thresholds.v2.json` as the default for dataset v3. The file stays loadable with `--thresholds`. |

## Context

`thresholds-v2` decides non-inferiority on a percentile paired bootstrap of per-case pass rates. At 90 cases the bootstrap undercovers, and when the arms agree on every case it collapses to a zero-width interval that clears any margin (ambiguity register item 1). The analysis plan was revised before the first live v3 run:

- **Primary estimand: every repeat passed.** One binary outcome per case.
- **Interval:** two-sided 95% Bonett-Price adjusted Wald interval for paired proportions, evalstats' default for binary data at every N.

Bonett-Price never has zero width, which also shows what 90 cases can demonstrate. With perfect agreement, the lower bound is -3.01 points at 90 cases and -13.86 points at the 18 recovery cases. The 3 point margins of `thresholds-v2` therefore cannot pass under any outcome.

## Decision

1. `config/thresholds.v3.json` adds an `analysis` block:
   - `primaryEstimand: all-pass` and `nonInferiorityInterval: bonett-price`.
   - The pinned `statsMethodsVersion` (`stats-methods-v2`) and `scoringContractVersion` (`scoring-contract-v1`), each checked by the gate as a deterministic check. A mismatch, or a scorer that does not match its lock, is BLOCK.
2. **Margins**, chosen by the owner on 2026-10-24 from the boundaries below. The test `tests/gate/thresholds-v3.test.ts` asserts every boundary quoted in the rationales.

| Metric | Cases | Margin | PASS | INCONCLUSIVE | BLOCK |
| --- | --- | --- | --- | --- | --- |
| Completion, tool accuracy | 90 | 5 points | Without wins, at most 1 lost case; wins offset losses only partly (1 each way passes, 3 wins with 2 losses passes) | 2 losses without wins, 2 each way, or 1 win with 2 losses, up to 11 losses | 12 or more lost cases |
| Recovery | 18 | 15 points | No lost case (wins still pass) | 1 to 8 lost cases, even beside a win | 9 or more lost cases |

3. The per-case pass rate is reported beside each decision with the case-clustered Bonett-Price interval and its inverted p-value, along with the McNemar mid-p of the primary outcome. None of them is gated. A gap between the two estimands means the arms differ in how consistently they pass, not only in how often.
4. The critical-error bound is unchanged: one-sided 95% Clopper-Pearson, limit 3.5% (zero tolerance at 90 cases).
5. There is no multiplicity correction. PASS needs every metric to clear its margin, which is an intersection-union test, so the chance of a wrong PASS is not inflated.
6. `bootstrap` and `zeroWidthInterval` are now optional in the schema. The legacy analysis requires both, and Bonett-Price rejects them because they would do nothing. `thresholds-v1` and `thresholds-v2` are unchanged byte for byte, and their decisions on the mock runs are identical to `main` on every shared field.

## Alternatives considered

- **Keep 3 point margins.** Rejected by the owner: PASS would be unreachable at 90 cases, so the gate could only BLOCK or say INCONCLUSIVE.
- **One-sided 95% interval at 3 points.** It passes only with zero discordance, and it reverses register item 7, which chose the two-sided interval as the stricter one.
- **Report recovery only, without gating it.** Rejected in favor of a 15 point margin, the tightest that can pass with 18 cases.
- **Per-case pass rate as the primary estimand.** It is still selectable (`primaryEstimand: per-case-rate` gates on the clustered interval), but the clustered interval is a multi-run method evalstats has not validated, and every-repeat-passed matches the harm model of a production agent that runs once.

## Consequences

- The clean scripted mock passes under `thresholds-v3` without the zero-width warnings `thresholds-v2` emitted. The regressed mock still blocks.
- Small real differences will be INCONCLUSIVE more often than under the bootstrap, especially near the ceiling, where Bonett-Price over-covers. INCONCLUSIVE fails CI (exit 2), so the gate stays safe; the cost is that a candidate may need more cases to be promoted.
- 5 and 15 points are coarse. Tightening them needs more cases: every margin above is a property of 90 and 18 cases, not of the arms.
- The absolute floor gap (design note 6a) is still open.
