# Dataset v3, the sat-v3 pack, and the DISAI_Conta 5.5 arms

| Field | Value |
| --- | --- |
| Date | 2026-10-14 |
| Status | Implemented. No live v3 run exists yet. |
| Supersedes | The configuration plan in [2026-10-03 model lineup](2026-10-03-model-lineup-benchmark-cost-estimates.md) (Option 1) and its Option 2 |
| Related | [Design note](../design-note.md), [architecture](../architecture.md), `config/thresholds.v2.json` |

## Context

An eval audit on 2026-10-13 found three reasons not to spend on another v2 run:

1. The lab benchmarked Sonnet 5 and Haiku 4.5. DISAI_Conta now runs a Haiku 5.5 router at effort `low`, Sonnet 5.5 at `medium` for the standard executor tier, and Opus 5.5 at `high` for the advanced tier (`disai-conta/src/lib/ai/model-router.ts`, `executionerConfig`).
2. Dataset v2 matchers were weak: single generic words ("clear", "review", "risk") satisfied required assertions, a wrong figure looked the same as a missing one (design note ambiguity item 6), and exact-length plan matching failed reasonable extra reads (two `v2-multi-match-11` rows in `runs/smoke-v2-true.jsonl`).
3. Prompts and tools were English and generic; production traffic is Mexican Spanish against sat-mcp tools.

## Decisions

### Arms

| Arm | Router | Standard executor | Advanced executor | Role |
| --- | --- | --- | --- | --- |
| `prod-routed-5-5` | Haiku 5.5, effort `low`, domain router modeled on production `ROUTER_SYSTEM` | Sonnet 5.5, effort `medium` | Opus 5.5, effort `high` (domains `pagos`, `cumplimiento`) | Candidate: what DISAI_Conta runs |
| `direct-sonnet-5-5` | none | Sonnet 5.5, effort `medium` | none | Reference: tests whether the Opus tier and the router earn their cost |

Effort is always set explicitly because the API defaults differ (Haiku 5.5 and Opus 5.5 `medium`, Sonnet 5.5 `high`); leaving them implicit would confound model comparisons.

Each arm names its own model slots. The three legacy arms keep resolving provider roles, so v1 and v2 runs, the pinned request snapshot, and the OpenAI-compatible adapter are unchanged.

The 5.5 arms run under `V3_AGENT_POLICY` (150 000 run tokens, 180 s deadline) because the runner counts input and output of every call, thinking included, while resending the growing history. These are starting values for the smoke run to calibrate.

### No server-side refusal fallback

Anthropic recommends enabling `fallbacks` on Opus 5.5 and Sonnet 5.5. The benchmark deliberately does not: a fallback would silently answer with a different model and the row would be attributed to the model under test. A refusal is normalized with its category and ends the run as an error outcome with usage kept. Production may differ here; if DISAI_Conta enables fallbacks, refusal rates measured here are an upper bound on user-visible refusals.

### Thinking replay

5.5 models require their assistant blocks, thinking included, passed back unchanged with tool results. The Anthropic adapter returns the provider's raw content and replays it verbatim. Legacy pins declare no thinking capability, so their requests are byte-identical to before.

### sat-v3 pack

Seventeen synthetic in-process tools carry the real sat-mcp names and input shapes (PAC credentials, timeouts, and orgId dropped; RFC and UUID validation kept). Writes follow DISAI_Conta semantics: `crear-complemento-pago`, `crear-nota-credito`, and `cancelar-factura` validate business rules and then leave a pending confirmation; `rastrear-pago` commits without an idempotency key, as the real tool does, so a blind retry after a lost response duplicates a payment; `registrar-evidencia-materialidad` is idempotent by file hash. The agent knows the selected client company (name, RFC) and the fixture date from the system prompt, as DISAI_Conta's orchestrator does.

The pack is behind the `DomainPack` interface (`src/packs/types.ts`); the fiscal-v2 pack wraps the original files unchanged.

### Dataset v3

90 es-MX cases: 20 lookup, 24 multi-tool, 18 recovery, 14 abstention, 14 confirmation (new category for HITL writes); 68 percent route to the advanced tier. Cases are authored in TypeScript so identifiers and totals come from the fixtures, and `pnpm dataset:build:v3` writes the JSONL.

Matcher changes:

| Problem in v2 | v3 change |
| --- | --- |
| Lone generic words | Every required alternative contains an amount, an identifier, a dated or numeric phrase, or only multi-word phrases (checked by a test) |
| Wrong figure looks like a missing one | `forbiddenValues`; stating one is the critical error `wrong_value` (severity-rules-v2) |
| Number formats | Amounts parsed numerically from 1160, 1,160.00, 1 160, 1.160,00, and 66 mil; digits inside RFCs, UUIDs, dates, and folios are never amounts |
| English negation | Spanish negation scope (no, sin, nunca, ningun, tampoco, ni, jamas) per clause, accent-insensitive |
| Extra reads fail tool accuracy | `allowedExtraCalls`: declared read tools up to `maxCount`, never writes |
| No check that the scorer works | Each case has a Spanish reference answer that must pass and at least three counterexamples that must fail; all 90 are tested |

### Severity rules v2 and thresholds-v2

`severity-rules-v2` adds `wrong_value` and checks v3 forbidden claims with the Spanish rules. It classifies v1 and v2 cases identically, so the gate keeps accepting thresholds pinned to rules v1 for those datasets and rejects them for v3. `thresholds-v2` pins rules v2 and 90 cases; the critical limit of 3.5 percent lies between the one-sided Clopper-Pearson bounds for zero (3.3) and one (5.2) critical cases in 90.

## Consequences

- `pnpm gate:mock:v3` runs the whole v3 pipeline on the scripted model: PASS on the clean profile, BLOCK on the regressed profile (advanced executor degraded). It is in CI.
- Writing the mock exposed a bug that would have voided a live v3 run: the 5.5 arms' tool allowlist was the v2 tool list, so the runner hid every v3 tool. The allowlist now comes from the case's pack.
- Cost: about 68 percent of v3 cases go to Opus 5.5 in the candidate arm, more than the 40 percent assumed in the first estimate. The smoke run (20 jobs, under 2 USD) measures cost per job before any full run; `full.v3.json` caps spend at 40 USD.
- 90 cases still cannot confirm a 3 point margin unless the arms rarely disagree (minimum detectable paired difference about 9 points at 10 percent discordance). Expect INCONCLUSIVE for small real differences.

## Open issues

- The gate is relative: two arms that both fail every case pass non-inferiority. The scripted mock showed this before the allowlist fix (both arms 0 percent, gate PASS). An absolute floor on completion and recovery would need a reviewed thresholds-v3 change.
- The scorer has been validated only against authored answers (reference and counterexamples). TPR and TNR against labeled live answers are still needed after the first live run.
- Tools are synthetic stand-ins for sat-mcp, not the server itself; behaviour of the real tools (latency, error texts, schema details) can differ.
- Decline cases (asking for a missing folio, refusing to cancel a received CFDI) require at least one tool call in their accepted plans, so an answer that correctly calls nothing fails tool accuracy (completion still passes).
- The runner's repair message for an invalid final result is the English v1/v2 instruction, also on v3.
- Gate and report artifacts for v1 and v2 change shape slightly: the gate reports the code's severity rules version (v2) and a `wrong_value: 0` count, and the report treats any run with at least two arms and five repeats as complete. Decisions on thresholds-v1 are unchanged.

## Code review follow-up (2026-10-14)

A review before the first live run found that the Spanish matcher let negation leak across causal conjunctions ("No puedo ... porque el CFDI esta cancelado"), that decimal commas split clauses, that some forbidden values were legitimate context figures (invoice total, amount already paid), and that negative forbidden claims ("no se pudo consultar") flagged honest recovery narratives. With a 3.5 percent critical limit one false critical error blocks the gate, so all were fixed: clause boundaries include porque, ya que, dado que, puesto que, pues, and sino; punctuation splits only before whitespace; negation must sit within six words of the phrase; amounts are negated only by verbal negation; the currency must follow the amount; forbidden values and claims were pruned to unambiguous wrong conclusions. The reviewer's correct-but-rejected answers are now regression tests.
