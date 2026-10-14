# ADR: enforce the core boundary for new code without moving existing files

| Field | Value |
| --- | --- |
| Date | 2026-10-10 |
| Status | Accepted. Implemented on `feat/go-live-gate` (`6d37165`), not yet merged. |
| Related | [Architecture](../architecture.md) |

## Context

The goal was a visible separation between a domain-free core and the Mexican fiscal domain pack. In the existing code the two are interleaved: `contracts.ts` and `runner.ts` carry fiscal state shapes, `experiment.ts` projects evidence facts by tool name, `scoring.ts` matches fiscal identifier prefixes, and `dataset.ts` requires exactly 30 cases split 10/10/8/2.

## Decision

1. Existing files stay where they are.
2. New domain-free code lives in `src/stats`, `src/audit`, `src/monitor`, `src/gate`, and `src/providers`.
3. An ESLint `no-restricted-imports` rule fails the build if any of those directories imports `fixtures`, `tools`, `efos-risk-graph`, the experiment loop, or the mock run. `src/stats` and `src/audit` may import nothing from the rest of the project.
4. Code that must join the core to this domain pack sits outside those directories: `src/gate-command.ts` and `src/mock/`.
5. `docs/architecture.md` classifies every module as core, mixed, glue, or domain pack and lists what a second domain pack would need.

## Alternatives considered

- **Move files into `core/` and `domain/`.** Rejected: a real split needs generic state, evidence-projection, and dataset-shape interfaces across five modules and edits to most test files. It risks the scoring contract and adds no evidence about model behaviour.
- **Document the boundary only.** Rejected: an unenforced boundary erodes with the next change.
- **Separate packages in a workspace.** Rejected as premature for a single private package.

## Consequences

- The boundary is real for everything added in this work and only described for the older mixed modules.
- `src/gate` still reads dataset case fields (`forbiddenTools`, `expectedState`, `forbiddenClaims`, `category`). A second domain pack would have to supply the same fields.
- A physical split remains possible later. The architecture document lists the six seams it would touch.
