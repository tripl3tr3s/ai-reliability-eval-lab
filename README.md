# AI Reliability and Evaluation Lab

A reproducible, synthetic benchmark for bounded tool-using agents. It runs the same Mexican fiscal tasks through different model configurations ("arms"), grades every tool call and answer deterministically, and decides with a statistical go-live gate whether a candidate arm is safe to promote over a reference arm. All data and tools are fictional and run in process; the published `efos-risk-graph` package supplies the supplier-risk graph.

## Status

**There are no benchmark results yet.** No complete live run of any full configuration exists, so this repository makes no claim about how any model performs. Gate thresholds are uncalibrated starting values. Everything described below runs without credentials, and the mock commands (`pnpm gate:mock`, `pnpm gate:mock:v3`) drive the real pipeline with a scripted stand-in for a model: their PASS proves the pipeline works, not that any model does. The [live-run runbook](docs/RUNBOOK-live-run.md) has the steps to produce real results.

No benchmark value is ever entered by hand. Reports are generated only from committed or workflow-produced raw JSONL runs.

## Datasets and arms

| Dataset | Status | Cases | Arms (configurations) | Configs | Thresholds |
| --- | --- | --- | --- | --- | --- |
| v3 | **Target benchmark** for the lineup DISAI_Conta runs today. Implemented and mock-gated; no live run yet | 90, Mexican Spanish: 20 lookup, 24 multi-tool, 18 recovery, 14 abstention, 14 confirmation; 17 tools shaped after sat-mcp | `prod-routed-5-5` (candidate): Haiku 5.5 domain router at effort `low`, Sonnet 5.5 at `medium`, Opus 5.5 at `high` for the `pagos` and `cumplimiento` domains. `direct-sonnet-5-5` (reference): Sonnet 5.5 at `medium` | `config/smoke.v3.json` (20 jobs, USD 2 cap), `config/full.v3.json` (900 jobs, USD 40 cap) | `config/thresholds.v3.json` (`thresholds.v2.json` for earlier decisions) |
| v2 | Previous benchmark, kept for comparison. One partial live run (2026-09-01, aborted; see the [post-mortem](docs/postmortems/2026-09-01-full-benchmark-deadline-abort.md)) | 30, English: 10 lookup, 10 multi-tool, 8 recovery, 2 abstention; 8 tools | `routed` (candidate), `direct-sonnet` (reference), `no-resource-injection` (ablation), on Sonnet 5 and Haiku 4.5 | `config/smoke.v2.json` (24 jobs, USD 2 cap), `config/full.v2.json` (450 jobs, USD 25 cap) | `config/thresholds.v1.json` |
| v1 | Historical, for compatibility checks only | 30 | Same arms as v2 | `config/smoke.v1.json`, `config/full.v1.json` | `config/thresholds.v1.json` |

**Defaults are v3.** When `--config` or `--manifest` is omitted, the CLI uses `config/full.v3.json` and `datasets/v3/manifest.json`; guided mode preselects Smoke v3; the `live-smoke` and `full-benchmark` workflows default their `dataset` input to `v3`. Pass `--config config/full.v2.json` (or `config/smoke.v2.json`) to run v2. The gate picks thresholds and default arms from the config's dataset, so it needs no `--candidate` or `--reference` for either.

Why v3 replaced v2 as the target (5.5 lineup, Spanish prompts, sat-mcp-shaped tools, stricter matchers) is in the [v3 decision record](docs/decisions/2026-10-14-dataset-v3-and-5-5-arms.md).

### Model pins and run limits

- **v3 arms** pin `claude-haiku-5-5`, `claude-sonnet-5-5`, and `claude-opus-5-5` with adaptive thinking and an explicit effort on every call, because the API defaults differ by model. Assistant blocks, thinking included, are replayed verbatim with tool results. Refusals end the run with their category; no server-side fallback model is enabled, so every row is attributable to the model under test. Runs are bounded by `V3_AGENT_POLICY` in `src/config.ts` (150 000 tokens and 180 s per run, starting values for the smoke run to calibrate). Prices come from `config/pricing.v2.json` (version `anthropic-2026-10-13-5-5-lineup`).
- **v2 arms** pin `claude-sonnet-5` and `claude-haiku-4-5-20251001`. Sonnet 5 requests omit `temperature` so adaptive-thinking defaults stay valid, and the adapter rejects a defined Sonnet temperature before sending. Haiku keeps `temperature: 0`. Sonnet 5 gets 8 192 output tokens per call inside a 12 000-token run ceiling. Prices come from `config/pricing.v1.json` (version `anthropic-2026-08-10-sonnet-5`).
- In both, a provider `max_tokens` stop is recorded as a `bounded` outcome, never repaired or treated as malformed output; every `bounded` or `failed` row records a `terminationReason`, and cost is computed from the versioned pricing file, never from adapter constants. Pricing files are checked against [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing) before every live run.

## Documentation map

| Read this | For |
| --- | --- |
| [docs/RUNBOOK-live-run.md](docs/RUNBOOK-live-run.md) | Running a live benchmark, the gate, review, and baseline promotion |
| [docs/design-note.md](docs/design-note.md) | How the gate decides: unit of analysis, severity, analysis plan, threshold rationale, limits |
| [docs/architecture.md](docs/architecture.md) | Module map and the boundary between the domain-free core and the domain packs |
| [docs/decisions/](docs/decisions) | One record per significant choice, with the alternatives considered |
| [docs/postmortems/](docs/postmortems) | What went wrong in earlier live runs and what changed |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Rules for datasets, thresholds, baselines, and adapters |
| [CHANGELOG.md](CHANGELOG.md) | What changed |

## What this demonstrates

Each row names the command or file that proves the claim. All of it runs without credentials or spend.

| Capability | What exists | Proof |
| --- | --- | --- |
| Evaluation design | Versioned, immutable datasets (90 cases in v3, 30 in v2) with accepted tool plans, per-call argument matchers, semantic assertions, forbidden tools, claims, and values, scheduled faults, abstention cases, and human-confirmation cases; five repeats per arm | `pnpm validate`, [datasets/v3](datasets/v3/cases.jsonl), [design note](docs/design-note.md) |
| Trajectory grading | Every tool call is checked in order against one or more accepted plans; undeclared writes are critical errors, and each v3 case ships a reference answer that must pass and at least three counterexamples that must fail | `pnpm vitest run tests/dataset-v3.test.ts`, [src/scoring.ts](src/scoring.ts) |
| Applied statistics | Wilson and Clopper-Pearson intervals, exact and mid-p McNemar, Bonett-Price paired intervals (single-run and case-clustered), Sidak and Shaffer multiplicity, ICC(1), unbiased pass^k, seeded cluster and paired bootstrap, minimum detectable effect, all dependency-free and checked against scipy and evalstats reference values and seeded coverage simulations | `pnpm vitest run tests/stats`, [src/stats](src/stats) |
| Honest reporting | The case is the unit of analysis; the report states what the sample size can and cannot detect and is byte-identical for the same raw JSONL | `pnpm vitest run tests/report-statistics.test.ts`, [src/report-statistics.ts](src/report-statistics.ts) |
| Go-live gate | PASS, BLOCK, or INCONCLUSIVE from versioned thresholds with a rationale per threshold; exit codes 0, 1, 2 | `pnpm gate:mock`, `pnpm gate:mock:v3`, [config/thresholds.v3.json](config/thresholds.v3.json), [src/gate](src/gate) |
| Regression detection | A scripted regression is blocked through the real CLI, on both critical errors and non-inferiority | `pnpm vitest run tests/gate`, `pnpm mock:run --profile regressed --output runs/mock/regressed.jsonl` then `pnpm gate --raw runs/mock/regressed.jsonl` (exit code 1, BLOCK) |
| Provider independence | Adapters declare capabilities; one contract test suite runs against the Anthropic and OpenAI-compatible adapters, and both run the whole benchmark and gate in mock mode | `pnpm vitest run tests/providers`, [src/providers](src/providers) |
| Auditability | Append-only JSONL log, each entry chained to the previous one by sha256 over canonical JSON; verification detects modified, deleted, inserted, and reordered lines | `pnpm vitest run tests/audit`, `pnpm audit:verify --log <path>`, [src/audit/log.ts](src/audit/log.ts) |
| Runtime safeguard | Rolling-window monitor that suspends on a Wilson upper bound and needs a named owner to re-enable, with every change logged | `pnpm demo:suspension`, [src/monitor/monitor.ts](src/monitor/monitor.ts) |

The suspension monitor and audit log are small illustrations of the pattern, not a monitoring or audit service: single writer, local file, no external anchoring of the log head.

## Requirements

- Node.js 22 or later (CI uses 22)
- pnpm 10.15 through Corepack (pinned in `package.json`)
- `ANTHROPIC_API_KEY` only for live execution, on a Platform account with credit (the runs are billed per token)

## Local workflow

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm validate
pnpm test:coverage
pnpm build
```

`pnpm check` runs lint, type-check, coverage, and validation in one go.

Run the whole pipeline (planner, runner, tools, fault schedule, scoring, gate) against a scripted model, without credentials:

```sh
pnpm gate:mock:v3        # dataset v3, writes runs/mock/v3-results.jsonl and reports/generated/mock-gate-v3
pnpm gate:mock:v3:noisy  # dataset v3 with outcomes that vary by case, arm and repeat (expected: PASS)
pnpm gate:mock           # dataset v2, writes runs/mock/results.jsonl and reports/generated/mock-gate
```

The clean profile agrees on every case, so its intervals only show the width the sample allows. The `noisy` profile drops a required fact in three of five repeats of nine cases in both arms, and in one repeat of one case per arm. It gives a positive ICC and one lost case each way, the boundary where `thresholds-v3` still passes (lower bound -4.26 points against a 5 point margin), without any critical error.

Both outputs are labelled as mock data, and a report built from mock data always stays `pending`. `pnpm benchmark:mock` runs the experiment test suite, which exercises the runner with mocked providers.

For live runs, create `.env.local` from `.env.example`, open it in your editor, and set the key there:

```dotenv
ANTHROPIC_API_KEY=your_key_here
```

The repository ignores `.env.local`. Optionally restrict the file to your user with `chmod 600 .env.local`. Do not place the key directly in a command, where it can be retained in shell history. Node's `--env-file` option loads the key only into the benchmark process.

The easiest way to start a live run is guided mode. It offers Smoke and Full for v2 and v3 (or a custom validated config), shows the spend preflight, creates fresh output paths, and shows live progress. It never asks for or displays the API key.

```sh
node --env-file=.env.local --import tsx src/cli.ts run --interactive
```

Guided mode preselects Smoke v3. Add `--config`, `--output`, or `--events` to prefill a choice.

The non-interactive equivalent of a v3 smoke run (USD 2 ceiling) uses a fresh directory per run, because `run` **appends** to its output and events files (defaults `runs/results.jsonl` and `runs/events.jsonl`):

```sh
RUN_ID="smoke-v3-$(date -u +%Y%m%dT%H%M%SZ)" && mkdir -p "runs/$RUN_ID"
node --env-file=.env.local --import tsx src/cli.ts run --config config/smoke.v3.json \
  --output "runs/$RUN_ID/results.jsonl" --events "runs/$RUN_ID/events.jsonl"
```

Run a full benchmark only after reviewing a clean smoke result, and follow the [live-run runbook](docs/RUNBOOK-live-run.md): it covers the spend ceiling, the report, the gate, and the review before anything is published.

Live runs use `--progress auto` by default. Interactive terminals receive an updating progress display with job, phase, elapsed time, ETA, spend, and outcome counts. CI and non-interactive terminals receive durable plain-text progress lines. Use `--progress plain` to force those lines or `--progress quiet` to suppress progress. Progress is written to stderr so stdout remains available for stable command output.

Press Ctrl+C once to cancel gracefully. The active provider request is aborted, completed JSONL rows are preserved, telemetry is flushed, and the command exits with status 130. A second Ctrl+C forces immediate termination.

Raw runs and append-only telemetry are written locally. Provider request IDs, API keys, and observability secrets are never included. Optional Langfuse export activates only when `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` are all present. Local JSONL remains the scoring source of truth.

## Reproducibility

Published output records the commit, dataset and configuration hashes, the scoring contract version and hash (`config/scoring-contract.json`; a report from a scorer that does not match the lock stays `pending`), prompt and resource versions, exact provider-returned model identifiers, repeat count, seed, Node and lockfile versions, pricing version and effective date, timestamps, token usage, and raw-result references. Dataset versions are immutable after baseline release. Corrections require a new version and manifest hash.

`pnpm report --raw <path>` generates `summary.json`, `results.jsonl`, `report.md`, and a self-contained `index.html`. The reporter has no option for manually supplied aggregate values. The same raw JSONL always produces byte-identical files: run timestamps come from the telemetry events passed with `--events`, never from the wall clock. The statistics follow [analysis plan v2](docs/decisions/2026-10-24-analysis-plan-v2.md): the headline is the share of cases that passed every repeat, with verdicts and rank bands, a sensitivity analysis without runs that stopped early, cost per case over all runs, and a scope statement. `summary.json` records the methods version (`statistics.method.version`), and `pnpm report:mock:v3` checks that every block is present.

## Go-live gate

`pnpm gate` compares a candidate configuration with a reference, either within one raw file or against a baseline file (`--baseline`). The thresholds and default arms follow the dataset of the config passed with `--config` (default `config/full.v3.json`): [config/thresholds.v3.json](config/thresholds.v3.json) with `prod-routed-5-5` against `direct-sonnet-5-5` for v3, and [config/thresholds.v1.json](config/thresholds.v1.json) with `routed` against `direct-sonnet` for v1 and v2. `--thresholds`, `--candidate`, and `--reference` override them.

For v3, `thresholds-v3` counts a case as passed only if every repeat passed and compares the arms with the Bonett-Price adjusted Wald interval for paired proportions, checked against evalstats. Margins are 5 points for completion and tool accuracy and 15 points for the 18 recovery cases, the tightest that 90 and 18 cases can demonstrate. The per-case pass rate is reported beside each decision, not gated. `thresholds-v1` and `thresholds-v2` keep the percentile bootstrap, so earlier decisions replay unchanged. See [the decision record](docs/decisions/2026-10-24-thresholds-v3-bonett-price-gate.md).

| Exit code | Decision | Condition |
| --- | --- | --- |
| 0 | PASS | Every deterministic check passes, the critical-error bound is within its limit, and every paired difference clears its non-inferiority margin |
| 1 | BLOCK | A deterministic check failed, critical errors were observed beyond the limit, or a paired difference is below its margin with its whole interval |
| 2 | INCONCLUSIVE | An interval spans its margin or the sample is too small. The message says to collect more cases |

The gate writes `gate.json` and `gate.md` with the sha256 of every input, and with `--audit-log <path>` appends the decision to a hash-chained audit log. The [design note](docs/design-note.md) explains the analysis plan, the threshold rationale, and what 30 or 90 cases can and cannot detect. In short: expect INCONCLUSIVE when the arms differ on only a few cases. That is the honest answer at these sample sizes, not a defect.

## Providers

The benchmark is defined on the pinned Anthropic models. The runner itself holds no provider rules: adapters declare what each model accepts, and a second adapter for OpenAI-compatible chat completions endpoints is selected with `MODEL_PROVIDER=openai-compatible` (see [.env.example](.env.example)). Its models must have rates in the pricing file named by the experiment config. No result has been produced with it.

## Scoring contract

A run passes completion only if its outcome, every required assertion, the forbidden-claim check, and the final tool state all pass. The rules below apply to v2 and v3; v3 tightens them as listed at the end.

Dataset v2 scores required outcomes with structured semantic assertions. Each assertion contains one or more text conditions, and alternative assertion groups represent accepted paraphrases. This avoids requiring one exact sentence while keeping completion criteria deterministic.

Tool behavior is evaluated against one or more accepted plans per case. Each plan specifies call order and call-specific argument matchers, so distinct valid strategies can pass without accepting unrelated calls. Null and empty tool results are retained as meaningful negative evidence, allowing evidence-backed abstention without inventing facts.

Safe policy reads are accepted only when the prompt requests the policy or when the read occurs immediately before a related simulated write. A related policy read may also appear first when it is part of the declared accepted plan for that write. Irrelevant reads, undeclared extra calls, and all extra writes remain rejected. This policy is explicit in each case's accepted plans rather than applied as a global scoring exception.

Dataset v3 adds:

- **Spanish matching** (`src/text-es.ts`): accent-insensitive, with negation scoped to its clause, amounts parsed numerically from common formats ("1,160.00", "1 160", "66 mil"), and identifiers matched as whole tokens.
- **No lone generic words.** Every required alternative contains an amount, an identifier, a dated or numeric phrase, or only multi-word phrases. A test enforces it.
- **`forbiddenValues`.** Stating a listed wrong figure is the critical error `wrong_value`, so a wrong number no longer looks like a missing one.
- **`allowedExtraCalls`.** Declared read tools may be called extra times up to a count; undeclared calls and every extra write still fail.
- **Scorer self-checks.** Each case has a reference answer that must pass and at least three counterexamples that must fail. This validates the scorer against authored answers only. Agreement with human labels of live answers is measured with a blinded audit (`pnpm scorer-audit:sample`, then `pnpm scorer-audit:score`: false pass and false fail rates per arm with Wilson intervals; see [the decision record](docs/decisions/2026-10-24-scorer-audit.md)); no live run has been audited yet.

## CI and publication

- Pull requests run a free, secretless validation and replay gate. It includes `pnpm gate:mock` and `pnpm gate:mock:v3`, which run the full pipeline on a scripted model and fail the build unless the gate passes.
- Trusted same-repository changes can use the protected `live-smoke` environment. Fork pull requests cannot receive provider credentials.
- Monthly, tagged, and manually dispatched full runs use the protected `full-benchmark` environment, with a hard ceiling of USD 40 for v3 (the default, also for scheduled and tag runs) and USD 25 for v2 (choose it in the dispatch form).
- A candidate baseline is promoted only through reviewed repository changes. CI never promotes it automatically.
- Pages publishes the latest reviewed report and immutable historical reports.

See [SECURITY.md](SECURITY.md) for responsible disclosure.

## License

Apache License 2.0. Synthetic fixtures and benchmark outputs are public under the same license unless a file states otherwise.
