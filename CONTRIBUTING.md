# Contributing

Use pnpm and write tests before implementation. Run `pnpm validate`, `pnpm test:coverage`, and `pnpm build` before opening a pull request. Use conventional commit subjects.

Do not modify a published dataset version. Add a new version, update its manifest hash, and explain the correction. Dataset validation must reject malformed, empty, duplicate, or silently unscored cases.

Dataset v2 cases must express required outcomes as structured semantic assertions. Use alternative assertion groups for legitimate paraphrases instead of depending on one exact model phrase. Every valid tool strategy must be an explicit accepted plan with plan-specific ordering and per-call argument matchers.

Keep tool acceptance narrow. A policy read is valid only when the prompt requests that policy or when it is part of an accepted plan immediately before the related simulated write. A policy-first plan may be declared when the policy directly governs that write. Reject irrelevant reads, undeclared extra calls, and every extra write. Preserve null and empty tool results as negative evidence so abstention can be scored from what the tools actually established.

Never commit real taxpayer data, provider credentials, request IDs, or observability secrets. All fixtures must remain fictional.

Live results are candidates, not baselines. Baseline promotion requires a reviewed change containing raw-run references and a comparison report. An approved quality tradeoff must be documented when accepting a cost or latency regression.

Gate thresholds live in `config/thresholds.v1.json`. Changing a value means a new `version`, a new `date`, and an updated `rationale`, in a reviewed change of its own. Never change a threshold in the same change that it would allow to pass. A change to the severity rules in `src/gate/severity.ts` needs a new `SEVERITY_RULES_VERSION` and a matching thresholds update. Regenerate `config/thresholds.schema.json` when the schema in `src/gate/thresholds.ts` changes; a test fails if they drift.

Code in `src/stats`, `src/audit`, `src/monitor`, `src/gate`, and `src/providers` must stay independent of the fiscal domain pack. ESLint enforces this; see `docs/architecture.md`. Statistical functions need reference values computed independently of the implementation (see `tests/stats/reference`).

A new provider adapter must pass the shared contract tests in `tests/providers/contract.test.ts` by adding one harness, using mocked transport only.
