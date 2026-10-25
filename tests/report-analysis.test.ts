import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDataset } from "../src/dataset.js";
import { buildReport, type RunManifest } from "../src/report.js";
import { computeRunAnalysis, NOT_RECORDED, SENSITIVITY_RULE } from "../src/report-analysis.js";
import { analysisSections, headlineTable } from "../src/report-analysis-sections.js";
import { checkReportFile, checkReportStatistics } from "../src/report-check.js";
import { scoreRun, type RawRun } from "../src/scoring.js";
import {
  bonettPriceClusterInterval,
  bonettPriceInterval,
  mcnemarMidP,
  shafferAdjust,
  sidakConfidence,
  STATS_METHODS_VERSION,
  tInterval,
  wilsonInterval,
  wilsonOnCaseRates,
} from "../src/stats/index.js";
import { syntheticGrid } from "./helpers/synthetic.js";

const dataset = await loadDataset("datasets/v2/manifest.json");
const byId = new Map(dataset.cases.map((item) => [item.id, item]));
const scoreAll = (runs: readonly RawRun[]) => runs.map((run) => scoreRun(run, byId.get(run.caseId)!));
const analyse = (runs: readonly RawRun[]) => computeRunAnalysis(scoreAll(runs), runs);
const manifest: RunManifest = { commitSha: "abc", datasetHash: "hash", configurationHash: "config", promptVersion: "v2", resourceVersion: "v2", models: ["synthetic-model"], repeatCount: 5, seed: 7, nodeVersion: "22", lockfileVersion: "9", pricingVersion: "v1", pricingEffectiveDate: "2026-08-25", startedAt: "2026-08-25T00:00:00Z", completedAt: "2026-08-25T00:01:00Z", rawResultReferences: ["raw.jsonl"] };

describe("primary analysis on three arms (v2 shape)", () => {
  // Routed fails every repeat of the first 6 cases; no-resource-injection fails repeat 0 of the first 10 cases.
  const runs = syntheticGrid(dataset.cases, ({ caseIndex, configuration, repeat }) =>
    configuration === "routed" ? caseIndex >= 6 : configuration === "no-resource-injection" ? !(caseIndex < 10 && repeat === 0) : true);
  const analysis = analyse(runs);
  const confidence = sidakConfidence(0.95, 3);
  const completion = analysis.primary.comparisons.filter(({ metric }) => metric === "completion");
  const find = (first: string, second: string) => completion.find((item) => item.first === first && item.second === second)!;

  it("uses Sidak intervals for three comparisons per metric", () => {
    expect(analysis.primary).toMatchObject({ estimand: "all-pass", familyConfidence: 0.95, comparisonsPerMetric: 3 });
    expect(analysis.primary.comparisonConfidence).toBeCloseTo(0.95 ** (1 / 3), 14);
    expect(analysis.primary.comparisons).toHaveLength(9);
  });

  it("computes Bonett-Price and mid-p on the every-repeat outcome", () => {
    const routed = find("direct-sonnet", "routed");
    expect(routed.cases).toBe(30);
    expect(routed.counts).toEqual({ firstOnly: 6, secondOnly: 0, bothPassed: 24, bothFailed: 0 });
    expect(routed.difference).toBeCloseTo(0.2, 14);
    const expected = bonettPriceInterval(routed.counts, confidence);
    expect(routed.interval).toEqual({ low: expected.low, high: expected.high });
    expect(routed.midP).toBe(mcnemarMidP(routed.counts));
    // One failing repeat is enough to fail a case under the primary rule.
    expect(find("direct-sonnet", "no-resource-injection").counts).toMatchObject({ firstOnly: 10, secondOnly: 0 });
  });

  it("Shaffer-adjusts the mid-p values within a metric", () => {
    const adjusted = shafferAdjust(completion.map(({ midP }) => midP!), 3);
    expect(completion.map(({ adjustedP }) => adjustedP)).toEqual(adjusted);
    expect(completion.every(({ adjustedP, midP }) => adjustedP! >= midP!)).toBe(true);
  });

  it("names a better arm only when the interval excludes zero, and derives rank bands from verdicts", () => {
    for (const item of completion) {
      const excludes = item.interval!.low > 0 || item.interval!.high < 0;
      expect(item.verdict === "indistinguishable").toBe(!excludes);
    }
    // Fixed by hand: 10 one-sided discordant cases clear the 98.3% Sidak level at 30 cases, 6 do not, and
    // routed against no-resource-injection is 0 / 4 (cases 6 to 9 fail only in no-resource-injection).
    expect(find("direct-sonnet", "no-resource-injection").verdict).toBe("first_better");
    expect(find("direct-sonnet", "routed").verdict).toBe("indistinguishable");
    expect(find("no-resource-injection", "routed").counts).toMatchObject({ firstOnly: 0, secondOnly: 4, bothFailed: 6 });
    expect(find("no-resource-injection", "routed").verdict).toBe("indistinguishable");
    const band = (configuration: string) => analysis.primary.arms.find((arm) => arm.configuration === configuration && arm.metric === "completion")!.rankBand;
    expect(band("direct-sonnet")).toEqual({ best: 1, worst: 2 });
    expect(band("routed")).toEqual({ best: 1, worst: 3 });
    expect(band("no-resource-injection")).toEqual({ best: 2, worst: 3 });
    // Recovery: every arm passes every recovery case, so no arm can be ranked.
    expect(analysis.primary.arms.filter(({ metric }) => metric === "recovery").map(({ rankBand }) => rankBand)).toEqual([{ best: 1, worst: 3 }, { best: 1, worst: 3 }, { best: 1, worst: 3 }]);
  });

  it("reports the share per arm with Wilson at 95%", () => {
    const arm = analysis.primary.arms.find(({ configuration, metric }) => configuration === "routed" && metric === "completion")!;
    expect(arm).toMatchObject({ cases: 30, casesAllPassed: 24, share: 0.8 });
    expect(arm.wilson95).toEqual(wilsonInterval(24, 30, 0.95));
  });

  it("reports the per-case rate as secondary with the case-clustered interval", () => {
    const item = analysis.secondary.comparisons.find(({ metric, first, second }) => metric === "completion" && first === "direct-sonnet" && second === "no-resource-injection")!;
    const differences = Array.from({ length: 30 }, (_, index) => (index < 10 ? 0.2 : 0));
    const expected = bonettPriceClusterInterval(differences, confidence);
    expect(item.difference).toBeCloseTo(10 * 0.2 / 30, 14);
    // The arm sums its differences in case order, so the last bits can differ from this literal array.
    expect(item.interval!.low).toBeCloseTo(expected.low, 14);
    expect(item.interval!.high).toBeCloseTo(expected.high, 14);
    expect(item.pValue).toBeGreaterThan(0);
    const arm = analysis.secondary.arms.find(({ configuration, metric }) => configuration === "no-resource-injection" && metric === "completion")!;
    expect(arm.meanCaseRate).toBeCloseTo((20 + 10 * 0.8) / 30, 14);
    expect(arm.wilsonOnCaseRates95).toEqual(wilsonOnCaseRates([...Array(10).fill(0.8), ...Array(20).fill(1)].sort(), 0.95));
  });

  it("reports stability with unbiased pass^k and an ICC only where outcomes vary", () => {
    const flaky = analysis.stability.arms.find(({ configuration, metric }) => configuration === "no-resource-injection" && metric === "completion")!;
    expect(analysis.stability.validated).toBe(false);
    expect(flaky).toMatchObject({ cases: 30, mixedCases: 10, k: 5 });
    expect(flaky.passPowerK).toBeCloseTo(20 / 30, 14);
    expect(flaky.passAtK).toBe(1);
    expect(flaky.icc).not.toBeNull();
    const steady = analysis.stability.arms.find(({ configuration, metric }) => configuration === "direct-sonnet" && metric === "completion")!;
    expect(steady.icc).toBeNull();
    // Routed's failures are whole cases, so repeats agree perfectly.
    expect(analysis.stability.arms.find(({ configuration, metric }) => configuration === "routed" && metric === "completion")!.icc!.icc).toBeCloseTo(1, 12);
  });
});

describe("outcomes, sensitivity and missing pairs", () => {
  const two = ["prod-routed-5-5", "direct-sonnet-5-5"] as const;
  const grid = syntheticGrid(dataset.cases, () => true, 5, two);
  // Case 0 of the candidate hits the deadline twice; case 1 of the reference fails once on an old row without a reason.
  const runs = grid.map((run): RawRun => {
    if (run.configuration === two[0] && run.caseId === dataset.cases[0]!.id && run.repeat < 2) return { ...run, outcome: "bounded", terminationReason: "deadline" };
    if (run.configuration === two[1] && run.caseId === dataset.cases[1]!.id && run.repeat === 0) return { ...run, outcome: "failed" };
    return run;
  });
  const analysis = analyse(runs);

  it("counts outcomes and termination reasons per arm", () => {
    const candidate = analysis.outcomes.find(({ configuration }) => configuration === two[0])!;
    expect(candidate.runs).toBe(150);
    expect(candidate.byOutcome.bounded).toBe(2);
    expect(candidate.byTerminationReason).toEqual({ deadline: 2 });
    const reference = analysis.outcomes.find(({ configuration }) => configuration === two[1])!;
    expect(reference.byOutcome.failed).toBe(1);
    expect(reference.byTerminationReason).toEqual({ [NOT_RECORDED]: 1 });
  });

  it("repeats the primary analysis without cases that stopped early", () => {
    expect(analysis.sensitivity.rule).toBe(SENSITIVITY_RULE);
    expect(analysis.sensitivity.droppedCaseIds).toEqual([dataset.cases[0]!.id, dataset.cases[1]!.id].sort());
    expect(analysis.sensitivity.casesKept).toBe(28);
    expect(analysis.primary.comparisons.every(({ unequalRepeats }) => unequalRepeats === 0)).toBe(true);
    const kept = analysis.sensitivity.comparisons.find(({ metric }) => metric === "completion")!;
    expect(kept.cases).toBe(28);
    expect(kept.counts).toMatchObject({ firstOnly: 0, secondOnly: 0, bothPassed: 28 });
    const primary = analysis.primary.comparisons.find(({ metric }) => metric === "completion")!;
    expect(primary.counts).toMatchObject({ firstOnly: 1, secondOnly: 1, bothPassed: 28 });
  });

  it("keeps a wrong answer that completed, so the sensitivity analysis only removes early stops", () => {
    const wrong = runs.map((run) => (run.configuration === two[0] && run.caseId === dataset.cases[5]!.id ? { ...run, answer: "No result." } : run));
    const kept = analyse(wrong).sensitivity.comparisons.find(({ metric }) => metric === "completion")!;
    expect(kept.cases).toBe(28);
    // prod-routed-5-5 sorts after direct-sonnet-5-5, so it is the second arm.
    expect(kept.counts).toMatchObject({ firstOnly: 1, secondOnly: 0, bothPassed: 27 });
  });

  it("uses no correction with two arms and compares only cases present in both", () => {
    expect(analysis.primary).toMatchObject({ comparisonsPerMetric: 1, comparisonConfidence: 0.95 });
    const partial = runs.filter((run) => !(run.configuration === two[1] && run.caseId === dataset.cases[29]!.id));
    const comparison = analyse(partial).primary.comparisons.find(({ metric }) => metric === "completion")!;
    expect(comparison.cases).toBe(29);
    expect(comparison.counts).toMatchObject({ firstOnly: 1, secondOnly: 1, bothPassed: 27 });
    expect(comparison.adjustedP).toBe(comparison.midP);
  });

  it("weights every case equally in the per-case rate when repeats are unbalanced", () => {
    // Drop four repeats of every other case in one arm: the pooled rate and the case mean now differ.
    const unbalanced = runs.filter((run) => !(run.configuration === two[1] && dataset.cases.findIndex(({ id }) => id === run.caseId) % 2 === 1 && run.repeat > 0));
    const result = analyse(unbalanced);
    expect(result.primary.comparisons.find(({ metric }) => metric === "completion")!.unequalRepeats).toBe(15);
    const stability = result.stability.arms.find(({ configuration, metric }) => configuration === two[1] && metric === "completion")!;
    expect(stability.k).toBe(1);
    const arm = result.secondary.arms.find(({ configuration, metric }) => configuration === two[1] && metric === "completion")!;
    // Case 1 keeps only its failed repeat 0 (0/1); every other case passes all its runs.
    expect(arm.meanCaseRate).toBeCloseTo(29 / 30, 14);
  });
});

describe("cost and latency per case", () => {
  const two = ["cheap", "dear"] as const;
  // "dear" fails every repeat of the first 12 cases and costs about twice as much on every case.
  const base = syntheticGrid(dataset.cases, ({ caseIndex, configuration }) => configuration === "cheap" || caseIndex >= 12, 5, two);
  const caseIndex = (run: RawRun): number => dataset.cases.findIndex(({ id }) => id === run.caseId);
  const runs = base.map((run): RawRun => {
    const jitter = 1 + 0.01 * (caseIndex(run) % 7);
    return { ...run, costUsd: run.configuration === "cheap" ? 0.01 * jitter : 0.02 * jitter * (1 + 0.003 * (caseIndex(run) % 5)), latencyMs: run.configuration === "cheap" ? 1_000 : 1_500 + caseIndex(run) };
  });
  const analysis = analyse(runs);

  it("averages per case over every run and compares by the geometric mean ratio", () => {
    const comparison = analysis.efficiency.comparisons[0]!;
    expect(comparison).toMatchObject({ first: "cheap", second: "dear", cases: 30 });
    const logs = dataset.cases.map((_, index) => Math.log(1 / (2 * (1 + 0.003 * (index % 5)))));
    const expected = tInterval(logs, 0.95)!;
    expect(comparison.cost!.ratio).toBeCloseTo(Math.exp(expected.estimate), 12);
    expect(comparison.cost!.low).toBeCloseTo(Math.exp(expected.low), 12);
    expect(comparison.cost!.high).toBeLessThan(1);
    expect(comparison.latency!.ratio).toBeLessThan(1);
    const cheap = analysis.efficiency.arms.find(({ configuration }) => configuration === "cheap")!;
    expect(cheap.meanLatencyMsPerCase).toBe(1_000);
  });

  it("labels the arm that is worse and dearer as dominated", () => {
    const primary = analysis.primary.comparisons.find(({ metric }) => metric === "completion")!;
    expect(primary.verdict).toBe("first_better");
    expect(analysis.efficiency.arms.map(({ configuration, pareto }) => [configuration, pareto])).toEqual([["cheap", "frontier"], ["dear", "dominated"]]);
  });

  it("does not estimate a ratio when a case cost nothing, so only quality can decide", () => {
    const free = analyse(runs.map((run) => (run.configuration === "cheap" ? { ...run, costUsd: 0 } : run)));
    expect(free.efficiency.comparisons[0]).toMatchObject({ cost: null, casesWithoutCost: 30 });
    // cheap still wins on completion, so it is on the frontier; dear is not dominated without a cost interval.
    expect(free.efficiency.arms.map(({ pareto }) => pareto)).toEqual(["frontier", "ambiguous"]);
    const tied = analyse(syntheticGrid(dataset.cases, () => true, 5, two).map((run) => ({ ...run, costUsd: 0 })));
    expect(tied.primary.comparisons.find(({ metric }) => metric === "completion")!.verdict).toBe("indistinguishable");
    expect(tied.efficiency.arms.map(({ pareto }) => pareto)).toEqual(["ambiguous", "ambiguous"]);
  });

  it("leaves zero-cost cases out of the ratio and counts them", () => {
    const someFree = analyse(runs.map((run) => (run.configuration === "cheap" && caseIndex(run) < 3 ? { ...run, costUsd: 0 } : run)));
    const comparison = someFree.efficiency.comparisons[0]!;
    expect(comparison).toMatchObject({ cases: 30, casesWithoutCost: 3 });
    const logs = dataset.cases.slice(3).map((_, index) => Math.log(1 / (2 * (1 + 0.003 * ((index + 3) % 5)))));
    expect(comparison.cost!.ratio).toBeCloseTo(Math.exp(tInterval(logs, 0.95)!.estimate), 12);
    expect(someFree.efficiency.arms.map(({ pareto }) => pareto)).toEqual(["frontier", "dominated"]);
  });

  it("reports no interval when every case costs exactly the same multiple", () => {
    const constant = analyse(runs.map((run) => ({ ...run, costUsd: run.configuration === "cheap" ? 0.01 : 0.02 })));
    expect(constant.efficiency.comparisons[0]!.cost).toBeNull();
  });

  it("treats a trade-off as two frontier arms", () => {
    // Now the dearer arm is the better one.
    const tradeOff = analyse(runs.map((run) => ({ ...run, configuration: run.configuration === "cheap" ? "dear-better" : "cheap-worse", costUsd: run.configuration === "cheap" ? run.costUsd * 4 : run.costUsd })));
    expect(tradeOff.efficiency.arms.map(({ pareto }) => pareto)).toEqual(["frontier", "frontier"]);
  });
});

describe("report rendering", () => {
  it("returns nothing for an empty run", () => {
    const empty = computeRunAnalysis([], []);
    expect(empty.primary.comparisons).toEqual([]);
    expect(empty.efficiency.arms).toEqual([]);
    expect(analysisSections(empty)).toEqual([]);
    expect(headlineTable(empty).rows).toEqual([]);
  });

  it("puts the primary outcome in the headline and the row-level aggregates in an appendix", () => {
    const runs = syntheticGrid(dataset.cases, ({ caseIndex, configuration }) => configuration !== "routed" || caseIndex >= 6);
    const report = buildReport(runs, dataset.cases, manifest);
    const markdown = report.markdown;
    expect(markdown).toContain("| routed | 24/30 cases, 80.0% (");
    expect(markdown.indexOf("## Primary comparison: every repeat passed")).toBeLessThan(markdown.indexOf("## Legacy: paired bootstrap comparisons"));
    expect(markdown.indexOf("## Reproducibility")).toBeLessThan(markdown.indexOf("## Appendix: row-level aggregates"));
    expect(markdown).toContain(`Statistical methods: ${STATS_METHODS_VERSION}, checked against evalstats 0.3.3.`);
    expect(markdown).toContain("Sidak-adjusted 98.30% level");
    for (const title of ["Scope", "Secondary comparison: per-case pass rate", "Stability across repeats (not validated)", "Run outcomes and why runs stopped", "Sensitivity: without cases that stopped early", "Cost and latency per case"]) {
      expect(markdown).toContain(`## ${title}`);
      expect(report.html).toContain(`<h2>${title}</h2>`);
    }
    expect(report.summary.statistics.method).toMatchObject({ version: STATS_METHODS_VERSION, primaryEstimand: "all-pass", reference: { package: "evalstats" } });
    expect(report.summary.statistics.scope).toContain("these 30 cases");
    const emDash = String.fromCodePoint(0x2014);
    expect(markdown).not.toContain(emDash);
    expect(report.html).not.toContain(emDash);
  });
});

describe("report statistics check", () => {
  const runs = syntheticGrid(dataset.cases, () => true, 5, ["prod-routed-5-5", "direct-sonnet-5-5"]);
  const summary = JSON.parse(JSON.stringify(buildReport(runs, dataset.cases, manifest, ["prod-routed-5-5", "direct-sonnet-5-5"]).summary)) as { statistics: Record<string, unknown> & { method: Record<string, unknown>; efficiency: { comparisons: unknown[] } } };

  it("accepts a summary written by the current methods", () => {
    expect(checkReportStatistics(summary)).toEqual([]);
  });

  it("names a stale methods version, a missing block and a short block", () => {
    expect(checkReportStatistics({ ...summary, statistics: { ...summary.statistics, method: { ...summary.statistics.method, version: "stats-methods-v1" } } }))
      .toEqual([`statistics.method.version: expected ${STATS_METHODS_VERSION}, found stats-methods-v1`]);
    const withoutSensitivity = Object.fromEntries(Object.entries(summary.statistics).filter(([key]) => key !== "sensitivity"));
    expect(checkReportStatistics({ statistics: withoutSensitivity })[0]).toMatch(/^statistics\.sensitivity/u);
    expect(checkReportStatistics({ ...summary, statistics: { ...summary.statistics, efficiency: { ...summary.statistics.efficiency as object, comparisons: [] } } }))
      .toEqual(["statistics.efficiency.comparisons: expected 1 entries for 2 configurations, found 0"]);
  });

  it("reads a summary file and reports unreadable JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-check-"));
    await writeFile(join(root, "summary.json"), JSON.stringify(summary));
    await writeFile(join(root, "broken.json"), "{");
    expect(await checkReportFile(join(root, "summary.json"))).toEqual([]);
    await expect(checkReportFile(join(root, "broken.json"))).rejects.toThrow("Could not read");
  });
});
