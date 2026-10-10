# ADR: gate a scripted mock run in secretless CI

| Field | Value |
| --- | --- |
| Date | 2026-10-10 |
| Status | Accepted. Implemented on `feat/go-live-gate` (`6a4db31`), not yet merged. |
| Related | [Gate ADR](2026-10-10-three-way-gate-with-versioned-thresholds.md), [post-mortem 2026-09-01](../postmortems/2026-09-01-full-benchmark-deadline-abort.md) |

## Context

The pull request job was described as a validation and replay gate, but it replayed one hand-built row and applied no thresholds. No recorded run, fixture, or baseline is committed: `runs/` is gitignored and no complete live run exists. The gate needed a data source that costs nothing, needs no secret, and cannot be mistaken for a result.

## Decision

1. `src/mock/scripted-model.ts` is a deterministic `ModelAdapter`. It recognises the case from the prompt, walks the case's first accepted plan one tool call per turn, fills required tool arguments from the tool schema, and returns the final JSON. Cost is zero and the model id starts with `mock-`.
2. `pnpm mock:run` runs it through the real planner, runner, tools, fault schedule, and persistence. A `policyOverrides` input on `runExperiment` shortens the tool timeout so the timeout-fault case does not wait 10 seconds per run.
3. Two profiles: `clean` (always correct) and `regressed` (without injected resources, every third case answers wrongly and write cases attempt an unplanned write).
4. `pnpm gate:mock` runs the clean profile and the gate. It is one added step in `.github/workflows/ci.yml`. Tests spawn the real CLI and assert exit codes 0, 1, and 2.
5. Mock data is marked at three levels: the model id prefix, `dataSource: "mock"` in the gate output, and a report status forced to `pending` so the Pages workflow can never publish it.

## Alternatives considered

- **Commit a recorded live run as a fixture.** Rejected: no complete run exists, and committing real results before review conflicts with the baseline promotion rule.
- **Hand-built raw rows only.** Kept for unit tests (`tests/helpers/synthetic.ts`), but it bypasses the runner and tools, so it does not prove the pipeline.
- **A random-failure mock.** Rejected: a deterministic regression gives a fixed, assertable outcome.

## Consequences

- CI now fails if the gate, the runner, or the scripted path through the dataset breaks.
- The clean mock gate passes through the zero-width interval rule, with a warning. Its PASS is a pipeline check, not evidence about any model.
- The scripted model depends on the dataset shape (accepted plans, required assertions). A dataset v3 would need it updated.
- Mock output is not byte-reproducible because raw rows record measured latency. The gate does not use latency.
