# Contributing

Use pnpm and write tests before implementation. Run `pnpm validate`, `pnpm test:coverage`, and `pnpm build` before opening a pull request. Use conventional commit subjects.

Do not modify a published dataset version. Add a new version, update its manifest hash, and explain the correction. Dataset validation must reject malformed, empty, duplicate, or silently unscored cases.

Never commit real taxpayer data, provider credentials, request IDs, or observability secrets. All fixtures must remain fictional.

Live results are candidates, not baselines. Baseline promotion requires a reviewed change containing raw-run references and a comparison report. An approved quality tradeoff must be documented when accepting a cost or latency regression.
