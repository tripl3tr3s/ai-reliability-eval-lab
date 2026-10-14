# AI Reliability and Evaluation Lab

A reproducible, synthetic benchmark for bounded tool-using agents. It compares direct Sonnet, routed Haiku/Sonnet, and routed execution without operational resource injection. The benchmark uses fictional Mexican fiscal and operational data and the published `efos-risk-graph` package. Dataset v2 and its matching v2 experiment configurations are the current benchmark contract. The v1 dataset remains available for historical reference and compatibility checks.

The benchmark pins `claude-sonnet-5` for Sonnet execution and `claude-haiku-4-5-20251001` for routing and simple read-only execution. Sonnet 5 requests omit `temperature` so Anthropic's adaptive-thinking defaults remain valid, and the adapter rejects any defined Sonnet temperature before making a provider request. Haiku routing and execution retain `temperature: 0` for deterministic classification and simple-task behavior.

Sonnet 5 receives an 8,192-token per-call output allowance within the unchanged 12,000-token total run ceiling. A provider `max_tokens` stop is recorded as a bounded outcome instead of being treated as malformed output or repaired. This gives adaptive thinking more room while preserving the benchmark's hard run-level bound.

Runtime cost calculation uses the validated, versioned [pricing configuration](config/pricing.v1.json), not adapter constants. Pricing version `anthropic-2026-08-10-sonnet-5` records the permanent Sonnet 5 rate of 2 USD per million input tokens and 10 USD per million output tokens from [Anthropic's official pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing), effective with the 2026-08-10 update.

The public report is pending until a complete 30-case, three-configuration, five-repeat live run succeeds and is reviewed. No benchmark value is entered by hand. Reports are generated only from committed or workflow-produced raw JSONL runs.

## What this demonstrates

Each row names the command or file that proves the claim. All of it runs without credentials or spend.

| Capability | What exists | Proof |
| --- | --- | --- |
| Evaluation design | 30 versioned cases with accepted tool plans, semantic assertions, forbidden tools and claims, scheduled faults, and abstention cases; three configurations, five repeats | `pnpm validate`, [datasets/v2](datasets/v2/cases.jsonl), [design note](docs/design-note.md) |
| Applied statistics | Wilson and Clopper-Pearson intervals, exact McNemar, seeded cluster and paired bootstrap, pass@k and pass^k, minimum detectable effect, all dependency-free and checked against scipy reference values | `pnpm vitest run tests/stats`, [src/stats](src/stats) |
| Honest reporting | The case is the unit of analysis; the report states what the sample size can and cannot detect and is byte-identical for the same raw JSONL | `pnpm vitest run tests/report-statistics.test.ts`, [src/report-statistics.ts](src/report-statistics.ts) |
| Go-live gate | PASS, BLOCK, or INCONCLUSIVE from versioned thresholds with a rationale per threshold; exit codes 0, 1, 2 | `pnpm gate:mock`, [config/thresholds.v1.json](config/thresholds.v1.json), [src/gate](src/gate) |
| Regression detection | A scripted regression is blocked through the real CLI, on both critical errors and non-inferiority | `pnpm vitest run tests/gate`, `pnpm mock:run --profile regressed --output runs/mock/regressed.jsonl` then `pnpm gate --raw runs/mock/regressed.jsonl --candidate no-resource-injection --reference routed` |
| Provider independence | Adapters declare capabilities; one contract test suite runs against the Anthropic and OpenAI-compatible adapters, and both run the whole benchmark and gate in mock mode | `pnpm vitest run tests/providers`, [src/providers](src/providers) |
| Auditability | Append-only JSONL log, each entry chained to the previous one by sha256 over canonical JSON; verification detects modified, deleted, inserted, and reordered lines | `pnpm vitest run tests/audit`, `pnpm audit:verify --log <path>`, [src/audit/log.ts](src/audit/log.ts) |
| Runtime safeguard | Rolling-window monitor that suspends on a Wilson upper bound and needs a named owner to re-enable, with every change logged | `pnpm demo:suspension`, [src/monitor/monitor.ts](src/monitor/monitor.ts) |

What is pending: **there are no benchmark results.** No complete live run of the full configuration exists, so this repository makes no claim about how any model performs. The gate thresholds are uncalibrated starting values. `pnpm gate:mock` exercises the pipeline with a scripted stand-in for a model; its PASS is not a result. The steps to produce real results are in the [live-run runbook](docs/RUNBOOK-live-run.md).

The suspension monitor and audit log are small illustrations of the pattern, not a monitoring or audit service: single writer, local file, no external anchoring of the log head.

## Requirements

- Node.js 22
- pnpm 10 through Corepack
- `ANTHROPIC_API_KEY` only for live execution

## Local workflow

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm validate
pnpm test:coverage
pnpm build
```

Run the fully mocked benchmark without credentials:

```sh
pnpm benchmark:mock
```

Run the whole pipeline (planner, runner, tools, fault schedule, scoring, gate) against a scripted model, also without credentials:

```sh
pnpm gate:mock
```

This writes `runs/mock/results.jsonl` and a gate summary under `reports/generated/mock-gate`. Both are labelled as mock data, and a report built from mock data always stays `pending`.

For live runs, create `.env.local` from `.env.example`, open it in your editor, and set the key there:

```dotenv
ANTHROPIC_API_KEY=your_key_here
```

The repository ignores `.env.local`. Optionally restrict the file to your user with `chmod 600 .env.local`. Do not place the key directly in a command, where it can be retained in shell history. Node's `--env-file` option loads the key only into the benchmark process.

Run a live smoke experiment with a strict two-dollar ceiling:

```sh
node --env-file=.env.local --import tsx src/cli.ts run --config config/smoke.v2.json --output runs/smoke-v2.jsonl
```

For a guided local run with a configuration picker, spend preflight, unique output files, and live progress:

```sh
node --env-file=.env.local --import tsx src/cli.ts run --interactive
```

Guided mode defaults to Smoke v2 and can also launch Full v2 or a custom validated configuration. It never requests or displays the Anthropic API key. Add `--config`, `--output`, or `--events` to the command above to prefill individual choices. Guided runs refuse existing artifact paths instead of appending to them.

Run the complete live benchmark only after reviewing a clean smoke result:

```sh
node --env-file=.env.local --import tsx src/cli.ts run --config config/full.v2.json --output runs/results.jsonl
pnpm report --raw runs/results.jsonl --events runs/events.jsonl --config config/full.v2.json --output reports/generated
pnpm gate --raw runs/results.jsonl --candidate routed --reference direct-sonnet
```

The `run` command appends to its output file, so use a fresh path for every run. The [live-run runbook](docs/RUNBOOK-live-run.md) has the full procedure, including the spend ceiling and the review before publishing.

The CLI defaults to `datasets/v2/manifest.json` and `config/full.v2.json` when the corresponding option is omitted.

Live runs use `--progress auto` by default. Interactive terminals receive an updating progress display with job, phase, elapsed time, ETA, spend, and outcome counts. CI and non-interactive terminals receive durable plain-text progress lines. Use `--progress plain` to force those lines or `--progress quiet` to suppress progress. Progress is written to stderr so stdout remains available for stable command output.

Press Ctrl+C once to cancel gracefully. The active provider request is aborted, completed JSONL rows are preserved, telemetry is flushed, and the command exits with status 130. A second Ctrl+C forces immediate termination.

Raw runs and append-only telemetry are written locally. Provider request IDs, API keys, and observability secrets are never included. Optional Langfuse export activates only when `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` are all present. Local JSONL remains the scoring source of truth.

## Reproducibility

Published output records the commit, dataset and configuration hashes, prompt and resource versions, exact provider-returned model identifiers, repeat count, seed, Node and lockfile versions, pricing version and effective date, timestamps, token usage, and raw-result references. Dataset versions are immutable after baseline release. Corrections require a new version and manifest hash.

`pnpm report --raw <path>` generates `summary.json`, `results.jsonl`, `report.md`, and a self-contained `index.html`. The reporter has no option for manually supplied aggregate values. The same raw JSONL always produces byte-identical files: run timestamps come from the telemetry events passed with `--events`, never from the wall clock.

## Go-live gate

`pnpm gate` compares a candidate configuration with a reference, either within one raw file or against a baseline file (`--baseline`), using [config/thresholds.v1.json](config/thresholds.v1.json).

| Exit code | Decision | Condition |
| --- | --- | --- |
| 0 | PASS | Every deterministic check passes, the critical-error bound is within its limit, and every paired difference clears its non-inferiority margin |
| 1 | BLOCK | A deterministic check failed, critical errors were observed beyond the limit, or a paired difference is below its margin with its whole interval |
| 2 | INCONCLUSIVE | An interval spans its margin or the sample is too small. The message says to collect more cases |

The gate writes `gate.json` and `gate.md` with the sha256 of every input, and with `--audit-log <path>` appends the decision to a hash-chained audit log. The [design note](docs/design-note.md) explains the analysis plan, the threshold rationale, and the limits of 30 cases.

## Providers

The benchmark is defined on the pinned Anthropic models. The runner itself holds no provider rules: adapters declare what each model accepts, and a second adapter for OpenAI-compatible chat completions endpoints is selected with `MODEL_PROVIDER=openai-compatible` (see [.env.example](.env.example)). Its models must have rates in the pricing file named by the experiment config. No result has been produced with it.

## Dataset v2 scoring contract

Dataset v2 scores required outcomes with structured semantic assertions. Each assertion contains one or more text conditions, and alternative assertion groups represent accepted paraphrases. This avoids requiring one exact sentence while keeping completion criteria deterministic.

Tool behavior is evaluated against one or more accepted plans per case. Each plan specifies call order and call-specific argument matchers, so distinct valid strategies can pass without accepting unrelated calls. Null and empty tool results are retained as meaningful negative evidence, allowing evidence-backed abstention without inventing facts.

Safe policy reads are accepted only when the prompt requests the policy or when the read occurs immediately before a related simulated write. A related policy read may also appear first when it is part of the declared accepted plan for that write. Irrelevant reads, undeclared extra calls, and all extra writes remain rejected. This policy is explicit in each case's accepted plans rather than applied as a global scoring exception.

## CI and publication

- Pull requests run a free, secretless validation and replay gate. It includes `pnpm gate:mock`, which runs the full pipeline on a scripted model and fails the build unless the gate passes.
- Trusted same-repository changes can use the protected `live-smoke` environment. Fork pull requests cannot receive provider credentials.
- Monthly, tagged, and manually dispatched full runs use the protected `full-benchmark` environment and a hard 25-dollar ceiling.
- A candidate baseline is promoted only through reviewed repository changes. CI never promotes it automatically.
- Pages publishes the latest reviewed report and immutable historical reports.

See the [design note](docs/design-note.md) for the go-live gate: the decision it supports, the unit of analysis, the pre-registered analysis plan, threshold rationale, open questions, and limitations. See [docs/architecture.md](docs/architecture.md) for the boundary between the domain-free core and the fiscal domain pack, and [CHANGELOG.md](CHANGELOG.md) for what changed.

See [CONTRIBUTING.md](CONTRIBUTING.md) for dataset and baseline rules and [SECURITY.md](SECURITY.md) for responsible disclosure.

## License

Apache License 2.0. Synthetic fixtures and benchmark outputs are public under the same license unless a file states otherwise.
