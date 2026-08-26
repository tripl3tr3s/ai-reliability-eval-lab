import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareBaseline, comparePairedBaseline } from "../src/baseline.js";
import { loadDataset } from "../src/dataset.js";
import { buildReport, experimentIsComplete, replayReport, type RunManifest } from "../src/report.js";
import type { ConfigurationSummary, RawRun, RunScore } from "../src/scoring.js";

const metric = (value: number) => ({ value, numerator: value, denominator: 1, ci95: null });
const summary = (configuration: string, value: number): ConfigurationSummary => ({ configuration, runs: 1, completion: metric(value), toolSelection: metric(value), argumentAccuracy: metric(value), headlineToolAccuracy: metric(value), recovery: metric(value), unsupportedClaimRate: metric(0), costPerSuccessfulTask: metric(1), p95LatencyMs: metric(100) });
const manifest: RunManifest = { commitSha: "abc", datasetHash: "hash", configurationHash: "config", promptVersion: "v1", resourceVersion: "v1", models: ["model"], repeatCount: 5, seed: 7, nodeVersion: "22", lockfileVersion: "9", pricingVersion: "v1", pricingEffectiveDate: "2026-08-25", startedAt: "2026-08-25T00:00:00Z", completedAt: "2026-08-25T00:01:00Z", rawResultReferences: ["raw.jsonl"] };

describe("reports and baselines", () => {
  it("shows explicit pending state without a full repeated experiment", async () => {
    const report = buildReport([], (await loadDataset()).cases, manifest);
    expect(report.summary.status).toBe("pending");
    expect(report.markdown).toContain("Status: PENDING");
    expect(report.html).toContain('lang="en"');
    expect(report.html).toContain("results.jsonl");
  });

  it("detects quality and efficiency regressions without promoting", () => {
    const candidate = { ...summary("routed", 0.96), completion: metric(0.96), costPerSuccessfulTask: metric(1.16) };
    const result = compareBaseline([summary("routed", 1)], [candidate]);
    expect(result.accepted).toBe(false);
    expect(result.regressions.map(({ metric: name }) => name)).toEqual(expect.arrayContaining(["completion", "costPerSuccessfulTask"]));
    expect(result.requiresReviewedPromotion).toBe(true);
  });

  it("replays identical raw inputs into byte-identical reports", async () => {
    const dataset = await loadDataset();
    const datasetCase = dataset.cases[0]!;
    const run: RawRun = { runId: "r1", caseId: datasetCase.id, configuration: "direct-sonnet", repeat: 0, outcome: "completed", answer: "1160", finalState: {}, claims: [], toolCalls: [{ name: "get_document", input: { documentId: "INV-001" } }], validEvidenceIds: [], latencyMs: 10, costUsd: 0.01 };
    const root = await mkdtemp(join(tmpdir(), "eval-replay-"));
    const raw = join(root, "raw.jsonl");
    await writeFile(raw, `${JSON.stringify(run)}\n`);
    const first = join(root, "first");
    const second = join(root, "second");
    await replayReport(raw, first, dataset.cases, manifest);
    await replayReport(raw, second, dataset.cases, manifest);
    for (const file of ["summary.json", "results.jsonl", "report.md", "index.html"]) {
      expect(await readFile(join(first, file), "utf8")).toBe(await readFile(join(second, file), "utf8"));
    }
  });

  it("requires unique, successful, policy-clean runs for completeness", async () => {
    const cases = (await loadDataset()).cases;
    const configurations = ["direct-sonnet", "routed", "no-resource-injection"];
    const runs: RawRun[] = configurations.flatMap((configuration) => cases.flatMap((datasetCase) => Array.from({ length: 5 }, (_, repeat) => ({ runId: `${configuration}:${datasetCase.id}:${repeat}`, caseId: datasetCase.id, configuration, repeat, outcome: "completed" as const, answer: "ok", finalState: {}, claims: [], toolCalls: [], validEvidenceIds: [], latencyMs: 1, costUsd: 0 }))));
    expect(experimentIsComplete(runs, cases, configurations, 5)).toBe(true);
    expect(experimentIsComplete(runs.map((run, index) => index === 0 ? { ...run, outcome: "failed" } : run), cases, configurations, 5)).toBe(false);
    expect(experimentIsComplete(runs.map((run, index) => index === 1 ? { ...run, policyViolation: true } : run), cases, configurations, 5)).toBe(false);
    expect(experimentIsComplete(runs.map((run, index) => index === 2 ? { ...run, caseId: runs[1]!.caseId, configuration: runs[1]!.configuration, repeat: runs[1]!.repeat } : run), cases, configurations, 5)).toBe(false);
  });

  it("uses paired case and repeat deltas and rejects missing pairs", () => {
    const score = (caseId: string, completionPassed: boolean): RunScore => ({ runId: caseId, caseId, configuration: "routed", repeat: 0, selectionPassed: completionPassed, argumentFieldsMatched: Number(completionPassed), argumentFieldsTotal: 1, argumentAccuracy: Number(completionPassed), headlineToolAccuracy: completionPassed, completionPassed, recoveryPassed: completionPassed, unsupportedClaims: 0, checkableClaims: 1, unsupportedClaimRate: 0, costUsd: 1, latencyMs: 100 });
    const baseline = Array.from({ length: 10 }, (_, index) => score(`c${index}`, true));
    const candidate = baseline.map((row) => ({ ...row, completionPassed: false, recoveryPassed: false, argumentAccuracy: 0, headlineToolAccuracy: false }));
    const compared = comparePairedBaseline(baseline, candidate, false, 9);
    expect(compared.accepted).toBe(false);
    expect(compared.regressions.map(({ metric: name }) => name)).toEqual(expect.arrayContaining(["completionPassed", "recoveryPassed", "argumentAccuracy", "headlineToolAccuracy"]));
    expect(comparePairedBaseline(baseline, candidate.slice(1)).regressions[0]?.metric).toBe("missing_paired_runs");
  });
});
