import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadDataset } from "../../src/dataset.js";
import { evaluateGate, type GateInput } from "../../src/gate/decision.js";
import { SEVERITY_RULES_VERSION } from "../../src/gate/severity.js";
import { parseThresholds, ThresholdsSchema, type Thresholds } from "../../src/gate/thresholds.js";
import type { RawRun } from "../../src/scoring.js";
import type { ScoringContract } from "../../src/scoring-contract.js";
import { SCORING_CONTRACT_VERSION } from "../../src/scoring.js";
import { bonettPriceInterval, clopperPearsonInterval, STATS_METHODS_VERSION } from "../../src/stats/index.js";
import { syntheticGrid } from "../helpers/synthetic.js";

const v3 = parseThresholds(await readFile("config/thresholds.v3.json", "utf8"));
const v3Raw = JSON.parse(await readFile("config/thresholds.v3.json", "utf8")) as Record<string, unknown>;
const legacy = parseThresholds(await readFile("config/thresholds.v1.json", "utf8"));
const dataset = await loadDataset("datasets/v2/manifest.json");
const CANDIDATE = "routed";
const REFERENCE = "direct-sonnet";
const LOCKED = { version: SCORING_CONTRACT_VERSION, sha256: "a".repeat(64), lockedSha256: "a".repeat(64), matchesLock: true };

/**
 * thresholds-v3 with a minimum, a critical limit, and margins a 30-case grid can clear, so the mechanics can be
 * tested on the v2 synthetic helper. (Zero critical cases in 30 only bound the rate at 9.5 percent.)
 */
const testable: Thresholds = {
  ...v3,
  minimumCases: { ...v3.minimumCases, value: 30 },
  criticalErrors: { ...v3.criticalErrors, maxUpperBound: 0.1 },
  nonInferiority: [
    { metric: "completion", margin: 0.1, rationale: "Test margin a 30-case grid can clear." },
    { metric: "headlineToolAccuracy", margin: 0.1, rationale: "Test margin a 30-case grid can clear." },
    { metric: "recovery", margin: 0.3, rationale: "Test margin an 8-case grid can clear." },
  ],
};

/** `contract` null leaves the scoring contract out of the input, as an older caller would. */
const gate = (runs: readonly RawRun[], overrides: Partial<GateInput> = {}, contract: ScoringContract | null = LOCKED) => evaluateGate({
  thresholds: testable,
  cases: dataset.cases,
  expectedRepeats: 5,
  writeTools: new Set(["match_payment", "create_follow_up"]),
  candidate: { source: "raw.jsonl", configuration: CANDIDATE, runs, invalidRows: 0 },
  reference: { source: "raw.jsonl", configuration: REFERENCE, runs, invalidRows: 0 },
  datasetIntegrityVerified: true,
  ...(contract === null ? {} : { scoringContract: contract }),
  ...overrides,
});
/** Grid where the candidate fails the first `repeatsFailing` repeats of the first `failing` cases. */
const regressed = (failing: number, repeatsFailing = 5) => syntheticGrid(dataset.cases, ({ caseIndex, configuration, repeat }) =>
  !(configuration === CANDIDATE && caseIndex < failing && repeat < repeatsFailing));

const status = (cases: number, candidateOnly: number, referenceOnly: number, margin: number): string => {
  const { low, high } = bonettPriceInterval({ firstOnly: candidateOnly, secondOnly: referenceOnly, bothPassed: cases - candidateOnly - referenceOnly, bothFailed: 0 });
  return high < -margin ? "BLOCK" : low < -margin ? "INCONCLUSIVE" : "PASS";
};
const margin = (metric: string): number => v3.nonInferiority.find((item) => item.metric === metric)!.margin;

describe("thresholds-v3 file", () => {
  it("pins the severity rules, statistics methods, and scoring contract the code implements", () => {
    expect(v3).toMatchObject({
      version: "thresholds-v3",
      severityRulesVersion: SEVERITY_RULES_VERSION,
      minimumCases: { value: 90 },
      analysis: { primaryEstimand: "all-pass", nonInferiorityInterval: "bonett-price", statsMethodsVersion: STATS_METHODS_VERSION, scoringContractVersion: SCORING_CONTRACT_VERSION },
    });
    expect(v3Raw).not.toHaveProperty("bootstrap");
    expect(v3Raw).not.toHaveProperty("zeroWidthInterval");
    for (const item of [v3.analysis!, v3.minimumCases, v3.deterministicChecks, v3.criticalErrors, ...v3.nonInferiority]) expect(item.rationale.length).toBeGreaterThan(40);
  });

  it("keeps the critical limit between the zero-failure and one-failure bounds at n = 90", () => {
    expect(clopperPearsonInterval(0, 90, 0.95, "upper").high).toBeLessThan(v3.criticalErrors.maxUpperBound);
    expect(clopperPearsonInterval(1, 90, 0.95, "upper").high).toBeGreaterThan(v3.criticalErrors.maxUpperBound);
  });

  it("sets the 90-case margins where their rationale says the decision changes", () => {
    for (const metric of ["completion", "headlineToolAccuracy"]) {
      const m = margin(metric);
      expect(status(90, 0, 0, 0.03)).toBe("INCONCLUSIVE");
      expect(status(90, 0, 0, m)).toBe("PASS");
      expect(status(90, 0, 1, m)).toBe("PASS");
      expect(status(90, 1, 1, m)).toBe("PASS");
      expect(status(90, 2, 2, m)).toBe("INCONCLUSIVE");
      expect(status(90, 0, 2, m)).toBe("INCONCLUSIVE");
      expect(status(90, 0, 11, m)).toBe("INCONCLUSIVE");
      expect(status(90, 3, 2, m)).toBe("PASS");
      expect(status(90, 1, 2, m)).toBe("INCONCLUSIVE");
      expect(status(90, 0, 12, m)).toBe("BLOCK");
    }
  });

  it("sets the 18-case recovery margin so it passes while no case is lost and blocks from nine lost cases", () => {
    const m = margin("recovery");
    expect(status(18, 0, 0, m)).toBe("PASS");
    expect(status(18, 1, 0, m)).toBe("PASS");
    expect(status(18, 5, 0, m)).toBe("PASS");
    expect(status(18, 1, 1, m)).toBe("INCONCLUSIVE");
    expect(status(18, 2, 1, m)).toBe("INCONCLUSIVE");
    expect(status(18, 0, 1, m)).toBe("INCONCLUSIVE");
    expect(status(18, 0, 8, m)).toBe("INCONCLUSIVE");
    expect(status(18, 0, 9, m)).toBe("BLOCK");
  });
});

describe("thresholds schema rules for the analysis", () => {
  const withoutLegacyBlocks = { ...v3Raw };
  const bootstrap = { resamples: 10_000, seed: 1 };
  const zeroWidthInterval = { policy: "warn", rationale: "A rationale that is long enough to pass." };

  it("rejects bootstrap settings or a zero-width policy next to the Bonett-Price interval", () => {
    expect(ThresholdsSchema.safeParse({ ...withoutLegacyBlocks, bootstrap }).success).toBe(false);
    expect(ThresholdsSchema.safeParse({ ...withoutLegacyBlocks, zeroWidthInterval }).success).toBe(false);
  });

  it("requires bootstrap settings and a zero-width policy for the bootstrap, which only supports per-case rates", () => {
    const analysis = { ...(v3Raw.analysis as object), nonInferiorityInterval: "percentile-bootstrap", primaryEstimand: "per-case-rate" };
    expect(ThresholdsSchema.safeParse({ ...withoutLegacyBlocks, analysis }).success).toBe(false);
    expect(ThresholdsSchema.safeParse({ ...withoutLegacyBlocks, analysis, bootstrap, zeroWidthInterval }).success).toBe(true);
    expect(ThresholdsSchema.safeParse({ ...withoutLegacyBlocks, analysis: { ...analysis, primaryEstimand: "all-pass" }, bootstrap, zeroWidthInterval }).success).toBe(false);
  });

  it("still reads the legacy files, which name no analysis", async () => {
    for (const path of ["config/thresholds.v1.json", "config/thresholds.v2.json"]) {
      const parsed = parseThresholds(await readFile(path, "utf8"));
      expect(parsed.analysis).toBeUndefined();
      expect(parsed.bootstrap).toBeDefined();
    }
  });
});

describe("gate decisions under the Bonett-Price analysis", () => {
  it("passes identical arms with a positive-width interval and no zero-width warning", () => {
    const result = gate(syntheticGrid(dataset.cases));
    expect(result).toMatchObject({ decision: "PASS", warnings: [], analysis: { primaryEstimand: "all-pass", nonInferiorityInterval: "bonett-price", statsMethodsVersion: STATS_METHODS_VERSION } });
    const completion = result.comparisons[0]!;
    expect(completion).toMatchObject({ metric: "completion", cases: 30, difference: 0, estimand: "all-pass", method: "bonett-price", pValue: 1, status: "PASS" });
    expect(completion.interval!.high - completion.interval!.low).toBeGreaterThan(0.1);
    expect(completion.secondary).toMatchObject({ estimand: "per-case-rate", method: "bonett-price-cluster", difference: 0, pValue: 1 });
  });

  it("cannot pass 30 cases at the real 5 point margin, even with perfect agreement", () => {
    const result = gate(syntheticGrid(dataset.cases), { thresholds: { ...testable, nonInferiority: v3.nonInferiority } });
    expect(result.comparisons.find(({ metric }) => metric === "completion")!.status).toBe("INCONCLUSIVE");
  });

  it("separates a stability difference from an accuracy difference", () => {
    // The candidate fails one repeat out of five in three cases: three cases no longer pass every repeat
    // (-10 points on the primary estimand) while the per-case pass rate drops by only 2 points.
    const completion = gate(regressed(3, 1)).comparisons[0]!;
    expect(completion.difference).toBeCloseTo(-0.1, 12);
    expect(completion.secondary!.difference).toBeCloseTo(-0.02, 12);
    expect(completion.status).toBe("INCONCLUSIVE");
    expect(completion.casesSuggested).toBeGreaterThan(30);
  });

  it("blocks a large regression and reports a small mid-p value", () => {
    const result = gate(regressed(12));
    const completion = result.comparisons[0]!;
    expect(result.decision).toBe("BLOCK");
    expect(completion.status).toBe("BLOCK");
    expect(completion.pValue).toBeLessThan(0.001);
  });

  it("gates on the case-clustered interval when the thresholds choose per-case rates", () => {
    const perCase: Thresholds = { ...testable, analysis: { ...testable.analysis!, primaryEstimand: "per-case-rate" } };
    // One case loses one repeat: -0.67 points on per-case rates. The two pseudo-cases keep the 30-case lower bound
    // near -9.4 points, inside the 10 point test margin; three such cases (-10.8) would not be.
    const completion = gate(regressed(1, 1), { thresholds: perCase }).comparisons[0]!;
    expect(completion).toMatchObject({ estimand: "per-case-rate", status: "PASS", secondary: null });
    expect(completion.difference).toBeCloseTo(-0.2 / 30, 12);
    expect(gate(regressed(3, 1), { thresholds: perCase }).comparisons[0]!.status).toBe("INCONCLUSIVE");
  });

  it("blocks on a statistics version or scoring contract that differs from the pinned one", () => {
    const check = (result: ReturnType<typeof gate>, id: string) => result.checks.find((item) => item.id === id);
    const statsPinned = gate(syntheticGrid(dataset.cases), { thresholds: { ...testable, analysis: { ...testable.analysis!, statsMethodsVersion: "stats-methods-v1" } } });
    expect(statsPinned.decision).toBe("BLOCK");
    expect(check(statsPinned, "stats_methods_version")?.passed).toBe(false);
    const missing = gate(syntheticGrid(dataset.cases), {}, null);
    expect(check(missing, "scoring_contract_version")).toMatchObject({ passed: false, detail: expect.stringContaining("no scoring contract") });
    const unlocked = gate(syntheticGrid(dataset.cases), { scoringContract: { ...LOCKED, matchesLock: false } });
    expect(unlocked.decision).toBe("BLOCK");
    expect(check(unlocked, "scoring_contract_version")?.detail).toContain("does NOT match");
  });

  it("leaves legacy decisions on the bootstrap, with no version checks and no secondary result", () => {
    const result = gate(syntheticGrid(dataset.cases), { thresholds: legacy });
    expect(result.analysis).toMatchObject({ primaryEstimand: "per-case-rate", nonInferiorityInterval: "percentile-bootstrap" });
    expect(result.checks.some(({ id }) => id === "stats_methods_version" || id === "scoring_contract_version")).toBe(false);
    expect(result.comparisons.every(({ pValue, secondary, method }) => pValue === null && secondary === null && method === "percentile-bootstrap")).toBe(true);
  });
});
