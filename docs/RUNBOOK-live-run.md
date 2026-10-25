# Runbook: full live benchmark run

How to run a full benchmark, generate the report, run the gate, review, and promote a baseline. Everything before step 4 is free. Steps 2 and 4 spend Anthropic Platform credit.

Dataset v3 is the target benchmark (the DISAI_Conta 5.5 lineup). v2 is kept for comparison. The steps are the same for both; only the values in this table differ. Set the two variables once and every command below uses them:

```sh
export DATASET=v3                       # or v2
export CONFIG="config/full.$DATASET.json"
```

| Field | v3 (target) | v2 |
| --- | --- | --- |
| Smoke config | `config/smoke.v3.json`: 5 cases (one per category) x 2 configurations x 2 repeats = 20 jobs, USD 2 ceiling | `config/smoke.v2.json`: 4 cases x 3 configurations x 2 repeats = 24 jobs, USD 2 ceiling |
| Full scope | 90 cases x 2 configurations x 5 repeats = 900 jobs | 30 cases x 3 configurations x 5 repeats = 450 jobs |
| Hard ceiling (`budgetUsd`) | USD 40 | USD 25 |
| Preflight estimate | USD 36 (900 x 0.04). Likely low: about 68 percent of candidate-arm cases run on Opus 5.5, and the smoke config already assumes 0.05 per job. Replace it with the smoke run's measured cost per job (step 2) | USD 18 (450 x 0.04) |
| Earlier measurement | None | Partial run on 2026-09-01: USD 4.57 for 282 jobs (about 0.016 per job), about USD 7.30 extrapolated to 450. See the [post-mortem](postmortems/2026-09-01-full-benchmark-deadline-abort.md) |
| Arms | `prod-routed-5-5` (candidate), `direct-sonnet-5-5` (reference) | `routed` (candidate), `direct-sonnet` (reference), `no-resource-injection` (ablation) |
| Models (pinned in `src/adapter.ts`) | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` | `claude-sonnet-5`, `claude-haiku-4-5-20251001` |
| Pricing file | `config/pricing.v2.json` | `config/pricing.v1.json` |
| Thresholds (picked by the gate from the config) | `config/thresholds.v3.json` (Bonett-Price on the all-pass outcome; `thresholds.v2.json` replays earlier decisions) | `config/thresholds.v1.json` |
| Run limits | `V3_AGENT_POLICY` in `src/config.ts`: 150 000 tokens and 180 s per run, uncalibrated | 12 000 tokens and 120 s per run |

`budgetUsd` is the hard ceiling. `MAX_EXPERIMENT_COST_USD` can only lower it, never raise it. The preflight refuses to start when jobs x `estimatedCostPerRunUsd` exceeds the ceiling.

## 1. Before spending anything

1. Be on the commit you intend to publish, with a clean tree: `git status`.
2. Confirm the deadline fix is included: `git merge-base --is-ancestor eae03bc HEAD && echo ok`. Runs on older commits can lose the whole run to one slow request (see `docs/postmortems/2026-09-01-full-benchmark-deadline-abort.md`).
3. Run the free checks. All must pass:

   ```sh
   corepack enable
   pnpm install --frozen-lockfile
   pnpm lint && pnpm validate && pnpm test:coverage && pnpm build
   pnpm gate:mock && pnpm gate:mock:v3
   ```

4. Check the Platform credit balance at platform.claude.com, Billing. It must cover the ceiling. If the balance is below the hard ceiling in the table, lower the ceiling to the balance so the run stops on the cap instead of on a credit error:

   ```sh
   export MAX_EXPERIMENT_COST_USD=12
   ```

   The preflight compares the estimate (table above) with this ceiling, so a ceiling below the estimate needs a lower `estimatedCostPerRunUsd` in a copy of the config, ideally the cost per job measured in step 2. Never edit the committed `config/full.*.json` for this: its hash is recorded in the results.
5. Confirm the pricing file in the table still matches the [Anthropic pricing page](https://platform.claude.com/docs/en/about-claude/pricing). If prices changed, add a new pricing version; never edit an existing one.
6. Confirm `MODEL_PROVIDER` is unset or `anthropic`: `echo "${MODEL_PROVIDER:-anthropic}"`.
7. Decide whether a scheduled run is already pending. `full-benchmark.yml` also runs monthly and on tags, on the default dataset (v3, USD 40 ceiling), behind the `full-benchmark` environment approval. Reject any queued run that predates the commit you want.

## 2. Smoke run first (ceiling USD 2)

```sh
node --env-file=.env.local --import tsx src/cli.ts run --interactive
```

Guided mode preselects Smoke v3; choose Smoke v2 for the previous benchmark. It shows the spend preflight, creates fresh output paths, and refuses to reuse an existing file.

Check the smoke output before going further:

- The row count matches the smoke scope in the table (20 for v3, 24 for v2), split evenly across configurations.
- No `failed` rows. Any `bounded` row needs an explanation (read its `answer` field).
- `modelIds` contains only the pinned ids in the table.
- Cost per job: divide observed spend by the row count. For v2, compare with the 2026-09-01 smoke (USD 0.35 for 24 jobs, about 0.015 per job) and stop if it is several times higher. For v3 there is no earlier figure; multiply by 900 and confirm the result fits under the USD 40 ceiling with margin.

For v3, also read every trace by hand. The smoke run is the only calibration the 5.5 arms get before a full run:

- Refusals: any refusal row, with its category.
- Bounded runs: whether `V3_AGENT_POLICY` (150 000 tokens, 180 s) is too tight or too loose. Change it in a reviewed commit before the full run, not after.
- Router domains: the domain the Haiku router picked for each candidate-arm case, and whether `pagos` and `cumplimiento` cases reached Opus.

The gate on a smoke run must say INCONCLUSIVE, because the smoke cases are below the minimum. That is expected.

## 3. Choose fresh output paths

The non-interactive `run` command appends to its output and events files. Never point it at an existing file: the result would contain duplicate rows and the gate would block on `candidate_runs_unique`.

```sh
export RUN_ID="full-$DATASET-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "runs/$RUN_ID"
test ! -e "runs/$RUN_ID/results.jsonl" && echo "path is free"
```

## 4. Full run (spends credit)

```sh
node --env-file=.env.local --import tsx src/cli.ts run \
  --config "$CONFIG" \
  --output "runs/$RUN_ID/results.jsonl" \
  --events "runs/$RUN_ID/events.jsonl"
```

- Duration: v2 takes roughly 70 minutes (the 2026-09-01 partial run completed 282 jobs in about 44 minutes). v3 has twice the jobs and slower thinking models; estimate it from the smoke run's time per job. The GitHub workflow allows 6 hours for v3.
- Progress, spend, and ETA go to stderr. The run stops by itself if observed spend passes the ceiling.
- Ctrl+C once cancels cleanly and keeps completed rows. A cancelled or failed run is not resumable: start again with a new `RUN_ID`. Do not merge partial files by hand.

To run in GitHub Actions instead, dispatch the `Full benchmark` workflow, choose the dataset in the form (it defaults to v3), and approve the `full-benchmark` environment. It uses the same ceiling and uploads `runs/` and `reports/generated/` as an artifact, also when the run fails.

## 5. Report

```sh
pnpm report --raw "runs/$RUN_ID/results.jsonl" --events "runs/$RUN_ID/events.jsonl" \
  --config "$CONFIG" --output "reports/generated/$RUN_ID"
```

Running it twice must give identical files. `--events` supplies the run timestamps; without it they read `unknown`.

## 6. Gate

```sh
pnpm gate --raw "runs/$RUN_ID/results.jsonl" --config "$CONFIG" \
  --output "reports/generated/$RUN_ID/gate" --audit-log runs/audit.jsonl
echo "exit code: $?"
```

| Exit | Decision | What to do |
| --- | --- | --- |
| 0 | PASS | Go to review. Read the warnings in `gate.md` |
| 1 | BLOCK | Do not promote. Read the reasons; open the affected cases in the raw file |
| 2 | INCONCLUSIVE | Do not promote on this evidence. More repeats will not help; the fix is more cases |

Without `--candidate` and `--reference`, the gate compares the default arms for the dataset (table above). For v2, also run it with `--candidate no-resource-injection --reference routed` to quantify what resource injection buys. Record the head hash printed by `pnpm audit:verify --log runs/audit.jsonl` somewhere outside the log.

Expect INCONCLUSIVE whenever the two configurations differ on only a few cases: one to three at 30 cases (v2), and differences smaller than about 9 to 13 points at 90 cases (v3), depending on how often the arms disagree. That is the honest answer at these sample sizes (see the [design note](design-note.md), sections 5 and 6a).

## 7. Review before anything is published

Statistical review:

- [ ] `summary.json` status. It is `complete` only if every row of the full scope (900 for v3, 450 for v2) exists and none is `failed` or `bounded`. If it is `pending`, the Pages workflow will refuse to publish; do not work around that.
- [ ] Read "What this run can and cannot detect" in `report.md` and make sure every claim you intend to make fits inside it.
- [ ] Quote case-clustered intervals only. The row-level intervals in "Detailed metrics" are too narrow.
- [ ] For every critical error the gate lists, read the run. Confirm the severity rule fired for the right reason.
- [ ] Spot-check at least five failing and five passing runs against the scorer: text matching can accept a wrong answer that contains the required phrase, or reject a correct paraphrase.
- [ ] Do not report per-category results as findings when the category is small: in v2, recovery (8 cases) and abstention (2); in v3, every category has 14 to 24 cases, so per-category intervals are wide too.
- [ ] For v3, the scorer has only been validated against authored answers. Label a sample of live answers by hand and record its agreement with the scorer (true and false positive rates) before quoting completion figures.

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
   pnpm gate --raw "runs/$NEW_RUN/results.jsonl" --config "$CONFIG" \
     --baseline baselines/<date>-<short-sha>/results.jsonl --candidate prod-routed-5-5   # routed for v2
   ```

5. Update `README.md` and `CHANGELOG.md` only with values copied from the generated report. Until this step is done, both must keep saying that results are pending.
6. If the run calls for different thresholds, write a new thresholds version (for example `config/thresholds.v3.json`) instead of editing the one in use, in a separate reviewed change, with a new date and rationale. Never adjust a threshold in the same change that it would allow to pass.

## 9. Publish (optional)

Dispatch `Publish reviewed report` with the run id and artifact name of the reviewed `Full benchmark` workflow run. It publishes only a `complete` report. A locally generated report is not published by this workflow.

## If something goes wrong

| Symptom | Action |
| --- | --- |
| Preflight says the estimate exceeds the ceiling | `MAX_EXPERIMENT_COST_USD` is below the estimate in the table. Raise it if the balance allows (never above `budgetUsd`), otherwise do not run |
| Run stops with "Observed spend exceeds ceiling" | Completed rows are kept but the run is incomplete. Investigate cost per job before trying again |
| Credit exhausted mid-run | Same as above. Lower `MAX_EXPERIMENT_COST_USD` to the balance next time |
| Many `bounded` rows | Read their `answer` field. "Deadline exceeded" points at provider latency; "Token ceiling exceeded" points at the run token limit (12 000 for v2, 150 000 for v3) |
| Rows end with a refusal (v3) | Read the refusal category. No fallback model is enabled by design; do not enable one to make the run pass |
| Gate blocks on a deterministic check | The evidence is unusable. Fix the cause and rerun; do not edit the raw file |
