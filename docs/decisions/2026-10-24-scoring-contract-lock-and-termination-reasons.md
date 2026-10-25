# ADR: lock the scoring contract and record why runs stop

| Field | Value |
| --- | --- |
| Date | 2026-10-24 |
| Status | Accepted. Phase 1 of the statistical-rigor upgrade, implemented on `feat/scoring-provenance`. |
| Related | [Case as unit of analysis](2026-10-10-case-as-unit-of-analysis.md), [three-way gate](2026-10-10-three-way-gate-with-versioned-thresholds.md), [deadline post-mortem](../postmortems/2026-09-01-full-benchmark-deadline-abort.md) |

## Context

Raw JSONL is the scoring source of truth: reports and gate decisions are recomputed from it. That makes the scoring code part of every published number. Before this change nothing recorded which scorer produced a report or a gate decision, so replaying an old raw file with a newer `src/scoring.ts` could change every figure without trace.

A review of the history found no scorer edit driven by observed live outputs. The v2 scorer fix `2cc8571` (2026-08-26) predates the first smoke rows (2026-08-27). Later edits to `src/scoring.ts` (`d3854f7`, `6a4db31`) only export helpers. The v3 fix `66e4555` came from a code review of authored answers before any live v3 run. The contract is therefore frozen now, before the first live v3 run, so it stays pre-registered.

Separately, `bounded` and `failed` rows carried their cause only in the free-text `answer` ("Deadline exceeded", "Model refusal"). The planned sensitivity analysis (rerun the primary analysis without availability failures) needs that cause as a field.

## Decision

1. **Scoring contract.** `src/scoring.ts`, `src/text-es.ts`, `src/gate/severity.ts`, and `src/dataset.ts` form the scoring contract, versioned as `SCORING_CONTRACT_VERSION` (`scoring-contract-v1`). `config/scoring-contract.json` locks their sha256: each file's path and byte length, then its bytes with CRLF normalized to LF, in a fixed order.
2. A test fails whenever the files no longer match the lock. Changing the scorer means bumping the version and running `pnpm scoring-contract --write --rationale "<why>"` in a reviewed change of its own. Never rewrite the lock to make a test pass.
3. `summary.json` (`manifest.scoringContract`), `gate.json` (`inputs.scoringContract`), both Markdown outputs, and the gate's audit log entry record the version, the hash, and whether it matches the lock.
4. A report whose scorer does not match the lock stays `pending`, so the Pages workflow (which publishes only `complete` reports) cannot publish it. The gate still decides but adds a warning. A hard check that thresholds pin a contract version comes with `thresholds-v3`.
5. **Termination reasons.** Runs that end without a valid final result record `terminationReason`: `deadline`, `cancelled`, `output_limit`, `token_ceiling`, `cost_ceiling`, `output_size`, `tool_call_ceiling`, `tool_not_allowed`, `iteration_ceiling`, `invalid_final_result`, or `refusal`. Refusals also record `refusalCategory` when the provider gives one (at most 64 characters, as the adapter already bounds it). Both fields are optional; rows recorded earlier stay valid and read as reason unknown.
6. **Provider errors still abort the experiment.** Rate limits, overload, network failures, and credit exhaustion that are not agent deadlines are rethrown, as decided in the 2026-09-01 post-mortem. They leave missing cells, which make the gate BLOCK on `repeats_complete` and keep the report `pending`.

## Alternatives considered

- **Record provider errors as `failed` rows** (the first draft of the upgrade plan recommended this). Rejected: an outage or an exhausted balance would be scored as quality failures against whichever arm it hit, and a run could finish "complete" with hundreds of such rows. A missing cell fails closed instead.
- **Hash the built `dist/` files.** Rejected: the hash would change with compiler versions and differ between `tsx` and built runs. Hashing the sources ties the record to what reviewers read. An installed build without sources records the hash as unavailable and never matches the lock.
- **Hash the whole `src/` tree.** Rejected: unrelated edits (CLI, providers) would force contract bumps and make the lock meaningless.
- **Leave `src/dataset.ts` out.** Rejected after review: its zod defaults (plan `ordered`, matcher `invocation`, `forbiddenTools`, `allowedExtraCalls`, `forbiddenValues`) decide how a case is scored, and the manifest hash pins only the case file, not those defaults. Including it means loading or validation edits also need a contract bump, which is the price of a complete lock.
- **Change `policyViolation`, which is set for every `bounded` run.** Kept as it is: recovery and report completeness depend on it, and changing it would change scores of existing rows. It is documented at the assignment in `src/experiment.ts`.

## Consequences

- Any scorer edit now shows up as a failing test and a new contract version, which is the evidence that it was not tuned on observed outputs.
- `pnpm scoring-contract` prints the contract and exits 1 when it does not match the lock.
- A parent cancellation before the first model call is now labelled `cancelled`, not a deadline. The outcome is still `bounded`.
- Reports and gate decisions produced before this change render "Scoring contract: not recorded".
- An installed build without `src/` and `config/` cannot hash the contract, so its reports stay `pending`. Publishable reports come from a repository checkout.
- The lock writer refuses to overwrite a lock whose version equals the current `SCORING_CONTRACT_VERSION` but whose hash differs, so a contract change cannot be locked without a version bump. A corrupt lock fails with a clear error instead of being treated as missing.
