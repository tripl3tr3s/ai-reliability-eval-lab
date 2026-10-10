# Post-mortem: full benchmark aborted by an agent deadline during a model call

| Field | Value |
| --- | --- |
| Incident date | 2026-09-01 |
| Written | 2026-10-03 |
| Affected workflow | `Full benchmark` (`.github/workflows/full-benchmark.yml`), run [33513848803](https://github.com/tripl3tr3s/ai-reliability-eval-lab/actions/runs/33513848803) |
| Severity | High for the project: blocked the first publishable full run |
| Status | Fixed in `eae03bc` (`fix: bound agent deadline aborts during in-flight model calls`); full re-run pending |

## Summary

The scheduled full benchmark (30 cases x 3 configurations x 5 repeats = 450 jobs) stopped at job 283 with `Request was aborted.` and exit code 1. The 120-second per-agent deadline fired while a Sonnet 5 request was still in flight. The runner converted deadlines into a `bounded` outcome everywhere except around the model call itself, so the provider SDK's abort error escaped `runAgent` and the experiment loop marked the whole run as failed.

One slow provider response was enough to discard the run. It should have produced a single `bounded` result, after which job 284 would have started.

## Impact

- 282 of 450 jobs completed (completed=254, abstained=25, bounded=3, failed=0) and USD 4.5733 of API credit was spent, but no results were kept.
- `pnpm report` and `actions/upload-artifact` never ran, so neither the partial `runs/results.jsonl` nor a report survived the job.
- The public report remained pending: no complete full run exists to publish.
- The next scheduled run (2026-10-01, run 36884507240) was queued on the same unfixed commit and would have been exposed to the same failure.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 2026-08-27 07:45 | Last commit before the incident (`e6de1bb`). |
| 2026-09-01 13:30 | Scheduled full benchmark created; waits for the `full-benchmark` environment (required reviewer plus 7-minute wait timer). |
| 2026-09-01 21:56 | Trusted live smoke dispatched. |
| 2026-09-01 21:59 | Smoke passes: 24/24 jobs, USD 0.3511 of 2.00, failed=0. |
| 2026-09-01 22:07 | Full benchmark job starts after approval (about 8.5 h after creation). |
| 2026-09-01 22:51:20.28 | Job 283 starts (`v2-recovery-rate-23`, `no-resource-injection`, repeat 2). |
| 2026-09-01 22:52:06.93 | Job 283 issues its third model call. |
| 2026-09-01 22:53:21.27 | Agent deadline (120 s after job start) aborts the in-flight request; `Partial run failed: 282/450 jobs`, `Request was aborted.`, exit 1. |
| 2026-10-01 15:28 | Next scheduled run created; left waiting for approval. |
| 2026-10-03 | Diagnosis, regression tests and fix (`eae03bc`). |

## Root cause

`runAgent` (`src/runner.ts`) owns an internal `AbortController` armed with `setTimeout(..., policy.deadlineMs)` (120 000 ms from `DEFAULT_AGENT_POLICY`). Deadline handling existed in three places:

1. **Between iterations and between tool calls**: checked explicitly and returned `boundedError('Deadline exceeded', ...)`.
2. **During a tool call**: caught, recorded as a typed `TIMEOUT` tool result, and the loop continued.
3. **During a model call**: not handled. `await input.adapter.generate(...)` had no `try/catch`.

When the deadline fired mid-request, the Anthropic SDK rejected with its own `APIUserAbortError` ("Request was aborted.") rather than the signal's reason. The error propagated through `runOne` to the catch block in `runExperiment` (`src/experiment.ts`), which sets `status = "failed"` and rethrows, ending the whole experiment.

Evidence that the deadline, not a user cancellation, caused the abort: job 283 started at 22:51:20.28 and the abort landed at 22:53:21.27, 120.99 s later, while the last model call had been outstanding for about 74 s. No cancellation signal was sent in CI.

## Why the smoke run did not catch it

The bug is not CI-specific. The smoke run has 24 jobs and the full run 450, so the full run is roughly 19 times more likely to meet one provider response slow enough to push a job past 120 s. Smoke passing locally and in CI was consistent with the bug being present.

## Resolution

Commit `eae03bc` wraps the model call in `runAgent`:

- If the parent signal (user cancellation) is aborted, rethrow the cancellation reason, consistent with the tool path.
- If the runner's own deadline signal is aborted, emit an `error` event with `phase: 'model'` and the provider message, then return `boundedError('Deadline exceeded', ...)` with tokens and cost accumulated so far.
- Otherwise (rate limits, overload, network errors), rethrow unchanged. Provider failures that are not deadlines are still not silently scored as `bounded`.

The deadline is detected from the runner's own signal, not from the error type, because each provider SDK reports aborts with its own error class and message.

Regression tests added to `tests/runner.test.ts`:

- A model call that hangs until aborted, with a short `deadlineMs`, yields `bounded`, preserves prior cost, and records the `phase: 'model'` error event. Before the fix this test failed with the exact CI error, `Request was aborted.`
- A parent cancellation during a model call rejects with the cancellation reason.
- A non-deadline model error still rejects.

`pnpm check` passed after the fix: lint, type-check, 132 tests, `runner.ts` at 100 % line coverage, dataset and config validation.

## What went well

- The progress output (`[n/450] phase=... total=$...`) with timestamps made the 120 s deadline visible directly from the CI log.
- The per-run budget ceiling and cost reporting bounded the loss at USD 4.57.
- Existing tests for the tool-deadline and parent-cancellation paths gave a clear pattern to mirror.

## What went poorly

- Deadline handling was implemented per call site, and the most expensive call site (the model call) was the one left uncovered.
- A partial run kept no evidence: the artifact upload only runs on success.
- The approval-gated schedule left a run waiting for about 54 h on a commit already known to be affected.

## Action items

| Item | Status |
| --- | --- |
| Bound deadline aborts during model calls, with regression tests | Done (`eae03bc`) |
| Reject the stale 2026-10-01 run (36884507240) and dispatch a fresh full run after pushing the fix | Open |
| Upload `runs/` with `if: always()` in `full-benchmark.yml` so partial results and events survive a failed run | Open |
| Set an explicit per-request `timeout` / `maxRetries` on the Anthropic client (`src/cli.ts`) so one slow call cannot consume the whole 120 s job deadline | Open, optional |
| Lower `MAX_EXPERIMENT_COST_USD` to at most the available Platform credit so a run stops on the cap rather than on a credit-exhaustion API error | Open |
