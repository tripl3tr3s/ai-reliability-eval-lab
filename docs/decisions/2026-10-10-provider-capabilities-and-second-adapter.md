# ADR: provider rules behind adapter capabilities, and a second adapter

| Field | Value |
| --- | --- |
| Date | 2026-10-10 |
| Status | Accepted. Implemented on `feat/go-live-gate` (`9621417`, `27780d8`), not yet merged. The OpenAI-compatible adapter has only been run against simulated transport. |
| Related | [Architecture](../architecture.md), [model lineup decision](2026-10-03-model-lineup-benchmark-cost-estimates.md) |

## Context

A `ModelAdapter` interface existed, but provider rules leaked past it. `runner.ts` chose the per-call output limit and the temperature by comparing against Anthropic model ids and compared the stop reason to an Anthropic literal. `experiment.ts` hardcoded the executor and router models. Assistant turns were stored as an ad hoc JSON string that the adapter parsed back.

## Decision

1. Adapters declare `capabilities(model)`: provider, temperature support and pinned temperature, per-call output allowance, tool calling, structured output mode. The runner reads these and holds no provider rule.
2. `capabilities` is optional on the interface. Resolution order is the adapter's own declaration, then a registry of pinned models (`src/providers/capabilities.ts`), then generic defaults (no temperature, 4 096 tokens).
3. Model ids come from a `ModelRoles` value (executor, router, simple executor) passed to `runExperiment`, defaulting to the pinned Anthropic models.
4. Stop reasons use a normalized vocabulary (`end_turn`, `tool_use`, `max_tokens`). Provider failures are thrown as `ModelProviderError` with a provider-neutral code, a retryable flag, and the original error as the cause.
5. The assistant-turn string format is unchanged but owned by one codec, `src/providers/assistant-turn.ts`.
6. A second adapter targets OpenAI-compatible chat completions, built on `fetch` with no SDK, selected with `MODEL_PROVIDER=openai-compatible`. It reads the response as a stream and stops at 1 MiB.
7. One contract test suite runs against every adapter with mocked transport. Both adapters run the full benchmark and the gate in mock mode and produce identical scored behaviour.
8. Anthropic requests are pinned by snapshots recorded before the refactor.

## Alternatives considered

- **Make `capabilities` required.** Rejected: about 25 inline test adapters would need editing, and existing runner tests assert Sonnet and Haiku behaviour through adapters that declare nothing. The registry fallback keeps them valid.
- **Have the adapter silently drop an unsupported temperature.** Rejected: the documented behaviour is that the Anthropic adapter rejects a Sonnet temperature before any request.
- **Use the OpenAI SDK.** Rejected: a new dependency for one POST request.
- **Leave Anthropic errors unwrapped.** Rejected: a normalized error contract that one adapter does not follow is not a contract. Messages are preserved.
- **Provider-enforced JSON schema output.** Not done. Both adapters ask for the final JSON by instruction and the runner validates it. The capability flag exists for a later change.

## Consequences

- Adding a provider means one adapter, one harness in the contract tests, and optionally a registry entry.
- Arm names such as `direct-sonnet` remain. They are part of the raw row contract.
- Callers that matched on Anthropic SDK error classes now see `ModelProviderError`.
- OpenAI-compatible models need rates in the pricing file named by the experiment config, or the run refuses to start.
- This does not add Sonnet 5.5 or Opus 5.5. That stays with the model lineup decision.
