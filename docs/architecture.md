# Architecture: core and domain pack

The lab has two kinds of code: a domain-free core (statistics, gate, audit, monitor, provider adapters) and domain packs that supply tools, fixtures, case state, and prompts. Two packs exist: `fiscal-v2` (English, datasets v1 and v2) and `sat-v3` (Mexican Spanish, dataset v3). This document maps every module and states where the boundary is enforced and where it is only described.

## Enforced boundary

New core code lives in its own directories, and ESLint (`eslint.config.js`, rule `no-restricted-imports`) fails the build if any of them imports a domain pack (`src/packs/**`, `fixtures`, `tools`, `efos-risk-graph`), the experiment loop, or the mock run. `src/stats/` and `src/audit/` are also leaf libraries: ESLint rejects any import from outside their own directory. For the other three directories the "May import" column records current practice; only the domain-pack ban is enforced.

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
| `src/report.ts`, `src/baseline.ts` | Core | `report.ts` judges completeness against the experiment's own cases and configurations, with fixed minimums of two configurations and five repeats. `baseline.ts` holds the older point-estimate comparison; the gate replaced it for decisions |
| `src/config.ts` | Mixed | Configuration ids, per-arm model slots and effort, tool allowlist, and default model roles for this benchmark |
| `src/packs/types.ts`, `src/packs/index.ts`, `src/packs/evidence.ts` | Pack interface | `DomainPack`: tools, case state and its recorded projection, duplicate-mutation rule, evidence-fact projection, system prompt. The registry picks a pack from the dataset version and fails closed for an unknown one |
| `src/packs/fiscal-v2/*` | Domain pack | Serves datasets v1 and v2 by wrapping `fixtures.ts` and `tools.ts`; the state projection, evidence facts, and system prompt were moved here unchanged from `runner.ts` and `experiment.ts` |
| `src/packs/sat-v3/*` | Domain pack | Serves dataset v3: sat-mcp-shaped tools, Spanish fixtures, and the domain router prompt modeled on DISAI_Conta's router |
| `src/contracts.ts` | Mixed | Provider contract is generic. `CaseState`, `FollowUp`, and `PaymentMatch` are fiscal shapes |
| `src/runner.ts` | Core loop | The loop is generic. Case state and its projection come from the pack (default fiscal-v2) |
| `src/scoring.ts` | Mixed | Plan and assertion scoring is generic. Text matching and evidence identifier patterns branch on the case's dataset version (English for v1 and v2, Spanish for v3) instead of coming from the pack, so the gate and report keep scoring from cases alone |
| `src/dataset.ts` | Mixed | Schema is generic; the v3 case schema extends it with `forbiddenValues`, `allowedExtraCalls`, a reference answer, and counterexamples. The loader checks per-version case and category counts (`CASE_COUNTS`: 30 for v1 and v2, 90 for v3) |
| `src/experiment.ts` | Glue | Orchestration and routing are generic. Tools, state, evidence facts, duplicate detection, and the system prompt come from the case's pack |
| `src/gate-command.ts`, `src/mock/*` | Glue | Join the core to this domain pack: they read the tool definitions and the dataset |
| `src/fixtures.ts`, `src/tools.ts` | Domain pack (fiscal-v2) | Fictional documents, payments, supplier statuses, policies, the 8 synthetic tools, and all use of `efos-risk-graph` |
| `src/text-es.ts` | Domain helper | Spanish matching for v3: accent folding, clause-scoped negation, numeric amount parsing. Used by `scoring.ts` and the severity rules |
| `datasets/v1`, `datasets/v2` | Domain pack (fiscal-v2) | Cases, plans, assertions, fault schedules, as committed JSONL |
| `datasets/v3` | Domain pack (sat-v3) | Generated: authored in `src/packs/sat-v3/dataset/*.ts` and written by `pnpm dataset:build:v3`. Edit the TypeScript, never the JSONL |

## Why files were not moved

A physical split of the mixed modules would mean introducing generic state, evidence-projection, and dataset-shape interfaces across `contracts`, `runner`, `scoring`, `dataset`, and `experiment`, and editing most test files. That is a real refactor with risk to the scoring contract, and it would not add evidence about model behaviour. The chosen approach is narrower: keep existing files in place, put all new work behind an enforced boundary, and record the remaining coupling here.

## What a second domain pack needed (done for sat-v3)

The list below was written before the sat-v3 pack existed. Items 2, 3, 4, and 6 are now the `DomainPack` interface. Item 1 is per-version manifest counts in `src/dataset.ts`. Item 5 stays in `src/scoring.ts`, keyed by dataset version, as noted in the module map.

1. A dataset with the same case schema, and a loader without the 30 case and category-count constants.
2. Its own tools and fixtures, registered through the same `ToolDefinition` contract, each declaring `sideEffect`.
3. A generic case state in place of `followUps` and `paymentMatches` (`contracts.ts`, `runner.ts`, `tools.ts`).
4. Evidence-fact projection supplied by the pack instead of `evidenceFactsFor` in `experiment.ts`.
5. Identifier patterns for evidence matching supplied by the pack instead of the regex in `scoring.ts`.
6. A system prompt and operational resources supplied by the pack.

Nothing in `src/stats`, `src/audit`, `src/monitor`, `src/gate`, or `src/providers` would need to change.
