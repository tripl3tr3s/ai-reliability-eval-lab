# Runbook: full live benchmark run

How to run the full benchmark (`config/full.v2.json`), generate the report, run the gate, review, and promote a baseline. Everything before step 4 is free. Step 4 spends Anthropic Platform credit.

| Field | Value |
| --- | --- |
| Scope | 30 cases x 3 configurations x 5 repeats = 450 jobs |
| Hard ceiling | USD 25 (`budgetUsd` in the config; `MAX_EXPERIMENT_COST_USD` can only lower it) |
| Planned estimate | USD 18.00 (450 x 0.04, the preflight figure) |
| Earlier measurement | The partial run on 2026-09-01 spent USD 4.57 on 282 jobs (about USD 0.016 per job), which extrapolates to about USD 7.30 for 450. See `docs/postmortems/2026-09-01-full-benchmark-deadline-abort.md` |
| Models | `claude-sonnet-5`, `claude-haiku-4-5-20251001` (pinned in `src/adapter.ts`) |

## 1. Before spending anything

1. Be on the commit you intend to publish, with a clean tree: `git status`.
2. Confirm the deadline fix is included: `git merge-base --is-ancestor eae03bc HEAD && echo ok`. Runs on older commits can lose the whole run to one slow request (see `docs/postmortems/2026-09-01-full-benchmark-deadline-abort.md`).
3. Run the free checks. All must pass:

   ```sh
   corepack enable
   pnpm install --frozen-lockfile
   pnpm lint && pnpm validate && pnpm test:coverage && pnpm build
   pnpm gate:mock
   ```

4. Check the Platform credit balance at platform.claude.com, Billing. It must cover the ceiling you set. If the balance is below USD 25, lower the ceiling to the balance so the run stops on the cap instead of on a credit error:

   ```sh
   export MAX_EXPERIMENT_COST_USD=12
   ```

   The preflight refuses to start if 450 x 0.04 = 18 exceeds the ceiling, so a ceiling under 18 needs a lower `estimatedCostPerRunUsd` in a copy of the config. Do not edit `config/full.v2.json` for this.
5. Confirm the pricing file still matches the Anthropic pricing page: `config/pricing.v1.json` against https://platform.claude.com/docs/en/about-claude/pricing. If prices changed, add a new pricing version; do not edit v1.
6. Confirm `MODEL_PROVIDER` is unset or `anthropic`: `echo "${MODEL_PROVIDER:-anthropic}"`.
7. Decide whether a scheduled run is already pending. `full-benchmark.yml` also runs monthly and on tags, behind the `full-benchmark` environment approval. Reject any queued run that predates the commit you want.

## 2. Smoke run first (ceiling USD 2)

```sh
node --env-file=.env.local --import tsx src/cli.ts run --interactive
```

Choose Smoke v2. Guided mode shows the spend preflight, creates fresh output paths, and refuses to reuse an existing file.

Check the smoke output before going further:

- 24 rows, 8 per configuration.
- No `failed` rows. Any `bounded` row needs an explanation (read its `answer` field).
- `modelIds` contains only the two pinned ids.
- Observed spend is in line with the 2026-09-01 smoke (USD 0.35 for 24 jobs, about USD 0.015 per job). If it is several times higher, stop.

The gate on a smoke run must say INCONCLUSIVE (4 cases is below the minimum). That is expected.

## 3. Choose fresh output paths

The non-interactive `run` command appends to its output file. Never point it at an existing file: the result would contain duplicate rows and the gate would block on `candidate_runs_unique`.

```sh
export RUN_ID="full-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "runs/$RUN_ID"
test ! -e "runs/$RUN_ID/results.jsonl" && echo "path is free"
```

## 4. Full run (spends credit)

```sh
node --env-file=.env.local --import tsx src/cli.ts run \
  --config config/full.v2.json \
  --output "runs/$RUN_ID/results.jsonl" \
  --events "runs/$RUN_ID/events.jsonl"
```

- Expect roughly 70 minutes: the 2026-09-01 partial run completed 282 jobs in about 44 minutes.
- Progress, spend, and ETA go to stderr. The run stops by itself if observed spend passes the ceiling.
- Ctrl+C once cancels cleanly and keeps completed rows. A cancelled or failed run is not resumable: start again with a new `RUN_ID`. Do not merge partial files by hand.

To run in GitHub Actions instead, dispatch the `Full benchmark` workflow and approve the `full-benchmark` environment. It uses the same ceiling and uploads `runs/` and `reports/generated/` as an artifact.

## 5. Report

```sh
pnpm report --raw "runs/$RUN_ID/results.jsonl" --events "runs/$RUN_ID/events.jsonl" \
  --config config/full.v2.json --output "reports/generated/$RUN_ID"
```

Running it twice must give identical files. `--events` supplies the run timestamps; without it they read `unknown`.

## 6. Gate

```sh
pnpm gate --raw "runs/$RUN_ID/results.jsonl" --config config/full.v2.json \
  --candidate routed --reference direct-sonnet \
  --output "reports/generated/$RUN_ID/gate" --audit-log runs/audit.jsonl
echo "exit code: $?"
```

| Exit | Decision | What to do |
| --- | --- | --- |
| 0 | PASS | Go to review. Read the warnings in `gate.md` |
| 1 | BLOCK | Do not promote. Read the reasons; open the affected cases in the raw file |
| 2 | INCONCLUSIVE | Do not promote on this evidence. More repeats will not help; the fix is more cases |

Repeat with `--candidate no-resource-injection --reference routed` to quantify what resource injection buys. Record the head hash printed by `pnpm audit:verify --log runs/audit.jsonl` somewhere outside the log.

With 30 cases, expect INCONCLUSIVE whenever the two configurations differ on one to three cases. That is the honest answer at this sample size (see `docs/design-note.md`, section 5).

## 7. Review before anything is published

Statistical review:

- [ ] `summary.json` status. It is `complete` only if all 450 rows exist and none is `failed` or `bounded`. If it is `pending`, the Pages workflow will refuse to publish; do not work around that.
- [ ] Read "What this run can and cannot detect" in `report.md` and make sure every claim you intend to make fits inside it.
- [ ] Quote case-clustered intervals only. The row-level intervals in "Detailed metrics" are too narrow.
- [ ] For every critical error the gate lists, read the run. Confirm the severity rule fired for the right reason.
- [ ] Spot-check at least five failing and five passing runs against the scorer: text matching can accept a wrong answer that contains the required phrase, or reject a correct paraphrase.
- [ ] Do not report per-category results for recovery (8 cases) or abstention (2 cases) as findings.

Artifact review:

- [ ] `modelIds` across the file: only the pinned ids. No `mock-` id anywhere.
- [ ] No secrets in anything you will publish: `rg -n -i "sk-ant|api[_-]?key|authorization|bearer " "runs/$RUN_ID" "reports/generated/$RUN_ID"` must print nothing.
- [ ] `events.jsonl` stays local. Only `reports/generated/` content is published.
- [ ] Total cost in the report matches the Platform usage page for the run window, within rounding.
- [ ] Commit sha, dataset hash, and pricing version in `summary.json` are the ones you expect.

## 8. Promote a baseline

Promotion is a reviewed repository change. Nothing promotes automatically.

1. Create a branch.
2. Copy the raw file and gate output into a tracked location, for example `baselines/<date>-<short-sha>/results.jsonl`, `gate.json`, `gate.md`, and `summary.json`. Do not copy `events.jsonl`.
3. Record in the pull request: the `RUN_ID`, commit sha, dataset hash, thresholds version, gate decision, the audit head hash, and any accepted tradeoff (CONTRIBUTING requires a documented tradeoff for a cost or latency regression).
4. From then on, gate a new run against it:

   ```sh
   pnpm gate --raw "runs/$NEW_RUN/results.jsonl" --baseline baselines/<date>-<short-sha>/results.jsonl --candidate routed
   ```

5. Update `README.md` and `CHANGELOG.md` only with values copied from the generated report. Until this step is done, both must keep saying that results are pending.
6. If the run calls for different thresholds, change `config/thresholds.v1.json` to a new version in a separate reviewed change, with a new date and rationale. Never adjust a threshold in the same change that it would allow to pass.

## 9. Publish (optional)

Dispatch `Publish reviewed report` with the run id and artifact name of the reviewed `Full benchmark` workflow run. It publishes only a `complete` report. A locally generated report is not published by this workflow.

## If something goes wrong

| Symptom | Action |
| --- | --- |
| Preflight says the estimate exceeds the ceiling | The ceiling is below USD 18. Raise it if the balance allows, otherwise do not run |
| Run stops with "Observed spend exceeds ceiling" | Completed rows are kept but the run is incomplete. Investigate cost per job before trying again |
| Credit exhausted mid-run | Same as above. Lower `MAX_EXPERIMENT_COST_USD` to the balance next time |
| Many `bounded` rows | Read their `answer` field. "Deadline exceeded" points at provider latency; "Token ceiling exceeded" points at the 12 000 token run limit |
| Gate blocks on a deterministic check | The evidence is unusable. Fix the cause and rerun; do not edit the raw file |
