# AI Reliability and Evaluation Lab

A reproducible, synthetic benchmark for bounded tool-using agents. It compares direct Sonnet, routed Haiku/Sonnet, and routed execution without operational resource injection. The benchmark uses fictional Mexican fiscal and operational data and the published `efos-risk-graph` package. Dataset v2 and its matching v2 experiment configurations are the current benchmark contract. The v1 dataset remains available for historical reference and compatibility checks.

The benchmark pins `claude-sonnet-5` for Sonnet execution and `claude-haiku-4-5-20251001` for routing and simple read-only execution. Sonnet 5 requests omit `temperature` so Anthropic's adaptive-thinking defaults remain valid, and the adapter rejects any defined Sonnet temperature before making a provider request. Haiku routing and execution retain `temperature: 0` for deterministic classification and simple-task behavior.

Sonnet 5 receives an 8,192-token per-call output allowance within the unchanged 12,000-token total run ceiling. A provider `max_tokens` stop is recorded as a bounded outcome instead of being treated as malformed output or repaired. This gives adaptive thinking more room while preserving the benchmark's hard run-level bound.

Runtime cost calculation uses the validated, versioned [pricing configuration](config/pricing.v1.json), not adapter constants. Pricing version `anthropic-2026-08-10-sonnet-5` records the permanent Sonnet 5 rate of 2 USD per million input tokens and 10 USD per million output tokens from [Anthropic's official pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing), effective with the 2026-08-10 update.

The public report is pending until a complete 30-case, three-configuration, five-repeat live run succeeds and is reviewed. No benchmark value is entered by hand. Reports are generated only from committed or workflow-produced raw JSONL runs.

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

Run a live smoke experiment with a strict two-dollar ceiling:

```sh
ANTHROPIC_API_KEY=... pnpm benchmark --config config/smoke.v2.json --output runs/smoke-v2.jsonl
```

Run the complete live benchmark only after reviewing a clean smoke result:

```sh
ANTHROPIC_API_KEY=... pnpm benchmark --config config/full.v2.json --output runs/results.jsonl
pnpm report --raw runs/results.jsonl --config config/full.v2.json --output reports/generated
```

The CLI defaults to `datasets/v2/manifest.json` and `config/full.v2.json` when the corresponding option is omitted.

Raw runs and append-only telemetry are written locally. Provider request IDs, API keys, and observability secrets are never included. Optional Langfuse export activates only when `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` are all present. Local JSONL remains the scoring source of truth.

## Reproducibility

Published output records the commit, dataset and configuration hashes, prompt and resource versions, exact provider-returned model identifiers, repeat count, seed, Node and lockfile versions, pricing version and effective date, timestamps, token usage, and raw-result references. Dataset versions are immutable after baseline release. Corrections require a new version and manifest hash.

`pnpm report --raw <path>` generates `summary.json`, `results.jsonl`, `report.md`, and a self-contained `index.html`. The reporter has no option for manually supplied aggregate values.

## Dataset v2 scoring contract

Dataset v2 scores required outcomes with structured semantic assertions. Each assertion contains one or more text conditions, and alternative assertion groups represent accepted paraphrases. This avoids requiring one exact sentence while keeping completion criteria deterministic.

Tool behavior is evaluated against one or more accepted plans per case. Each plan specifies call order and call-specific argument matchers, so distinct valid strategies can pass without accepting unrelated calls. Null and empty tool results are retained as meaningful negative evidence, allowing evidence-backed abstention without inventing facts.

Safe policy reads are accepted only when the prompt requests the policy or when the read occurs immediately before a related simulated write. A related policy read may also appear first when it is part of the declared accepted plan for that write. Irrelevant reads, undeclared extra calls, and all extra writes remain rejected. This policy is explicit in each case's accepted plans rather than applied as a global scoring exception.

## CI and publication

- Pull requests run a free, secretless validation and replay gate.
- Trusted same-repository changes can use the protected `live-smoke` environment. Fork pull requests cannot receive provider credentials.
- Monthly, tagged, and manually dispatched full runs use the protected `full-benchmark` environment and a hard 25-dollar ceiling.
- A candidate baseline is promoted only through reviewed repository changes. CI never promotes it automatically.
- Pages publishes the latest reviewed report and immutable historical reports.

See [CONTRIBUTING.md](CONTRIBUTING.md) for dataset and baseline rules and [SECURITY.md](SECURITY.md) for responsible disclosure.

## License

Apache License 2.0. Synthetic fixtures and benchmark outputs are public under the same license unless a file states otherwise.
