import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import { loadDataset } from "../../src/dataset.js";
import { evaluateGate, GATE_EXIT_CODES, type GateInput } from "../../src/gate/decision.js";
import { classifyCriticalErrors, SEVERITY_RULES_VERSION } from "../../src/gate/severity.js";
import { parseThresholds, ThresholdsSchema } from "../../src/gate/thresholds.js";
import type { RawRun } from "../../src/scoring.js";
import { clopperPearsonInterval } from "../../src/stats/index.js";
import { syntheticGrid, syntheticRun } from "../helpers/synthetic.js";

const dataset = await loadDataset("datasets/v2/manifest.json");
const thresholdsText = await readFile("config/thresholds.v1.json", "utf8");
const thresholds = parseThresholds(thresholdsText);
const writeTools = new Set(["match_payment", "create_follow_up"]);
const CANDIDATE = "routed";
const REFERENCE = "direct-sonnet";

const gate = (runs: readonly RawRun[], overrides: Partial<GateInput> = {}) => evaluateGate({
  thresholds,
  cases: dataset.cases,
  expectedRepeats: 5,
  writeTools,
  candidate: { source: "raw.jsonl", configuration: CANDIDATE, runs, invalidRows: 0 },
  reference: { source: "raw.jsonl", configuration: REFERENCE, runs, invalidRows: 0 },
  datasetIntegrityVerified: true,
  ...overrides,
});
/** Grid where the candidate fails every repeat of the first `failing` cases. */
const regressed = (failing: number, repeatsFailing = 5) => syntheticGrid(dataset.cases, ({ caseIndex, configuration, repeat }) =>
  !(configuration === CANDIDATE && caseIndex < failing && repeat < repeatsFailing));
const lookup = dataset.cases[0]!;

describe("thresholds file", () => {
  it("parses the committed thresholds and pins the implemented severity rules", () => {
    expect(thresholds).toMatchObject({ version: "thresholds-v1", date: "2026-10-10", severityRulesVersion: SEVERITY_RULES_VERSION });
    expect(thresholds.deterministicChecks.requiredPassRate).toBe(1);
    for (const item of [thresholds.minimumCases, thresholds.deterministicChecks, thresholds.criticalErrors, ...thresholds.nonInferiority]) {
      expect(item.rationale.length).toBeGreaterThan(20);
    }
  });

  it("keeps the published JSON schema in step with the zod schema", async () => {
    const published = JSON.parse(await readFile("config/thresholds.schema.json", "utf8")) as unknown;
    expect(published).toEqual(JSON.parse(JSON.stringify(zodToJsonSchema(ThresholdsSchema, { $refStrategy: "none" }))));
  });

  it("rejects thresholds without a version, date, or rationale", () => {
    const base = JSON.parse(thresholdsText) as Record<string, unknown>;
    const invalid = (change: Record<string, unknown>) => () => parseThresholds(JSON.stringify({ ...base, ...change }));
    expect(invalid({ version: "v1" })).toThrow();
    expect(invalid({ date: "10 October" })).toThrow();
    expect(invalid({ minimumCases: { value: 30 } })).toThrow();
    expect(invalid({ criticalErrors: { maxUpperBound: 0.1, rationale: "short" } })).toThrow(/rationale/u);
    expect(invalid({ deterministicChecks: { requiredPassRate: 0.99, rationale: "A long enough rationale for the test." } })).toThrow();
    expect(invalid({ nonInferiority: [] })).toThrow();
    expect(invalid({ nonInferiority: [thresholds.nonInferiority[0], thresholds.nonInferiority[0]] })).toThrow(/only one margin/u);
    expect(invalid({ unexpected: true })).toThrow();
    expect(invalid({ zeroWidthInterval: { policy: "ignore", rationale: "A long enough rationale for the test." } })).toThrow();
  });
});

describe("severity rules", () => {
  const critical = (run: RawRun, datasetCase = lookup) => classifyCriticalErrors(run, datasetCase, writeTools);
  const caseById = (id: string) => dataset.cases.find((item) => item.id === id)!;

  it("finds nothing critical in a passing run or a plain miss", () => {
    expect(critical(syntheticRun(lookup, CANDIDATE, 0, true))).toEqual([]);
    expect(critical(syntheticRun(lookup, CANDIDATE, 0, false))).toEqual([]);
    expect(critical(syntheticRun(lookup, CANDIDATE, 0, false, { outcome: "bounded", policyViolation: true, toolCalls: [] }))).toEqual([]);
  });

  it("flags a forbidden or unplanned write, including a failed attempt", () => {
    const run = syntheticRun(lookup, CANDIDATE, 0, true);
    expect(critical({ ...run, toolCalls: [...run.toolCalls, { name: "create_follow_up", input: {} }] })).toEqual(["unauthorized_write"]);
    expect(critical({ ...run, toolCalls: [...run.toolCalls, { name: "match_payment", input: {}, success: false }] })).toEqual(["unauthorized_write"]);
    expect(critical({ ...run, toolCalls: [...run.toolCalls, { name: "get_operational_policy", input: {} }] })).toEqual([]);
  });

  it("flags a wrong write but not a missing one", () => {
    const writeCase = caseById("v2-multi-match-11");
    const run = syntheticRun(writeCase, CANDIDATE, 0, true);
    expect(critical(run, writeCase)).toEqual([]);
    expect(critical({ ...run, finalState: { matchedPayments: { "PAY-011": "INV-999" } } }, writeCase)).toEqual(["wrong_write_state"]);
    expect(critical({ ...run, finalState: { matchedPayments: {} }, toolCalls: run.toolCalls.filter(({ name }) => name !== "match_payment") }, writeCase)).toEqual([]);
    expect(critical({ ...run, finalState: { matchedPayments: {} }, toolCalls: run.toolCalls.map((call) => ({ ...call, success: false })) }, writeCase)).toEqual([]);
  });

  it("flags duplicate writes, forbidden claims, and answering an abstention case", () => {
    const run = syntheticRun(lookup, CANDIDATE, 0, true);
    expect(critical({ ...run, duplicateMutation: true })).toEqual(["duplicate_write"]);
    expect(critical({ ...run, answer: "Total 1160 and it was paid." })).toEqual(["forbidden_claim"]);
    expect(critical({ ...run, answer: "Total 1160. It was not paid." })).toEqual([]);
    const abstain = caseById("v2-abstain-missing-29");
    expect(critical(syntheticRun(abstain, CANDIDATE, 0, true, { outcome: "completed" }), abstain)).toEqual(["unsupported_completion"]);
    expect(critical(syntheticRun(abstain, CANDIDATE, 0, true), abstain)).toEqual([]);
  });

  it("supports v1 cases through their accepted tool patterns", async () => {
    const v1 = (await loadDataset("datasets/v1/manifest.json")).cases[0]!;
    const run: RawRun = { runId: "r", caseId: v1.id, configuration: CANDIDATE, repeat: 0, outcome: "completed", answer: "", finalState: {}, claims: [], toolCalls: [{ name: "match_payment", input: {} }], validEvidenceIds: [], latencyMs: 1, costUsd: 0 };
    expect(classifyCriticalErrors(run, v1, writeTools)).toEqual(["unauthorized_write"]);
  });
});

describe("gate decision", () => {
  it("passes when checks pass, no case is critical, and the arms agree", () => {
    const result = gate(syntheticGrid(dataset.cases));
    expect(result).toMatchObject({ decision: "PASS", exitCode: 0, reasons: [], recommendation: null, thresholdsVersion: "thresholds-v1", severityRulesVersion: SEVERITY_RULES_VERSION });
    expect(result.checks.every(({ passed }) => passed)).toBe(true);
    expect(result.critical).toMatchObject({ cases: 30, casesWithCriticalError: 0, status: "PASS" });
    expect(result.critical.upperBound).toBeCloseTo(0.09503385285530411, 10);
    expect(result.comparisons.map(({ metric, cases, status }) => [metric, cases, status])).toEqual([["completion", 30, "PASS"], ["headlineToolAccuracy", 30, "PASS"], ["recovery", 8, "PASS"]]);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]).toContain("does not prove non-inferiority");
  });

  it("refuses to pass on a zero-width interval under the stricter policy", () => {
    const strict = { ...thresholds, zeroWidthInterval: { ...thresholds.zeroWidthInterval, policy: "inconclusive" as const } };
    const result = gate(syntheticGrid(dataset.cases), { thresholds: strict });
    expect(result).toMatchObject({ decision: "INCONCLUSIVE", exitCode: 2, warnings: [] });
    expect(result.comparisons[0]).toMatchObject({ status: "INCONCLUSIVE", detail: expect.stringContaining("zero width") });
    expect(gate(regressed(1, 1), { thresholds: strict }).comparisons[0]!.status).toBe("PASS");
  });

  it("passes without warnings when a small difference stays inside the margin", () => {
    const result = gate(regressed(1, 1));
    expect(result.decision).toBe("PASS");
    const completion = result.comparisons[0]!;
    expect(completion.difference).toBeCloseTo(-0.2 / 30, 12);
    expect(completion.interval!.low).toBeGreaterThan(-0.03);
    expect(result.warnings.some((warning) => warning.startsWith("completion"))).toBe(false);
  });

  it("blocks a clear regression: the whole interval is below the margin", () => {
    const result = gate(regressed(6));
    expect(result).toMatchObject({ decision: "BLOCK", exitCode: 1 });
    const completion = result.comparisons[0]!;
    expect(completion.status).toBe("BLOCK");
    expect(completion.difference).toBeCloseTo(-0.2, 12);
    expect(completion.interval!.high).toBeLessThan(-0.03);
    expect(result.reasons[0]).toMatch(/^BLOCK: completion differs by -20\.0 pts/u);
    expect(result.recommendation).toBeNull();
  });

  it("is inconclusive when the interval spans the margin and recommends more cases", () => {
    const result = gate(regressed(1));
    expect(result).toMatchObject({ decision: "INCONCLUSIVE", exitCode: 2 });
    const completion = result.comparisons[0]!;
    expect(completion.status).toBe("INCONCLUSIVE");
    expect(completion.interval!.low).toBeLessThan(-0.03);
    expect(completion.interval!.high).toBeGreaterThanOrEqual(-0.03);
    expect(result.reasons.some((reason) => reason.startsWith("INCONCLUSIVE: completion"))).toBe(true);
    expect(result.recommendation).toMatch(/Collect more cases/u);
    expect(result.recommendation).toMatch(/add cases/u);
  });

  it("blocks on one critical case because the upper bound exceeds the limit", () => {
    const runs = syntheticGrid(dataset.cases).map((run) => run.configuration === CANDIDATE && run.caseId === lookup.id && run.repeat === 2
      ? { ...run, toolCalls: [...run.toolCalls, { name: "create_follow_up", input: {} }] }
      : run);
    const result = gate(runs);
    expect(result.decision).toBe("BLOCK");
    expect(result.critical).toMatchObject({ casesWithCriticalError: 1, runsWithCriticalError: 1, status: "BLOCK", affectedCases: [lookup.id], byType: { unauthorized_write: 1 } });
    expect(result.critical.upperBound).toBeCloseTo(clopperPearsonInterval(1, 30, 0.95, "upper").high, 12);
    expect(result.critical.upperBound).toBeGreaterThan(0.1);
    expect(result.reasons[0]).toContain("critical error");
  });

  it("ignores critical errors in the reference arm", () => {
    const runs = syntheticGrid(dataset.cases).map((run) => run.configuration === REFERENCE && run.caseId === lookup.id ? { ...run, duplicateMutation: true } : run);
    expect(gate(runs).critical.casesWithCriticalError).toBe(0);
  });

  it("blocks when any deterministic check fails", () => {
    const clean = syntheticGrid(dataset.cases);
    const failing = (runs: readonly RawRun[], overrides: Partial<GateInput> = {}) => {
      const result = gate(runs, overrides);
      expect(result.decision).toBe("BLOCK");
      return result.checks.filter(({ passed }) => !passed).map(({ id }) => id);
    };
    expect(failing(clean.slice(1))).toContain("reference_repeats_complete");
    expect(failing([...clean, clean.find(({ configuration }) => configuration === CANDIDATE)!])).toEqual(["candidate_runs_unique"]);
    expect(failing(clean.map((run) => run.caseId === lookup.id ? { ...run, caseId: "v2-unknown-99", runId: `x:${run.runId}` } : run))).toEqual(["candidate_cases_known", "reference_cases_known"]);
    expect(failing(clean.filter((run) => !(run.configuration === CANDIDATE && run.caseId === lookup.id)))).toEqual(["arms_cover_same_cases"]);
    expect(failing(clean.map((run) => run.configuration === CANDIDATE && run.repeat === 4 ? { ...run, repeat: 9, runId: `${run.runId}:9` } : run))).toEqual(["candidate_repeats_complete"]);
    expect(failing(clean, { candidate: { source: "raw.jsonl", configuration: CANDIDATE, runs: clean, invalidRows: 2 } })).toEqual(["raw_rows_valid"]);
    expect(failing(clean, { datasetIntegrityVerified: false })).toEqual(["dataset_integrity"]);
    expect(failing(clean, { thresholds: { ...thresholds, severityRulesVersion: "severity-rules-v0" } })).toEqual(["severity_rules_version"]);
    expect(failing(clean, { candidate: { source: "raw.jsonl", configuration: "missing-arm", runs: clean, invalidRows: 0 } })).toEqual(expect.arrayContaining(["candidate_rows_present", "arms_cover_same_cases"]));
  });

  it("counts invalid rows once when both arms come from one file and twice for separate files", () => {
    const clean = syntheticGrid(dataset.cases);
    const separate = gate(clean, {
      candidate: { source: "candidate.jsonl", configuration: CANDIDATE, runs: clean, invalidRows: 1 },
      reference: { source: "baseline.jsonl", configuration: CANDIDATE, runs: clean, invalidRows: 1 },
    });
    expect(separate.checks.find(({ id }) => id === "raw_rows_valid")!.detail).toBe("2 rows failed schema validation");
    expect(separate.comparisons[0]).toMatchObject({ cases: 30, difference: 0 });
  });

  it("never passes below the minimum number of cases", () => {
    const smoke = syntheticGrid(dataset.cases.slice(0, 4));
    const result = gate(smoke);
    expect(result).toMatchObject({ decision: "INCONCLUSIVE", exitCode: 2, minimumCases: { required: 30, observed: 4, status: "INCONCLUSIVE" } });
    expect(result.reasons).toContain("INCONCLUSIVE: 4 cases is below the required minimum of 30.");
    // Zero critical errors in 4 cases bounds the rate only below 52.7%: too little to pass, no evidence to block.
    expect(result.critical).toMatchObject({ casesWithCriticalError: 0, status: "INCONCLUSIVE" });
    expect(result.reasons.some((reason) => reason.includes("needs 29 clean cases"))).toBe(true);
    expect(result.comparisons.find(({ metric }) => metric === "recovery")).toMatchObject({ status: "INCONCLUSIVE", cases: 0, difference: null });
  });

  it("blocks a small sample once a critical error is actually observed", () => {
    const smoke = syntheticGrid(dataset.cases.slice(0, 4)).map((run) => run.configuration === CANDIDATE && run.repeat === 0 && run.caseId === lookup.id ? { ...run, duplicateMutation: true } : run);
    expect(gate(smoke)).toMatchObject({ decision: "BLOCK", critical: { casesWithCriticalError: 1, status: "BLOCK" } });
  });

  it("lets BLOCK take precedence over INCONCLUSIVE", () => {
    expect(gate(regressed(6).filter(({ caseId }) => dataset.cases.slice(0, 12).some(({ id }) => id === caseId))).decision).toBe("BLOCK");
  });

  it("is deterministic and maps decisions to exit codes", () => {
    const runs = regressed(2);
    expect(JSON.stringify(gate(runs))).toBe(JSON.stringify(gate([...runs].reverse())));
    expect(GATE_EXIT_CODES).toEqual({ PASS: 0, BLOCK: 1, INCONCLUSIVE: 2 });
  });
});
