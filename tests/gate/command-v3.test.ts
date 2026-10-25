import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ANTHROPIC_MODELS } from "../../src/adapter.js";
import { loadDataset } from "../../src/dataset.js";
import { gateDefaultsFor, runGate } from "../../src/gate-command.js";
import { runMockExperiment } from "../../src/mock/run.js";
import { readRawRuns } from "../../src/raw-run.js";

const CONFIG = "config/full.v3.json";
let clean: string;
let regressed: string;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "gate-v3-"));
  clean = join(root, "clean.jsonl");
  regressed = join(root, "regressed.jsonl");
  await runMockExperiment({ configPath: CONFIG, outputPath: clean, profile: "clean" });
  await runMockExperiment({ configPath: CONFIG, outputPath: regressed, profile: "regressed" });
}, 120_000);

describe("v3 go-live gate on the scripted model", () => {
  it("defaults to thresholds-v3 and the production-mirror arms for dataset v3", async () => {
    expect(await gateDefaultsFor(CONFIG)).toEqual({ thresholdsPath: "config/thresholds.v3.json", candidate: "prod-routed-5-5", reference: "direct-sonnet-5-5" });
    expect(await gateDefaultsFor("config/full.v2.json")).toMatchObject({ thresholdsPath: "config/thresholds.v1.json", candidate: "routed" });
  });

  it("routes advanced domains to the Opus 5.5 tier in the production-mirror arm", async () => {
    const runs = readRawRuns(await readFile(clean, "utf8")).filter(({ configuration }) => configuration === "prod-routed-5-5");
    expect(runs.every(({ tier, routedDomain }) => (routedDomain === "pagos" || routedDomain === "cumplimiento") === (tier === "advanced"))).toBe(true);
    expect(runs.some(({ tier }) => tier === "advanced")).toBe(true);
  });

  it("passes the clean profile with every deterministic check green", async () => {
    const { report } = await runGate({ rawPath: clean, configPath: CONFIG, thresholdsPath: "config/thresholds.v2.json", candidate: "prod-routed-5-5" });
    expect(report.decision).toBe("PASS");
    expect(report.checks.every(({ passed }) => passed)).toBe(true);
    expect(report.dataSource).toBe("mock");
  });

  it("blocks a regression of the advanced executor on critical errors and non-inferiority", async () => {
    const { report } = await runGate({ rawPath: regressed, configPath: CONFIG, thresholdsPath: "config/thresholds.v2.json", candidate: "prod-routed-5-5" });
    expect(report.decision).toBe("BLOCK");
    expect(report.reasons.some((reason) => reason.includes("critical error"))).toBe(true);
    expect(report.reasons.some((reason) => reason.includes("completion"))).toBe(true);
  });

  it("passes the clean profile and blocks the regression under thresholds-v3, with the pinned versions checked", async () => {
    const clean3 = (await runGate({ rawPath: clean, configPath: CONFIG, thresholdsPath: "config/thresholds.v3.json", candidate: "prod-routed-5-5" })).report;
    expect(clean3).toMatchObject({ decision: "PASS", thresholdsVersion: "thresholds-v3", warnings: [], analysis: { primaryEstimand: "all-pass", nonInferiorityInterval: "bonett-price" } });
    expect(clean3.checks.filter(({ id }) => id === "stats_methods_version" || id === "scoring_contract_version").map(({ passed }) => passed)).toEqual([true, true]);
    expect(clean3.comparisons.map(({ metric, status }) => [metric, status])).toEqual([["completion", "PASS"], ["headlineToolAccuracy", "PASS"], ["recovery", "PASS"]]);
    const regressed3 = (await runGate({ rawPath: regressed, configPath: CONFIG, thresholdsPath: "config/thresholds.v3.json", candidate: "prod-routed-5-5" })).report;
    expect(regressed3.decision).toBe("BLOCK");
    expect(regressed3.comparisons.find(({ metric }) => metric === "completion")).toMatchObject({ status: "BLOCK", estimand: "all-pass" });
  });

  it("applies the 90-case completion boundaries end to end through the gate", async () => {
    // Lose k non-recovery cases on every candidate repeat (a bounded run fails completion but is not critical).
    const runs = readRawRuns(await readFile(clean, "utf8"));
    const lookups = new Set((await loadDataset("datasets/v3/manifest.json")).cases.filter(({ category }) => category === "lookup").map(({ id }) => id));
    const lost = [...new Set(runs.map(({ caseId }) => caseId))].filter((caseId) => lookups.has(caseId)).sort();
    const root = await mkdtemp(join(tmpdir(), "gate-v3-boundary-"));
    const completionAfterLosing = async (k: number) => {
      const path = join(root, `lose-${k}.jsonl`);
      const losing = new Set(lost.slice(0, k));
      await writeFile(path, runs.map((run) => JSON.stringify(run.configuration === "prod-routed-5-5" && losing.has(run.caseId) ? { ...run, outcome: "bounded", answer: "Deadline exceeded", terminationReason: "deadline" } : run)).join("\n") + "\n");
      const { report } = await runGate({ rawPath: path, configPath: CONFIG, thresholdsPath: "config/thresholds.v3.json", candidate: "prod-routed-5-5" });
      return report.comparisons.find(({ metric }) => metric === "completion")!.status;
    };
    expect(lost.length).toBeGreaterThanOrEqual(12);
    expect(await completionAfterLosing(1)).toBe("PASS");
    expect(await completionAfterLosing(2)).toBe("INCONCLUSIVE");
    expect(await completionAfterLosing(12)).toBe("BLOCK");
  });

  it("keeps thresholds-v2 decisions on the percentile bootstrap", async () => {
    const { report } = await runGate({ rawPath: clean, configPath: CONFIG, thresholdsPath: "config/thresholds.v2.json", candidate: "prod-routed-5-5" });
    expect(report.analysis).toMatchObject({ primaryEstimand: "per-case-rate", nonInferiorityInterval: "percentile-bootstrap" });
    expect(report.warnings.some((warning) => warning.includes("zero width"))).toBe(true);
  });

  it("rejects thresholds pinned to severity rules v1 for dataset v3", async () => {
    const { report } = await runGate({ rawPath: clean, configPath: CONFIG, thresholdsPath: "config/thresholds.v1.json", candidate: "prod-routed-5-5" });
    expect(report.decision).toBe("BLOCK");
    expect(report.checks.find(({ id }) => id === "severity_rules_version")?.passed).toBe(false);
  });

  it("keeps the advanced executor pinned to Opus 5.5", () => {
    expect(ANTHROPIC_MODELS.opus55).toBe("claude-opus-5-5");
  });
});
