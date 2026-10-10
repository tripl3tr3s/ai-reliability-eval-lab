# Architecture: core and domain pack

The lab has two kinds of code: a domain-free core (statistics, gate, audit, monitor, provider adapters) and a Mexican fiscal domain pack (fixtures, synthetic tools, dataset). This document maps every module and states where the boundary is enforced and where it is only described.

## Enforced boundary

New core code lives in its own directories, and ESLint (`eslint.config.js`, rule `no-restricted-imports`) fails the build if any of them imports the domain pack (`fixtures`, `tools`, `efos-risk-graph`), the experiment loop, or the mock run.

| Directory | Role | May import |
| --- | --- | --- |
| `src/stats/` | Intervals, exact tests, bootstrap, pass@k, power | Nothing outside the directory |
| `src/audit/` | Canonical JSON, hash-chained append-only log | Nothing outside the directory |
| `src/monitor/` | Suspension state machine | `stats`, `audit` |
| `src/gate/` | Thresholds schema, severity rules, decision, rendering | `stats`, `dataset`, `scoring`, `report-statistics` |
| `src/providers/` | Capabilities, assistant-turn codec, OpenAI-compatible adapter, env factory | `contracts`, `pricing`, `adapter` |

## Module map

| Module | Kind | Notes |
| --- | --- | --- |
| `src/stats/*`, `src/audit/*`, `src/monitor/*` | Core | No domain knowledge |
| `src/gate/*` | Core | Reads dataset case fields (`forbiddenTools`, `expectedState`, `forbiddenClaims`, `category`) that any domain pack would need to supply. Write tools are passed in as a set |
| `src/providers/*`, `src/adapter.ts` | Core | `adapter.ts` is the Anthropic adapter and holds the pinned model ids and their capabilities |
| `src/report-statistics.ts`, `src/raw-run.ts`, `src/report-command.ts` | Core | Work on raw rows and scores only |
| `src/pricing.ts`, `src/telemetry.ts`, `src/run-signal.ts`, `src/faults.ts` | Core | |
| `src/cli.ts`, `src/cli-options.ts`, `src/cli-ui.ts`, `src/guided-run.ts` | Core | Command wiring |
| `src/report.ts`, `src/baseline.ts` | Core, with constants | `report.ts` hardcodes the 30 case, 3 configuration, 5 repeat completeness rule and the default configuration names |
| `src/config.ts` | Mixed | Configuration ids, tool allowlist, and default model roles for this benchmark |
| `src/contracts.ts` | Mixed | Provider contract is generic. `CaseState`, `FollowUp`, and `PaymentMatch` are fiscal shapes |
| `src/runner.ts` | Mixed | The loop is generic. `finalState` is built from the fiscal case state |
| `src/scoring.ts` | Mixed | Plan and assertion scoring is generic. Evidence matching knows identifier prefixes (`inv`, `pay`, `rfc`, `cn`) |
| `src/dataset.ts` | Mixed | Schema is generic. The loader requires exactly 30 cases split 10/10/8/2 |
| `src/experiment.ts` | Mixed | Orchestration is generic. Evidence-fact projection branches on tool names, and the system prompt names the fiscal role |
| `src/gate-command.ts`, `src/mock/*` | Glue | Join the core to this domain pack: they read the tool definitions and the dataset |
| `src/fixtures.ts`, `src/tools.ts` | Domain pack | Fictional documents, payments, supplier statuses, policies, the 8 synthetic tools, and all use of `efos-risk-graph` |
| `datasets/v1`, `datasets/v2` | Domain pack | Cases, plans, assertions, fault schedules |

## Why files were not moved

A physical split of the mixed modules would mean introducing generic state, evidence-projection, and dataset-shape interfaces across `contracts`, `runner`, `scoring`, `dataset`, and `experiment`, and editing most test files. That is a real refactor with risk to the scoring contract, and it would not add evidence about model behaviour. The chosen approach is narrower: keep existing files in place, put all new work behind an enforced boundary, and record the remaining coupling here.

## What a second domain pack would need

1. A dataset with the same case schema, and a loader without the 30 case and category-count constants.
2. Its own tools and fixtures, registered through the same `ToolDefinition` contract, each declaring `sideEffect`.
3. A generic case state in place of `followUps` and `paymentMatches` (`contracts.ts`, `runner.ts`, `tools.ts`).
4. Evidence-fact projection supplied by the pack instead of `evidenceFactsFor` in `experiment.ts`.
5. Identifier patterns for evidence matching supplied by the pack instead of the regex in `scoring.ts`.
6. A system prompt and operational resources supplied by the pack.

Nothing in `src/stats`, `src/audit`, `src/monitor`, `src/gate`, or `src/providers` would need to change.
