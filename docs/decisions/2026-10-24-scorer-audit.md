# ADR: blinded human audit of the scorer

| Field | Value |
| --- | --- |
| Date | 2026-10-24 |
| Status | Accepted. Phase 5 of the statistical-rigor upgrade, on `feat/scorer-audit`. Tooling only: no live run has been audited yet. |
| Depends on | [Scoring contract lock](2026-10-24-scoring-contract-lock-and-termination-reasons.md) (PR #3) |

## Context

The scorer is deterministic and checked against authored answers: every v3 case has a reference answer that must pass and at least three counterexamples that must fail. That shows the scorer accepts what its authors wrote, not that it agrees with a person reading live model answers. Until it is measured, a completion figure carries an unknown scorer error. There is no LLM judge, so prediction-powered inference does not apply: the audit measures the scorer directly.

## Decision

1. **What is audited.** The completion verdict, the primary metric of the report and the gate. One label per item: pass, fail, or unsure.
2. **Sample.** `pnpm scorer-audit:sample --raw <raw.jsonl> --config <config>` stratifies the scored runs by configuration and scorer verdict, draws up to 40 cases per stratum (`--per-stratum`) with the experiment seed (`--seed`), and takes one run of each drawn case, so within a stratum the items are distinct cases and the Wilson interval applies. Across strata a case can recur: the other arm ran it too, and a case with mixed repeats sits in both verdict strata of one arm. Preventing that is impossible at v3's size (four strata of 40 need 160 items from 90 cases), so the labeler is told that prompts can repeat and to judge each item on its own. The draw is seeded and reproducible.
3. **Blinding.** The labeler gets `to-label/labels-template.json`: the prompt, the reference answer (v3 only) and the run (outcome, answer, claims, tool calls, final state). The scorer's own checks (acceptable fact sets, expected state, forbidden tools and claims, accepted plans) are not shown: a labeler who judges against them repeats the scorer and misses its blind spots, which would make agreement look higher than it is. v2 cases have no reference answer, so v2 labels rest on the prompt and the run alone. Items are numbered after shuffling across strata. The configuration, run id, model ids, cost, latency, routing tier and scorer verdict are left out; `key/key.json` maps items back and must stay away from the labeler, so the two are written to sibling folders and the `to-label` folder can be handed over alone. Blinding covers metadata, not content: the labeler has to see the outcome (a bounded run did not finish), the tool calls and the final state to judge the run, and those can hint at the verdict or, through answer style, at the model. Both v3 arms use the same tools, so tool names do not identify the arm.
4. **Labeler.** Recorded by role, never by name: the schema accepts lowercase words ending in `-reviewer`, `-labeler`, `-annotator`, `-auditor` or `-expert` (for example `fiscal-reviewer`). A role word cannot prove the rest is not a name; the rule makes the intent explicit.
5. **Score.** `pnpm scorer-audit:score --key <key.json> --labels <filled template> --output <dir>` writes `agreement.json` and `agreement.md`:
   - per configuration, the **false pass** rate (scorer passed, labeler failed) and the **false fail** rate (scorer failed, labeler passed), each with a Wilson 95% interval;
   - run-level agreement: within a stratum each labeled case counts with its runs in that stratum (a ratio estimator, since cases were drawn uniformly), and strata are weighted by their runs. A point estimate without an interval; a stratum without labels is left out with a warning;
   - counts of unsure and unlabeled items, which enter no rate.
6. **Validation.** The key must be internally consistent (unique items and strata, item counts equal to `sampled`, at most one item per case per stratum, `sampled <= cases <= runs`), and every label's case must match the key's, so labels from another audit are rejected.
7. **Provenance.** The key records the raw file's sha256, the dataset version and hash, the scoring contract, and whether the rows are mock. Scoring warns when the checkout's scorer differs from the one the sample was drawn with; the scorer verdicts in the key are the ones audited either way.
8. **Safety.** Sampling refuses to overwrite an existing key or template (checked, then written with exclusive create), and removes the key if the template cannot be written. Scoring replaces `agreement.json` and `agreement.md`, which are derived files.

## Sizing

A stratum of n items with zero disagreements bounds its rate by the Wilson 95% upper limit: 8.8% at 40, 11.4% at 30, 16.1% at 20. For v3 (two arms), four strata of 40 are 160 items. A failed stratum can hold fewer cases than 40; the tool then takes all of them and the interval widens accordingly. A false pass rate above a few percent matters most: it inflates completion directly, and the gate's 5 point margin is of the same order.

## Alternatives considered

- **Label every run.** About 900 for v3: too many for one reviewer, and repeats of one case add little.
- **Simple random sample over all runs.** Failed runs are a minority, so false fails would get almost no items.
- **Audit tool accuracy and critical errors as well.** Deferred: those are mechanical checks of recorded tool calls; completion is where the scorer reads free text.
- **Show the scorer's reasons or checklist to the labeler.** Rejected: it anchors the label on the scorer. A two-pass design (label first, then see the checklist and optionally revise) was considered; it adds a second label to reconcile and is left for later if blind labels prove too hard.

## Consequences

- A completion figure can be quoted with a measured scorer error. The runbook requires an audit before that.
- Labels and keys are plain JSON under `audits/` and can be committed: the dataset and tools are synthetic, and the labeler is a role.
- The audit samples one run per case, so its rates describe cases drawn within a stratum rather than every run; with five repeats that agree, the two are close.
