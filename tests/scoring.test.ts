import { describe, expect, it } from "vitest";
import { loadDataset } from "../src/dataset.js";
import { aggregateScores, bootstrapCi, scoreRun, scoreUnsupportedClaims, type RawRun } from "../src/scoring.js";

describe("scoring", () => {
  it("scores selection, fields, completion, and evidence", async () => {
    const datasetCase = (await loadDataset()).cases[0]!;
    const run: RawRun = { runId: "r1", caseId: datasetCase.id, configuration: "direct-sonnet", repeat: 0, outcome: "completed", answer: "The total is 1160.", finalState: {}, claims: [{ text: "total", evidenceIds: ["ev-1"] }], validEvidenceIds: ["ev-1"], toolCalls: [{ name: "get_document", input: { documentId: "INV-001" } }], costUsd: 0.01, latencyMs: 100 };
    expect(scoreRun(run, datasetCase)).toMatchObject({ selectionPassed: true, argumentAccuracy: 1, headlineToolAccuracy: true, completionPassed: true, unsupportedClaimRate: 0 });
  });

  it("marks missing and invalid evidence unsupported", () => {
    expect(scoreUnsupportedClaims([{ text: "a", evidenceIds: [] }, { text: "b", evidenceIds: ["bad"] }, { text: "c", evidenceIds: ["good"] }], ["good"])).toEqual({ unsupported: 2, checkable: 3 });
  });

  it("rejects evidence links whose facts do not support or contradict the claim", () => {
    expect(scoreUnsupportedClaims(
      [{ text: "RFC05 is definitive", evidenceIds: ["ev"] }, { text: "Invoice total is 1160", evidenceIds: ["amount"] }],
      ["ev", "amount"],
      { ev: ["RFC05 status is presumed"], amount: ["invoice total 1160"] },
      ["definitive"],
    )).toEqual({ unsupported: 1, checkable: 2 });
  });

  it("produces deterministic confidence intervals and denominator-aware aggregates", () => {
    expect(bootstrapCi([0, 1, 1], 42)).toEqual(bootstrapCi([0, 1, 1], 42));
    const summary = aggregateScores([{ runId: "r", caseId: "c", configuration: "routed", repeat: 0, selectionPassed: true, argumentFieldsMatched: 1, argumentFieldsTotal: 2, argumentAccuracy: 0.5, headlineToolAccuracy: false, completionPassed: true, recoveryPassed: null, unsupportedClaims: 1, checkableClaims: 2, unsupportedClaimRate: 0.5, costUsd: 0.2, latencyMs: 20 }]);
    expect(summary[0]?.argumentAccuracy).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
    expect(summary[0]?.costPerSuccessfulTask.value).toBe(0.2);
  });
});
