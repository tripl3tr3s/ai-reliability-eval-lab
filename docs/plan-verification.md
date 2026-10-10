# Plan verification: feat/go-live-gate

| Field | Value |
| --- | --- |
| Date | 2026-10-10 |
| Verified against | `main` at `eae03bc`, working tree clean except untracked `docs/` |
| Status | Phase 1 and Phase 2 complete on branch `feat/go-live-gate`. Not pushed, not tagged, not merged. See "What changed versus plan" at the end. |
| Baseline checks | `pnpm validate`, `pnpm test:coverage`, `pnpm build`, `pnpm lint` all pass (132 tests, 17 files) |

The plan was written without seeing the code. This document records what the code actually contains, where the plan's assumptions are wrong, and the adjusted approach for each work item.

## Repository shape

- 19 flat modules in `src/` (about 3 100 lines), 17 test files in `tests/`, ESM (`"type": "module"`, `NodeNext`), strict TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Runtime dependencies: `@anthropic-ai/sdk`, `@clack/prompts`, `efos-risk-graph`, `zod`, `zod-to-json-schema`. No statistics library.
- CLI commands (`src/cli-options.ts`, `src/cli.ts`): `run`, `report`, `validate-dataset`, `validate-config`. There is no `gate`, `verify` or `monitor` command.
- No committed run data, baseline, or fixture file exists. `runs/` and `reports/generated/` are gitignored. `tests/fixtures/` does not exist.

## Answers to the specific questions

### a. Existing statistics code

Yes, but only row-level bootstrap. There is no Wilson, Clopper-Pearson, McNemar, cluster bootstrap, pass@k, or power code.

| Location | What it does | Problem for this work |
| --- | --- | --- |
| `src/scoring.ts` `mulberry32` (private) | Seeded PRNG | Good generator, but not exported |
| `src/scoring.ts` `bootstrapCi(values, seed, samples = 2000)` | Percentile bootstrap of a mean over a flat array | Resamples rows, not cases |
| `src/scoring.ts` `bootstrapStatistic` (private) | Percentile bootstrap of an arbitrary statistic | Same |
| `src/scoring.ts` `aggregateScores` | Per-arm metrics with `ci95` from the functions above | Pools all 150 rows of an arm (30 cases x 5 repeats) as if independent, so every published `ci95` is too narrow |
| `src/baseline.ts` `pairedBootstrap` (private) | Paired bootstrap of a ratio change | Uses a second, weaker ad hoc generator (`Math.imul(state + 0x6d2b79f5, 48271)`), and is only reached for cost and latency |
| `src/baseline.ts` `compareBaseline`, `comparePairedBaseline` | Regression check with hardcoded margins (3 points quality, 1 point unsupported claims, 15 % cost and latency) | Decides on the point estimate only. The interval is computed but never used in the decision. Not reachable from the CLI or CI, only from one test |

### b. Raw JSONL row schema

One row per run, written by `runOne` in `src/experiment.ts`, typed as `RawRun` in `src/scoring.ts`:

| Field | Type | Notes |
| --- | --- | --- |
| `runId` | string | `${caseId}:${configuration}:${repeat}` |
| `caseId` | string | **Clustering key.** Matches `DatasetCase.id`, for example `v2-lookup-document-01` |
| `configuration` | string | The arm |
| `repeat` | number | 0-based repeat index |
| `outcome` | `completed`, `abstained`, `failed`, `bounded` | Runner `error` is mapped to `failed` |
| `answer` | string | Final answer text |
| `finalState` | object | `{ followUps, matchedPayments }` |
| `claims` | `{ text, evidenceIds, checkable }[]` | |
| `toolCalls` | `{ name, input, evidenceId?, success? }[]` | Includes failed attempts |
| `validEvidenceIds`, `evidenceFacts` | | Evidence used by unsupported-claim scoring |
| `latencyMs`, `costUsd` | number | Routing plus execution |
| `modelIds` | string[] | Provider-returned ids |
| `policyViolation` | boolean | True exactly when the outcome is `bounded` |
| `duplicateMutation` | boolean | Two follow-ups sharing an idempotency key |

Plan assumptions that are wrong:

- **There are no assertion results in the raw row.** Rows hold raw behaviour only. Assertions are evaluated at report time by `scoreRun(run, datasetCase)`, which yields a `RunScore` (written to `results.jsonl`). `RunScore` exposes `completionPassed`, `selectionPassed`, `argumentAccuracy`, `headlineToolAccuracy`, `recoveryPassed`, `unsupportedClaims`, but not which sub-check failed (required assertion, forbidden claim, state, outcome).
- **There is no token field in the raw row.** Tokens exist only as a cumulative counter in `model` telemetry events (`events.jsonl`), and the routing call's tokens are not recorded at all. The plan's "cost and tokens as now" is not accurate: the report shows cost and latency only.

### c. Arms and repeats

- Three arms as `CONFIGURATION_IDS` in `src/config.ts`: `direct-sonnet`, `routed`, `no-resource-injection`. Arm is the `configuration` string on each row.
- Repeats come from `repeats` in the experiment file (5 in `full.v2.json`, 2 in `smoke.v2.json`) and are the `repeat` integer. `planExperiment` builds the full cross product and shuffles it deterministically.
- All arms see the same 30 cases, so arms are **paired by case**. They are not meaningfully paired by repeat: `seed + repeat` only reaches the synthetic tools, no seed is sent to the model, and repeat 2 of one arm has no relationship to repeat 2 of another.
- `buildReport` in `src/report.ts` sorts rows by `runId`, scores each row, and calls `aggregateScores`, which groups by `configuration` and pools rows. Nothing is grouped by case.
- `experimentIsComplete` hardcodes 30 cases, 3 arms, 5 repeats, and also returns false if any single run is `failed`, `bounded`, a policy violation, or a duplicate mutation. A full run with one bounded row therefore reports `pending` forever. The Pages workflow publishes only `complete`.

### d. Provider abstraction and leaks

PARTIAL. `ModelAdapter` in `src/contracts.ts` is a real seam (`generate(ModelRequest): Promise<ModelResponse>` with normalized messages, tools, usage, model id, latency), and `AnthropicAdapter` in `src/adapter.ts` is the only implementation. Missing: capability flags, normalized errors, normalized stop reasons, structured output.

Provider-specific logic outside the adapter:

| Location | Leak |
| --- | --- |
| `src/runner.ts:59` | Per-call output limit chosen by `model === ANTHROPIC_MODELS.sonnet` (8 192 vs 4 096) |
| `src/runner.ts:62` | Temperature rule: sends `temperature: 0` only when the model is Haiku. The adapter also rejects a Sonnet temperature, so the rule lives in two places |
| `src/runner.ts:74` | Compares `stopReason` to the Anthropic literal `max_tokens` |
| `src/runner.ts:78` | Assistant turns are stored as a JSON string `{ text, toolCalls }` in `NormalizedMessage.content`, and the adapter parses that string back. An implicit protocol every adapter would have to copy |
| `src/experiment.ts:284`, `:366` | Direct arm and router hardcode `ANTHROPIC_MODELS.sonnet` and `.haiku` |
| `src/config.ts` | `AgentConfiguration` is typed on Anthropic model ids; `modelForRoutedTask` returns them |
| `src/cli.ts` | Constructs the Anthropic SDK client directly and requires `ANTHROPIC_API_KEY` |

Cost is computed inside the adapter from the pricing file, which is fine.

### e. The CI "validation and replay gate"

`.github/workflows/ci.yml`, job `validate`, no secrets: `lint`, `typecheck`, `validate`, `test:coverage`, `build`, `benchmark:mock`, `report:replay`.

- `benchmark:mock` is `vitest run tests/experiment.test.ts`: an inline mock adapter that always abstains, 24 jobs.
- `report:replay` is `vitest run tests/report-baseline.test.ts`: writes **one hand-built row** to a temp file, replays it twice, and asserts the four output files are byte-identical. It also runs `compareBaseline` on hand-built summaries.

So the plan's assumption is wrong in an important way: **the gate replays no recorded data and applies no thresholds.** Both steps are subsets of `test:coverage`, which already ran. It cannot fail on a quality regression. There is nothing recorded to wire a gate into; the data source has to be created (see WI3).

### f. Critical vs soft assertions

MISSING. The dataset has no severity field. `scoreRun` folds everything into one `completionPassed` boolean. Usable signals that already exist:

| Signal | Source | Proposed severity |
| --- | --- | --- |
| A forbidden tool with side effect `simulated-write` was called | `forbiddenTools` (25 of 30 cases forbid `create_follow_up`), tool `sideEffect` | critical: unauthorized write |
| Final state differs from `expectedState` on a write case | 5 cases: `v2-multi-match-11`, `-followup-14`, `-followup-18`, `-match-19`, `v2-recovery-write-28` | critical: wrong or missing write |
| `duplicateMutation` | row flag | critical: duplicate write |
| A forbidden claim asserted in the answer | `forbiddenClaims`, for example "guaranteed fraud", "approve automatically", "case closed" | critical: wrong authority or false assertion |
| An abstention case answered as `completed` | `category === "abstention"` (2 cases) | critical: asserted without evidence |
| Required assertion missing, read-plan mismatch, read-argument mismatch, unsupported-claim rate, `bounded`, `failed` | existing scores | soft: quality or availability |

Proposal (minimal, backward compatible): a new pure module that derives these flags from `(RawRun, DatasetCase, tool side-effect map)` under a named rule version (`severity-rules-v1`). No dataset edit, no change to `RunScore` or `results.jsonl`. The rule version is recorded in the gate output and the thresholds file. This needs `containsUnnegated` exported from `scoring.ts` (export only, no behaviour change).

Honest limit: **"wrong tax figure" cannot be detected as critical.** A required assertion such as `includes "1160"` fails the same way whether the figure is absent or wrong. Only forbidden claims capture "asserted something false". Distinguishing the two needs per-case labels, which means a dataset v3. I will record that in the ambiguity register and not pretend otherwise.

### g. Coverage

Thresholds in `vitest.config.ts`: statements 80, branches 75, functions 80, lines 80. `src/cli.ts` is excluded. Current: statements 95.34, branches 82.74, functions 92.45, lines 95.34. Lowest files: `faults.ts` (73 % lines), `baseline.ts` (82 %), `cli-ui.ts` (branches 74.7 %). New command logic must live outside `cli.ts` so it is measured.

### h. Core vs domain pack

Not cleanly separable today. Domain knowledge is woven through the core modules:

- `contracts.ts`: `CaseState`, `FollowUp`, `PaymentMatch`, and `AgentResult.finalState` are fiscal shapes.
- `runner.ts`: builds that final state.
- `experiment.ts`: `evidenceFactsFor` branches on tool names; system prompt says "bounded fiscal operations agent".
- `scoring.ts`: identifier regex `^(cn|inv|pay|rfc)-?\d+$`.
- `dataset.ts`: literal 30 cases and the 10/10/8/2 category split.
- `fixtures.ts`, `tools.ts`: the actual domain pack, including all `efos-risk-graph` usage (two imports, one tool).

Recommendation: **do not move existing files.** A real split means generic state and evidence projection interfaces, touching 6 modules and most of the 17 test files, with real risk to the scoring contract for no evidence gain. Instead:

1. All new code goes into domain-free directories: `src/stats/`, `src/gate/`, `src/monitor/`, `src/audit/`, `src/providers/`.
2. An ESLint `no-restricted-imports` rule forbids those directories from importing `fixtures`, `tools`, or `efos-risk-graph`, so the boundary is enforced, not just described.
3. `docs/architecture.md` maps every existing module as core, domain, or mixed, and lists the seams a second domain pack would need.

## Work items

### WI1 Stats core: MISSING (two primitives exist)

- New: `src/stats/` (`prng.ts`, `binomial.ts`, `paired.ts`, `bootstrap.ts`, `reliability.ts`, `power.ts`, `index.ts`), `tests/stats/*.test.ts`.
- Existing code touched: none. `scoring.ts` keeps its private `mulberry32` so current report bytes do not change; `src/stats/prng.ts` carries the same algorithm.
- Reference values: scipy is not installed. I will generate constants once with `uv run --with scipy` (a package download, no API spend) and paste them with the generating script in a comment. If you prefer no download, I can cross-check with exact rational arithmetic in the standard library instead.
- The three sanity values in the plan are all correct. Checked independently with plain Python:

| Claim | Computed |
| --- | --- |
| Wilson 95 % for 27/30 is about [0.744, 0.965] | [0.7438, 0.9654] |
| One-sided 95 % Clopper-Pearson upper bound for 0/300 is about 0.0099 | 0.009936 |
| Zero-failure n for p = 0.01 at 95 % is 299 | ln(0.05)/ln(0.99) = 298.07, ceil 299 (0.99^298 = 0.05004, 0.99^299 = 0.04954) |

### WI2 Report integration: PARTIAL

- Touches: `src/report.ts` (`buildReport`, `ReportSummary`), `src/cli.ts` (`report`), `tests/report-baseline.test.ts`, new `tests/report-statistics.test.ts`.
- Wrong assumption 1: existing intervals are row-pooled, not case-clustered. I will add a `statistics` block to `summary.json` and new report sections; existing `configurations[].ci95` fields stay unchanged for compatibility. In `report.md` and `index.html` I propose showing the clustered interval and labelling the old one as row-level, not presenting both as equivalent. **Your call**, see open decisions.
- Wrong assumption 2: tokens are not available (see b). I propose an optional `tokens` field on `RawRun` for future runs (additive, scoring untouched) and "N/A" when absent. Routing tokens need one extra line in `routeModel`.
- Wrong assumption 3: "same raw JSONL gives byte-identical report" is only true inside `buildReport` with a fixed manifest. The CLI `report` command stamps `startedAt` and `completedAt` with `new Date()` and `nodeVersion` with `process.version`, so two `pnpm report` runs on the same file differ in `summary.json`. Fix: take timestamps from an `--events` file when given (first and last event `at`), otherwise from the raw file; never from the wall clock. Test at CLI level.
- Pairing: McNemar needs one binary outcome per case per arm. I will collapse the 5 repeats per case first (see statistical choices), never feed 150 correlated rows into it.

### WI3 Gate: MISSING

- New: `src/gate/` (`thresholds.ts` with a zod schema, `severity.ts`, `decision.ts`, `render.ts`, `command.ts`), `config/thresholds.v1.json`, `config/thresholds.schema.json` (mirrors the existing `pricing.schema.json` convention), `tests/gate/*.test.ts`.
- Touches: `src/cli-options.ts`, `src/cli.ts` (new `gate` command), `package.json` (`gate`, `gate:mock` scripts), `.github/workflows/ci.yml` (one added step, nothing removed or loosened).
- Wrong assumption: there is no baseline report and no recorded data. The gate will support two comparisons: candidate arm vs reference arm inside one raw file, and candidate raw file vs baseline raw file (paired by case). Baseline is always raw JSONL, consistent with "reports only from raw JSONL".
- CI data source: a deterministic scripted mock model that follows each case's accepted plan, run through the real runner, scorer, and reporter in-process. Output goes to a temp directory, model ids are `mock-*`, and the report status line says MOCK so it can never be mistaken for a result or reach Pages. A second scripted model with injected failures proves exit code 1.
- "Deterministic checks" need a definition, since the plan does not give one. Proposed: dataset hash matches manifest, every row parses against a zod schema, the case x arm x repeat grid is complete and unique, every `caseId` is known, model ids are within the expected set.
- `src/baseline.ts` stays as is. The gate supersedes its point-estimate logic; I will note that in the design note, not delete it.
- Interaction to be aware of: `experimentIsComplete` already marks any run with a bounded row as `pending`. The gate judges critical errors by an upper bound; the report status judges by "zero bounded rows". These are different rules and I will document both, not silently reconcile them.

### WI4 Design note: MISSING

- New: `docs/design-note.md`, linked from `README.md`. Written after WI1 to WI3 so it describes real behaviour.

### WI5 Provider independence: PARTIAL

- Touches: `src/contracts.ts` (extend `ModelAdapter` with `capabilities`, normalized stop reason, normalized error type; all additive), `src/adapter.ts` (stays the Anthropic adapter, gains capability flags), `src/runner.ts` and `src/experiment.ts` (read capabilities and a model-role map instead of `ANTHROPIC_MODELS`), `src/cli.ts` (adapter chosen by env). New `src/providers/openai-compatible.ts`, `src/providers/scripted.ts`, `tests/providers/contract.test.ts`.
- Risk: the runner changes must keep Anthropic request bytes identical. I will pin that first with a snapshot test of the exact request the current code sends, then refactor.
- The assistant-turn JSON-string convention (see d) becomes a typed helper shared by adapters, wire format unchanged, so recorded telemetry stays comparable.
- Arm names such as `direct-sonnet` stay. They are part of the raw row contract.
- The OpenAI-compatible adapter uses global `fetch` with an injected fetch function for tests. No new dependency, no SDK.
- Not in scope: adding Sonnet 5.5 or Opus 5.5. That is the separate pending decision in `docs/decisions/2026-10-03-model-lineup-benchmark-cost-estimates.md`.

### WI6 Suspension demo and audit log: MISSING

- New: `src/monitor/monitor.ts`, `src/audit/log.ts`, tests, CLI command `audit-verify`.
- `sha256` already exists in `src/dataset.ts` and will be reused. Canonical JSON (sorted keys) is new.
- The clock is injected so tests and logs are deterministic.

### WI7 Packaging: MISSING

- Boundary: document plus lint rule, no file moves (see h).
- Wrong assumption: **the README has no Spanish section.** It is entirely in English. "Keep the Spanish fiscal domain explanation" has nothing to keep. I will keep the existing English domain description and add no Spanish text unless you want one.
- New: `CHANGELOG.md`, `docs/RUNBOOK-live-run.md`, `docs/architecture.md`.
- "Do not modify existing baselines": none exist, so nothing is at risk there.

## Statistical choices to confirm

1. **Unit of analysis is the case (n = 30), not the run (n = 150).** Per-arm intervals come from a cluster bootstrap over cases.
2. **Binary per-case outcome for McNemar and Wilson**: I propose "all k repeats passed" (the pass^k view, strict) as the primary, with "majority passed" reported alongside. Any choice here is a judgement call.
3. **Paired difference**: mean over cases of (per-case pass rate in arm A minus arm B), percentile bootstrap resampling cases, 10 000 resamples, fixed seed from the run manifest.
4. **Critical-error bound**: one-sided Clopper-Pearson upper bound on the share of cases with at least one critical error in any repeat. With 30 clean cases the bound is about 9.5 %, so a limit such as 1 % can never be demonstrated at this n. The gate will return INCONCLUSIVE in that situation and say how many cases would be needed (299). This is the honest outcome, and the main thing the "what this run can detect" section will say.
5. **Percentile intervals** (not BCa) for simplicity and reproducibility; noted as a limitation.

## Summary of corrections to the plan

1. Statistics partly exist, but every current interval pools 150 correlated rows per arm, and the baseline comparison ignores its own interval. WI1 and WI2 fix an existing weakness, not only add features.
2. Raw rows carry no assertion results and no tokens. Severity must be derived at scoring time; tokens need a small additive field.
3. The CI "replay gate" replays one hand-built row and no recorded data. There is no baseline or fixture anywhere in the repo. WI3 has to create its own secretless data source (a scripted mock run through the real pipeline).
4. A provider seam already exists. WI5 is about moving leaked rules behind it and normalizing stop reasons, not introducing an interface from scratch.
5. No severity labels exist, and "wrong tax figure" is not detectable with the v2 assertions. I will derive what is derivable and register the rest as a limitation.
6. The report is not byte-reproducible through the CLI today because of wall-clock timestamps.
7. The README has no Spanish section.
8. The core and domain split is not safe to do by moving files. I recommend enforcing a boundary for new code and documenting the rest.
9. The three sanity values in the plan are correct.

## Open decisions for you

| # | Decision | My default if you just say "go" |
| --- | --- | --- |
| 1 | Show clustered intervals in the report body and relabel the old row-level ones, or keep the old ones as the headline | Clustered in the body, old fields kept in `summary.json` and labelled row-level |
| 2 | Add optional `tokens` to the raw row | Yes, additive, "N/A" for older files |
| 3 | Per-case binary rule for McNemar | All repeats pass as primary, majority as secondary |
| 4 | Reference constants via `uv run --with scipy` (one package download) | Yes |
| 5 | Core and domain boundary | Lint rule plus `docs/architecture.md`, no file moves |
| 6 | Spanish section in the README | None added |
| 7 | Initial threshold values in `config/thresholds.v1.json` | Carry over the margins already in `baseline.ts` (3 points quality, 1 point unsupported claims), critical-case upper bound limit 10 %, minimum 30 cases, each with a rationale that says it is a starting value pending the first live run |

## What changed versus plan

Written after Phase 2. Sections above are the Phase 1 record and were left as written, including proposals that changed during implementation; the differences are listed here.

### Decisions taken (the Phase 1 defaults, accepted with "go")

| # | Decision | Outcome |
| --- | --- | --- |
| 1 | Report intervals | Case-clustered intervals added in new report sections. Existing `ci95` fields kept and labelled row-level |
| 2 | Tokens | Optional `tokens` on raw rows, routing tokens included, "N/A" for older files |
| 3 | McNemar outcome | "Every repeat passed" primary, majority as sensitivity check |
| 4 | Reference constants | Generated with scipy through `uv run --with scipy`; script kept in `tests/stats/reference/scipy_reference.py` |
| 5 | Boundary | ESLint rule plus `docs/architecture.md`, no file moves |
| 6 | Spanish README section | None added |
| 7 | Thresholds | 3 point margins, 10% critical upper bound limit, minimum 30 cases, all marked as starting values |

### Differences from the plan as written

| Work item | Plan said | What was built, and why |
| --- | --- | --- |
| WI1 | Verify three sanity values | All three are correct. Minimum detectable effect returns null when no difference is detectable at the given n and discordance, which happens for 30 cases below about 25% discordance |
| WI2 | "Cost and tokens as now" | Tokens were not recorded before. Added as an optional raw row field |
| WI2 | Byte-identical report | True of `buildReport` already; the CLI stamped wall-clock times. Timestamps now come from `--events` or read `unknown`. `full-benchmark.yml` passes `--events` |
| WI2 | Not in plan | `pnpm report` now validates raw rows against a schema instead of trusting them |
| WI3 | "BLOCK if the lower bound of the paired difference falls below the margin; INCONCLUSIVE if the interval spans the margin" | These two conditions overlap. Implemented the standard reading: BLOCK when the whole interval is below the margin, INCONCLUSIVE when it contains the margin, PASS when the lower bound clears it |
| WI3 | "BLOCK if a critical bound is exceeded" | BLOCK only if at least one critical error was observed. With none observed and a bound over the limit (small sample) the result is INCONCLUSIVE. Both exit non-zero. Otherwise a clean 4-case smoke run would be reported as harmful |
| WI3 | Wire into the replay gate "using recorded or mock data" | No recorded data exists. Added a scripted model that runs through the real runner, tools, and fault schedule, and a `pnpm gate:mock` CI step. Output is labelled mock and a mock report can never reach status `complete` |
| WI3 | Deterministic checks (undefined in plan) | Defined as: dataset integrity, severity rule version match, row schema, known case ids, unique runs, complete repeats, same cases in both arms. The Phase 1 idea of checking model ids against an expected set was dropped: there is no source of truth for the expected set |
| WI3 | Not in plan | `zeroWidthInterval.policy` threshold. When the arms never disagree the bootstrap interval collapses to a point and clears any margin. Default is PASS with a warning; the stricter `inconclusive` policy is implemented and tested but makes PASS unreachable at 30 cases |
| WI3 | Phase 1 said the gate would return INCONCLUSIVE for a 1% critical limit | The committed limit is 10%, which 30 clean cases can demonstrate (bound 9.5%). A 1% limit would be INCONCLUSIVE, as predicted |
| WI5 | "If no abstraction exists, introduce one" | One existed. Added capabilities, model roles, normalized stop reasons, and normalized errors to it, and removed Anthropic model ids from the runner and experiment loop |
| WI5 | "Keep the existing adapter behavior identical" | Requests are byte-identical, pinned by snapshots recorded before the refactor. One deliberate difference: provider failures and malformed responses keep their message but are now thrown as `ModelProviderError` |
| WI5 | Capability flags on the adapter | `capabilities` is optional on the interface so the many existing test doubles stay valid. Without it the runner falls back to a registry of pinned models, then to generic defaults |
| WI5 | Structured output in the interface | Only a capability flag (`prompt` or `json_schema`). Both adapters request the final JSON by instruction and the runner validates it. No provider-enforced schema is used |
| WI6 | Detect modified, deleted, or reordered lines | Also detects inserted lines, and truncation when given the expected head hash. Truncation at the end cannot be detected from the log alone; the verify command prints the head hash to record elsewhere |
| WI6 | Not in plan | The gate can append its decision to the audit log (`--audit-log`), so the log has a real producer besides the demo |
| WI7 | "Keep the Spanish fiscal domain explanation" | The README has none. Nothing was removed and none was added |

### Fixes made after automated review of the commits

- `src/providers/openai-compatible.ts`: the response body was read in full before any size limit applied. It is now read as a stream and cancelled at 1 MiB.
- `src/audit/log.ts`: verification passed on an empty or missing log, and hashed the parsed entry instead of the line. It now fails closed on an empty log and requires each line to be byte-identical to its canonical form, which rejects duplicate keys, reordered keys, extra whitespace, and alternate escapes.

### Not done

- No live run. No benchmark result exists; every document says so.
- No Sonnet 5.5 or Opus 5.5 configuration. That remains the separate pending decision in `docs/decisions/2026-10-03-model-lineup-benchmark-cost-estimates.md`.
- No baseline was created or promoted. `src/baseline.ts` is unchanged and still unused by the CLI; the gate supersedes its point-estimate logic.
- `experimentIsComplete` still marks a run with any `bounded` or `failed` row as `pending`. This differs from the gate's rule and is recorded in the design note's ambiguity register.
- The open action items in the 2026-09-01 post-mortem (upload `runs/` with `if: always()`, client timeouts) were left alone as out of scope.
