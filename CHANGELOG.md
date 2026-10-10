# Changelog

All notable changes to this project are recorded here. Dates use ISO 8601.

## 0.1.0 - Unreleased

No complete live benchmark run exists yet. Nothing in this entry is a benchmark result.

### Added

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

- `pnpm report` takes run timestamps from telemetry events (`--events`) instead of the wall clock, so the same raw JSONL yields byte-identical output. Without `--events` the timestamps read `unknown`.
- `pnpm report` validates every raw row against a schema and reports the failing line.
- Existing `ci95` fields in `summary.json` are unchanged but are now documented as row-level; the report body points to the case-clustered intervals for decisions.
- The runner and experiment loop no longer reference Anthropic model ids. Requests sent by the Anthropic adapter are unchanged, pinned by snapshots recorded before the change.
- Anthropic provider failures and malformed responses keep their message but are wrapped in `ModelProviderError`.
- A report built from mock data always has status `pending`, so it can never be published.

### Unchanged

- Dataset v1 and v2, their manifests, and the scoring contract (`scoreRun`, `RunScore`, `results.jsonl`).
- Protections on the live workflows. No secret was added to CI.
