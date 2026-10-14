# Model lineup benchmark: configurations and cost estimates

| Field | Value |
| --- | --- |
| Date | 2026-10-03 |
| Status | Proposed, not implemented. No decision on configuration set or repeats yet. |
| Related | [Post-mortem 2026-09-01](../postmortems/2026-09-01-full-benchmark-deadline-abort.md) |

## Context

DISAI_Conta (`disai-conta`, commit `f5c5422`, 2026-09-17) calls these models in production code:

| Model | Production use |
| --- | --- |
| `claude-haiku-4-5` | Intent router, orchestrator validate/response steps, autofill, informational expert queries |
| `claude-sonnet-4-6` | Standard domain-agent executioner, `/api/ai/chat`, non-informational expert queries, `ANTHROPIC_MODEL` default |
| `claude-sonnet-5` | Advanced domain-agent executioner (carta-porte, nomina, pagos, cumplimiento) |
| `claude-opus-4-8` | Declared in `MODEL_IDS.opus`; nothing in production routes to it |

sat-mcp (`mexican-automation-mcps`) makes no model calls; all model usage is in DISAI_Conta.

As of 2026-10-03, Anthropic lists Sonnet 4.6, Sonnet 5 and Opus 4.8 as legacy. The current lineup is Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 4.5. This eval lab currently benchmarks only Sonnet 5 (executor) and Haiku 4.5 (router), so it represents only DISAI_Conta's advanced tier.

Prices used below (USD per million input / output tokens, verified on the Anthropic pricing page on 2026-10-03):

| Model | Input | Output |
| --- | --- | --- |
| `claude-haiku-4-5-20251001` | 1 | 5 |
| `claude-sonnet-4-6` | 3 | 15 |
| `claude-sonnet-5` | 2 | 10 |
| `claude-sonnet-5-5` | 2 | 10 |
| `claude-opus-5-5` | 4 | 20 |

## Option 1: benchmark the current lineup on the existing synthetic dataset

Baseline: the 2026-09-01 full run measured Sonnet 5 at **USD 0.0178 per job** (`direct-sonnet`, 94 jobs). Each configuration is 150 jobs (30 cases x 5 repeats). New models are scaled from the Sonnet 5 measurement by price and tokenizer.

| Configuration | Model | Adjustment | Estimate (150 jobs) |
| --- | --- | --- | --- |
| direct-sonnet (existing) | Sonnet 5 | measured | USD 2.67 |
| routed (existing) | Haiku router -> Sonnet 5 | measured | USD 2.25 |
| no-resource-injection (existing) | Sonnet 5 | measured | USD 2.34 |
| direct-sonnet-5-5 (new) | Sonnet 5.5 | same price and tokenizer, x1.0 | USD 2.67 |
| direct-opus-5-5 (new) | Opus 5.5 | 2x price, same tokenizer, x2.0 | USD 5.33 |
| direct-sonnet-4-6 (new) | Sonnet 4.6 | 1.5x price, about 30 % fewer tokens, x1.15 | USD 3.07 |
| **Total, 6 configurations** | | | **about USD 18.30** |

### Cheaper versions

| Setup | Estimate |
| --- | --- |
| 6 configurations, 5 repeats | USD 18.30 |
| 4 direct models only (drop routed / no-resource-injection), 5 repeats | USD 13.75 |
| 6 configurations, 3 repeats | USD 11.00 |
| 4 direct models, 3 repeats | USD 8.25 |

Recommendation at the time of writing: 6 configurations, 5 repeats. Fewer repeats weakens the statistical confidence of model-to-model differences more than the USD 7 saving is worth. Fund about USD 15 above the then-current USD 10.55 Platform balance and set `MAX_EXPERIMENT_COST_USD` to `25`.

### Confidence in the estimates

- **Sonnet 5.5 and existing configurations**: high. Measured data at the same price.
- **Sonnet 4.6**: likely an overestimate. Without thinking enabled it writes fewer output tokens.
- **Opus 5.5**: the main uncertainty. Thinking is always on and is billed as output, so it may cost 2-3x Sonnet 5 rather than 2x. Worst case about USD 8 instead of USD 5.33, still inside the recommended budget.

## Open design decisions

1. **Effort parity**: Opus 5.5 defaults to `medium` effort, Sonnet 5.5 to `high`. Set effort explicitly to mirror DISAI_Conta (`medium` for the standard tier, `high` for the advanced tier).
2. **Token ceiling**: `DEFAULT_AGENT_POLICY.maxTokens` is 12 000 per job and includes thinking tokens. Thinking-heavy models (Opus 5.5) may hit it and score `bounded` without making a mistake. Validate with a smoke run before the full run.
3. **Implementation scope**: `ANTHROPIC_MODELS` in `src/adapter.ts` pins only two models, so new models need to be added there; add `config/pricing.v2.json` with the new rates (keep `pricing.v1.json` unchanged so recorded reports stay reproducible); add the new configurations. Touches several files, so plan first.

## Option 2 (later, separate project)

A v3 dataset driven by sat-mcp's real tool definitions (the 43 tools DISAI_Conta allowlists, with their Spanish names and schemas, served by a mock or sandbox) and Spanish user prompts. The current lab measures generic tool-use reliability with 8 synthetic in-process tools, not how well a model drives sat-mcp.
