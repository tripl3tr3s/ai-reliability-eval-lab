import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDataset } from "../src/dataset.js";
import { parseRawRuns, readRawRuns } from "../src/raw-run.js";
import { generateReport, runTimestamps, UNKNOWN_TIMESTAMP } from "../src/report-command.js";
import { buildReport, type RunManifest } from "../src/report.js";
import { caseTallies, computeRunStatistics, statisticsSections } from "../src/report-statistics.js";
import { scoreRun } from "../src/scoring.js";
import { wilsonInterval } from "../src/stats/index.js";
import { ARMS, syntheticGrid, syntheticRun, toJsonl } from "./helpers/synthetic.js";

const manifest: RunManifest = { commitSha: "abc", datasetHash: "hash", configurationHash: "config", promptVersion: "v2", resourceVersion: "v2", models: ["synthetic-model"], repeatCount: 5, seed: 7, nodeVersion: "22", lockfileVersion: "9", pricingVersion: "v1", pricingEffectiveDate: "2026-08-25", startedAt: "2026-08-25T00:00:00Z", completedAt: "2026-08-25T00:01:00Z", rawResultReferences: ["raw.jsonl"] };
const dataset = await loadDataset("datasets/v2/manifest.json");
const scoreAll = (runs: ReturnType<typeof syntheticGrid>) => {
  const byId = new Map(dataset.cases.map((item) => [item.id, item]));
  return runs.map((run) => scoreRun(run, byId.get(run.caseId)!));
};

afterEach(() => vi.useRealTimers());

describe("synthetic helper", () => {
  it("builds rows the real scorer accepts for every v2 case", () => {
    const scores = scoreAll(syntheticGrid(dataset.cases, () => true, 1, ["routed"]));
    expect(scores.filter(({ completionPassed }) => !completionPassed).map(({ caseId }) => caseId)).toEqual([]);
    expect(scores.filter(({ headlineToolAccuracy }) => headlineToolAccuracy === false).map(({ caseId }) => caseId)).toEqual([]);
  });
});

describe("case-level run statistics", () => {
  // Routed fails every repeat of the first 6 cases; no-resource-injection fails one repeat of 10 cases.
  const runs = syntheticGrid(dataset.cases, ({ caseIndex, configuration, repeat }) =>
    configuration === "routed" ? caseIndex >= 6 : configuration === "no-resource-injection" ? !(caseIndex < 10 && repeat === 0) : true);
  const statistics = computeRunStatistics(scoreAll(runs), runs, 7);
  const arm = (name: string) => statistics.arms.find(({ configuration }) => configuration === name)!;
  const completion = (name: string) => arm(name).metrics.find(({ metric }) => metric === "completion")!;

  it("uses the case as the unit and keeps the pooled pass rate", () => {
    expect(statistics.method).toMatchObject({ unitOfAnalysis: "case", confidence: 0.95, resamples: 10_000, seed: 7 });
    expect(completion("routed")).toMatchObject({ cases: 30, runs: 150, passRate: 0.8, casesAllPassed: 24, casesMajorityPassed: 24, repeats: 5 });
    expect(completion("direct-sonnet")).toMatchObject({ passRate: 1, clusteredCi95: { low: 1, high: 1 }, casesAllPassed: 30 });
  });

  it("gives a wider interval than the row-level one when repeats agree", () => {
    const routed = completion("routed");
    const clusteredWidth = routed.clusteredCi95!.high - routed.clusteredCi95!.low;
    const rowWidth = routed.rowLevelWilson95!.high - routed.rowLevelWilson95!.low;
    expect(clusteredWidth).toBeGreaterThan(1.8 * rowWidth);
    expect(routed.rowLevelWilson95).toEqual(wilsonInterval(120, 150));
    expect(routed.allPassWilson95).toEqual(wilsonInterval(24, 30));
  });

  it("computes pass@k and pass^k from per-case rates", () => {
    const flaky = completion("no-resource-injection");
    expect(flaky.passRate).toBeCloseTo(140 / 150, 12);
    expect(flaky.casesAllPassed).toBe(20);
    expect(flaky.casesMajorityPassed).toBe(30);
    expect(flaky.passAtK).toBeCloseTo((20 + 10 * (1 - 0.2 ** 5)) / 30, 12);
    expect(flaky.passPowerK).toBeCloseTo((20 + 10 * 0.8 ** 5) / 30, 12);
    expect(completion("routed").passAtK).toBeCloseTo(0.8, 12);
    expect(completion("routed").passPowerK).toBeCloseTo(0.8, 12);
  });

  it("restricts recovery statistics to the cases where recovery applies", () => {
    expect(arm("direct-sonnet").metrics.find(({ metric }) => metric === "recovery")).toMatchObject({ cases: 8, runs: 40 });
    expect(caseTallies(scoreAll(runs), "direct-sonnet", "recovery")).toHaveLength(8);
  });

  it("compares configurations within case with McNemar and a paired bootstrap", () => {
    const comparison = statistics.comparisons.find((item) => item.metric === "completion" && item.first === "direct-sonnet" && item.second === "routed")!;
    expect(comparison.cases).toBe(30);
    expect(comparison.meanDifference).toBeCloseTo(0.2, 12);
    expect(comparison.bootstrapCi95!.low).toBeGreaterThan(0.05);
    expect(comparison.bootstrapCi95!.high).toBeLessThan(0.4);
    expect(comparison.allPass).toMatchObject({ firstOnly: 6, secondOnly: 0, discordant: 6 });
    expect(comparison.allPass.pValue).toBeCloseTo(0.03125, 12);
    expect(comparison.discordanceRate).toBeCloseTo(0.2, 12);
    // 20% discordance at 30 cases: nothing is detectable; 37 cases are the minimum.
    expect(comparison.minimumDetectableEffect).toBeNull();
    expect(comparison.casesNeededAtObservedDiscordance).toBe(37);
    expect(statistics.comparisons).toHaveLength(9);
  });

  it("separates the every-repeat rule from the majority rule", () => {
    const comparison = statistics.comparisons.find((item) => item.metric === "completion" && item.first === "direct-sonnet" && item.second === "no-resource-injection")!;
    expect(comparison.allPass).toMatchObject({ firstOnly: 10, secondOnly: 0 });
    expect(comparison.majority).toMatchObject({ firstOnly: 0, secondOnly: 0, pValue: 1 });
    expect(comparison.meanDifference).toBeCloseTo(10 * 0.2 / 30, 12);
  });

  it("states what the sample size can support", () => {
    expect(statistics.detection).toMatchObject({ cases: 30, repeatsPerCase: 5, planningFailureRate: 0.01, casesToBoundPlanningFailureRate: 299 });
    expect(statistics.detection.zeroFailureUpperBound95).toBeCloseTo(0.09503385285530411, 10);
    expect(statistics.detection.planning.map(({ discordanceRate, minimumDetectableEffect }) => [discordanceRate, minimumDetectableEffect === null]))
      .toEqual([[0.1, true], [0.2, true], [0.3, false], [0.5, false]]);
  });

  it("reports tokens only when every run recorded them", () => {
    expect(arm("routed")).toMatchObject({ runs: 150, totalTokens: 150_000, meanTokensPerRun: 1_000 });
    const legacy = runs.map((run, index) => index === 0 ? Object.fromEntries(Object.entries(run).filter(([key]) => key !== "tokens")) as typeof run : run);
    const legacyArm = computeRunStatistics(scoreAll(legacy), legacy, 7).arms.find(({ configuration }) => configuration === legacy[0]!.configuration)!;
    expect(legacyArm).toMatchObject({ totalTokens: null, meanTokensPerRun: null });
    expect(legacyArm.totalCostUsd).toBeCloseTo(1.5, 10);
  });

  it("handles an empty run and a single case", () => {
    const empty = computeRunStatistics([], [], 1);
    expect(empty).toMatchObject({ arms: [], comparisons: [], detection: { cases: 0, zeroFailureUpperBound95: null } });
    expect(statisticsSections(empty)).toEqual([]);
    const single = syntheticGrid(dataset.cases.slice(0, 1), () => true, 1, ["routed", "direct-sonnet"]);
    const result = computeRunStatistics(scoreAll(single), single, 1);
    expect(result.comparisons[0]).toMatchObject({ cases: 1, meanDifference: 0, discordanceRate: 0, minimumDetectableEffect: null, casesNeededAtObservedDiscordance: null });
    expect(result.arms[0]!.metrics.find(({ metric }) => metric === "recovery")).toMatchObject({ cases: 0, passRate: null, clusteredCi95: null, passAtK: null });
  });
});

describe("report output", () => {
  const runs = syntheticGrid(dataset.cases, ({ caseIndex, configuration }) => configuration !== "routed" || caseIndex >= 6);

  it("adds the case-level sections to Markdown, HTML and the summary", () => {
    const report = buildReport(runs, dataset.cases, manifest);
    for (const title of ["Reliability by case", "Cost and tokens", "Paired comparisons", "What this run can and cannot detect"]) {
      expect(report.markdown).toContain(`## ${title}`);
      expect(report.html).toContain(`<h2>${title}</h2>`);
    }
    expect(report.markdown).toContain("5 repeats are not 5 times as many independent samples");
    expect(report.markdown).toContain("needs 299 cases");
    expect(report.markdown).toContain("Not detectable at 30 cases (needs at least 37)");
    expect(report.markdown).toContain("row-level bootstraps");
    expect(report.summary.statistics.arms.map(({ configuration }) => configuration)).toEqual([...ARMS].sort());
    expect(report.summary.configurations).toHaveLength(3);
    expect(report.markdown).not.toContain("—");
  });

  it("is byte-identical for the same rows regardless of row order", () => {
    const first = buildReport(runs, dataset.cases, manifest);
    const second = buildReport([...runs].reverse(), dataset.cases, manifest);
    expect(second.markdown).toBe(first.markdown);
    expect(second.html).toBe(first.html);
    expect(JSON.stringify(second.summary)).toBe(JSON.stringify(first.summary));
  });

  it("changes when a single row changes", () => {
    const changed = runs.map((run, index) => index === 0 ? { ...run, answer: "No result." } : run);
    expect(buildReport(changed, dataset.cases, manifest).markdown).not.toBe(buildReport(runs, dataset.cases, manifest).markdown);
  });
});

describe("report command", () => {
  it("writes byte-identical files from the same raw JSONL at different wall-clock times", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-report-"));
    const raw = join(root, "raw.jsonl");
    const events = join(root, "events.jsonl");
    await writeFile(raw, toJsonl(syntheticGrid(dataset.cases, ({ caseIndex }) => caseIndex !== 3)));
    await writeFile(events, toJsonl([{ at: "2026-09-01T08:20:00.000Z" }, { at: "2026-09-01T08:17:00.000Z" }, { at: "2026-09-01T09:02:00.000Z" }]));
    const input = { rawPath: raw, configPath: "config/full.v2.json", eventsPath: events, environment: {}, nodeVersion: "v22.0.0" };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
    const summary = await generateReport({ ...input, outputDirectory: join(root, "first") });
    vi.setSystemTime(new Date("2027-01-01T12:00:00Z"));
    await generateReport({ ...input, outputDirectory: join(root, "second") });
    for (const file of ["summary.json", "results.jsonl", "report.md", "index.html"]) {
      expect(await readFile(join(root, "second", file), "utf8")).toBe(await readFile(join(root, "first", file), "utf8"));
    }
    expect(summary.manifest).toMatchObject({ startedAt: "2026-09-01T08:17:00.000Z", completedAt: "2026-09-01T09:02:00.000Z", commitSha: "local", datasetHash: dataset.hash });
    expect(summary.status).toBe("complete");
  });

  it("marks timestamps unknown without telemetry instead of using the clock", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-report-"));
    const raw = join(root, "raw.jsonl");
    await writeFile(raw, toJsonl([syntheticRun(dataset.cases[0]!, "routed", 0, true)]));
    const summary = await generateReport({ rawPath: raw, configPath: "config/full.v2.json", outputDirectory: join(root, "out"), environment: { GITHUB_SHA: "sha-1" } });
    expect(summary.manifest).toMatchObject({ startedAt: UNKNOWN_TIMESTAMP, completedAt: UNKNOWN_TIMESTAMP, commitSha: "sha-1" });
    expect(summary.status).toBe("pending");
    expect(runTimestamps("not json\n{\"at\":5}\n{\"at\":\"nonsense\"}\n")).toEqual({ startedAt: UNKNOWN_TIMESTAMP, completedAt: UNKNOWN_TIMESTAMP });
  });

  it("rejects malformed raw rows with the line number", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-report-"));
    const raw = join(root, "raw.jsonl");
    await writeFile(raw, `${JSON.stringify(syntheticRun(dataset.cases[0]!, "routed", 0, true))}\n{"runId":"x"}\n`);
    await expect(generateReport({ rawPath: raw, configPath: "config/full.v2.json", outputDirectory: join(root, "out") })).rejects.toThrow("Invalid raw result on line 2");
  });
});

describe("raw row parsing", () => {
  it("collects every invalid line and keeps unknown keys", () => {
    const good = { ...syntheticRun(dataset.cases[0]!, "routed", 0, true), futureField: 1 };
    const parsed = parseRawRuns(`${JSON.stringify(good)}\n\nnot json\n${JSON.stringify({ ...good, repeat: -1 })}\n`);
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]).toMatchObject({ futureField: 1 });
    expect(parsed.issues).toEqual([{ line: 3, message: "Invalid JSON" }, { line: 4, message: expect.stringContaining("repeat") }]);
    expect(readRawRuns("")).toEqual([]);
  });
});
