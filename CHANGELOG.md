# Changelog

All notable changes to this project are recorded here. Dates use ISO 8601.

## 0.1.0 - Unreleased

No complete live benchmark run exists yet. Nothing in this entry is a benchmark result.

### Added

- `config/thresholds.v3.json`, now the default for dataset v3: a case passes only if every repeat passed, non-inferiority uses the Bonett-Price interval (no zero-width intervals), margins are 5 points for completion and tool accuracy and 15 points for recovery, and the thresholds pin the statistics and scoring contract versions as deterministic checks. `gate.json` and `gate.md` report the analysis, a McNemar mid-p, and the per-case pass rate comparison. `thresholds-v1` and `thresholds-v2` decisions are unchanged. See [the decision record](docs/decisions/2026-10-24-thresholds-v3-bonett-price-gate.md).
- Small-sample binary methods in `src/stats` (`stats-methods-v2`), checked against evalstats 0.3.3: Bonett-Price adjusted Wald interval for paired proportions, its case-clustered multi-run form with a p-value by interval inversion, McNemar mid-p, Wilson on per-case rates, Sidak simultaneous confidence, Shaffer adjustment, one-way ICC(1) with design effect, and unbiased pass^k and pass@k. Reference fixtures (`tests/stats/reference/evalstats-fixtures.json`) record the evalstats, numpy, scipy, and Python versions and the generating script's hash; seeded coverage simulations run at 30 and 90 cases. Not yet used by the report or gate. See [the decision record](docs/decisions/2026-10-24-binary-methods-checked-against-evalstats.md).
- Report analysis plan v2 ([decision record](docs/decisions/2026-10-24-analysis-plan-v2.md)). The headline is the share of cases that passed every repeat, compared with Bonett-Price intervals, McNemar mid-p, Sidak and Shaffer, with verdicts and rank bands. Added to the report: the per-case pass rate as secondary, stability (ICC and unbiased pass^k, labelled not validated), outcomes by termination reason, a sensitivity analysis without cases that stopped early, cost and latency per case over every run with a paired ratio and a cost-and-quality label, and a scope statement. `summary.json` changes are additive; the bootstrap sections stay, labelled legacy, and the row-level table moves to an appendix. A Student t interval joins `src/stats`, checked against evalstats. `pnpm report:mock:v3` and `report-check` run in CI.
- Scoring contract lock (`config/scoring-contract.json`, `pnpm scoring-contract`): the sha256 of `src/scoring.ts`, `src/text-es.ts`, `src/gate/severity.ts`, and `src/dataset.ts` is recorded in `summary.json`, `gate.json`, and the gate's audit log entry. A test fails when the scorer changes without a new `SCORING_CONTRACT_VERSION`, and a report from an unlocked scorer stays `pending`. See [the decision record](docs/decisions/2026-10-24-scoring-contract-lock-and-termination-reasons.md).
- `terminationReason` and `refusalCategory` on raw run rows, so `bounded` and `failed` runs say why they stopped (deadline, cancellation, output limit, token, cost, output size, tool call, or iteration ceiling, disallowed tool, invalid final result, refusal). Optional; older rows remain valid.
- Dataset v3 (`datasets/v3`): 90 Mexican Spanish cases (20 lookup, 24 multi-tool, 18 recovery, 14 abstention, 14 confirmation) authored in `src/packs/sat-v3/dataset` and built with `pnpm dataset:build:v3`. Each case has a reference answer and counterexamples, all checked by tests. See [the decision record](docs/decisions/2026-10-14-dataset-v3-and-5-5-arms.md).
- The sat-v3 domain pack: 17 synthetic tools named and shaped after the sat-mcp tools DISAI_Conta allowlists, with Spanish fixtures, HITL pending confirmations, and a domain router modeled on DISAI_Conta's.
- Arms `prod-routed-5-5` (Haiku 5.5 router at low effort, Sonnet 5.5 at medium, Opus 5.5 at high for pagos and cumplimiento) and `direct-sonnet-5-5`, with `config/smoke.v3.json` and `config/full.v3.json`.
- Pinned `claude-haiku-5-5`, `claude-sonnet-5-5`, and `claude-opus-5-5` with adaptive thinking, explicit effort, verbatim replay of assistant blocks, and refusal handling without fallbacks. `config/pricing.v2.json` with a long-prompt rate card.
- Spanish matching for v3 (`src/text-es.ts`): negation scope, numeric amounts in common formats, whole-token identifiers. `forbiddenValues` and `allowedExtraCalls` in the v3 schema.
- `severity-rules-v2` (adds `wrong_value`) and `config/thresholds.v2.json` for dataset v3. The gate picks thresholds and arms from the experiment's dataset.
- `pnpm gate:mock:v3`, also in CI. `dataset` input on the live-smoke and full-benchmark workflows.
- `DomainPack` interface (`src/packs`); the fiscal-v2 pack wraps the original fixtures and tools unchanged.
- Statistics core in `src/stats`, with no dependencies: Wilson and Clopper-Pearson intervals with one-sided variants, exact binomial CDF, zero-failure sample size, rule of three, exact McNemar test, seeded cluster and paired percentile bootstrap, per-case pass@k and pass^k, and minimum detectable effect for paired binary comparisons. Tests use reference constants generated with scipy.
- Case-level statistics in the report: case-clustered intervals, cases passing every repeat, pass@k and pass^k, cost and tokens, paired comparisons with exact McNemar and paired bootstrap intervals, and a section on what the sample size can and cannot detect.
- Go-live gate (`pnpm gate`) driven by `config/thresholds.v1.json`: PASS (exit 0), BLOCK (1), INCONCLUSIVE (2), with JSON and Markdown summaries that record input hashes.
- Severity rules (`severity-rules-v1`) that derive critical errors from existing dataset and raw row fields.
- Scripted mock run (`pnpm mock:run`) that drives the real runner, tools, and fault schedule without credentials or spend, and a secretless CI step (`pnpm gate:mock`) that gates it.
- Provider capabilities, model roles, normalized stop reasons, and `ModelProviderError`. An OpenAI-compatible adapter selected with `MODEL_PROVIDER=openai-compatible`. Shared contract tests that run against every adapter.
- Suspension monitor demo (`pnpm demo:suspension`) and a hash-chained append-only audit log with a verify command (`pnpm audit:verify`). The gate can append its decision with `--audit-log`.
- Optional `tokens` field on raw run rows.
- Documents: design note, architecture, live-run runbook, plan verification.
- ESLint boundary rule that keeps core directories independent of the domain pack.

### Changed

- Dataset v3 is the default: the CLI falls back to `config/full.v3.json` and `datasets/v3/manifest.json`, guided mode preselects Smoke v3, and the `live-smoke` and `full-benchmark` workflows (including scheduled and tag runs) default to v3. `pnpm gate:mock` and `pnpm validate` name their v2 inputs explicitly, so v2 coverage in CI is unchanged.
- Documentation describes the current state: the README leads with status, a dataset and arms table, and a documentation map; the runbook covers v2 and v3 from one parameter table; stale lines in the architecture map, design note, decision records, and contributing guide were corrected, and the plan verification is marked as a historical record.
- Artifact uploads in the live-smoke and full-benchmark workflows run even when the benchmark fails, so partial traces are kept. Pages publishes only from a successful run.
- Each arm names its own model slots; legacy arms keep resolving provider roles and their requests are unchanged.
- The tool allowlist comes from the case's domain pack (unchanged for v1 and v2).
- The report judges completeness against the experiment's own configurations instead of the three legacy arm names.
- Provider request IDs are redacted from deadline error events.
- `pnpm report` takes run timestamps from telemetry events (`--events`) instead of the wall clock, so the same raw JSONL yields byte-identical output. Without `--events` the timestamps read `unknown`.
- `pnpm report` validates every raw row against a schema and reports the failing line.
- Existing `ci95` fields in `summary.json` are unchanged but are now documented as row-level; the report body points to the case-clustered intervals for decisions.
- The runner and experiment loop no longer reference Anthropic model ids. Requests sent by the Anthropic adapter are unchanged, pinned by snapshots recorded before the change.
- Anthropic provider failures and malformed responses keep their message but are wrapped in `ModelProviderError`.
- A report built from mock data always has status `pending`, so it can never be published.

### Unchanged

- Dataset v1 and v2, their manifests, and the scoring contract (`scoreRun`, `RunScore`, `results.jsonl`).
- Protections on the live workflows. No secret was added to CI.
