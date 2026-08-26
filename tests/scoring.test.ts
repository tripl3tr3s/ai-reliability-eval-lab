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

  it("supports query-scoped absence claims without supporting unrelated entities", () => {
    const facts = { missing: ["document INV-999 not found in available records", "result exists false"] };
    expect(scoreUnsupportedClaims(
      [
        { text: "INV-999 was not found in the available records", evidenceIds: ["missing"] },
        { text: "RFC99 owns the missing invoice", evidenceIds: ["missing"] },
      ],
      ["missing"],
      facts,
    )).toEqual({ unsupported: 1, checkable: 2 });
  });

  it("does not support a compound claim from a shared queried identifier alone", () => {
    expect(scoreUnsupportedClaims(
      [{ text: "INV-999 belongs to RFC99 and was paid", evidenceIds: ["missing"] }],
      ["missing"],
      { missing: ["document INV-999 not found in available records", "result exists false"] },
    )).toEqual({ unsupported: 1, checkable: 1 });
  });

  it("does not support an appended predicate when an earlier clause is supported", () => {
    expect(scoreUnsupportedClaims(
      [{ text: "INV-999 was not found and was paid", evidenceIds: ["missing"] }],
      ["missing"],
      { missing: ["document INV-999 not found in available records", "result exists false"] },
    )).toEqual({ unsupported: 1, checkable: 1 });
  });

  it("does not treat an explicitly negated forbidden phrase as the forbidden claim", async () => {
    const datasetCase = (await loadDataset()).cases.find(({ id }) => id === "v1-multi-policy-13")!;
    const run: RawRun = {
      runId: "policy",
      caseId: datasetCase.id,
      configuration: "direct-sonnet",
      repeat: 0,
      outcome: "completed",
      answer: "Review is required. Do not approve automatically.",
      finalState: { followUps: [], matchedPayments: {} },
      claims: [{ text: "Do not approve automatically; review is required.", evidenceIds: ["policy"] }],
      validEvidenceIds: ["policy"],
      evidenceFacts: { policy: ["supplier risk policy review required", "policy does not authorize automatic approval"] },
      toolCalls: [],
      costUsd: 0.01,
      latencyMs: 100,
    };
    expect(scoreRun(run, datasetCase)).toMatchObject({ completionPassed: true, unsupportedClaims: 0 });
  });

  it.each([
    ["v1-lookup-policy-06", "Review is required. The policy does not authorize automatic payment."],
    ["v1-multi-risk-12", "Risk requires review; the evidence does not establish guaranteed fraud."],
    ["v1-multi-carousel-17", "A carousel signal exists, but it does not establish confirmed crime."],
    ["v1-abstain-conflict-30", "There is insufficient evidence and it does not prove RFC30 committed fraud."],
  ])("keeps scoped negation from triggering forbidden claims for %s", async (caseId, answer) => {
    const datasetCase = (await loadDataset()).cases.find(({ id }) => id === caseId)!;
    const run: RawRun = {
      runId: caseId,
      caseId,
      configuration: "direct-sonnet",
      repeat: 0,
      outcome: caseId.includes("abstain") ? "abstained" : "completed",
      answer,
      finalState: { followUps: [], matchedPayments: {} },
      claims: [],
      validEvidenceIds: [],
      toolCalls: [],
      costUsd: 0.01,
      latencyMs: 100,
    };
    expect(scoreRun(run, datasetCase).completionPassed).toBe(true);
  });

  it.each([
    ["v1-lookup-document-01", "Invoice 1160 is not cancelled and it is paid.", "completed"],
    ["v1-lookup-status-08", "The status is clear and not definitive but the supplier is blocked.", "completed"],
    ["v1-abstain-missing-29", "There is insufficient evidence because no document was found and RFC99 owns it.", "abstained"],
  ] as const)("still rejects an affirmative forbidden claim after unrelated negation for %s", async (caseId, answer, outcome) => {
    const datasetCase = (await loadDataset()).cases.find(({ id }) => id === caseId)!;
    const run: RawRun = {
      runId: caseId,
      caseId,
      configuration: "direct-sonnet",
      repeat: 0,
      outcome,
      answer,
      finalState: { followUps: [], matchedPayments: {} },
      claims: [],
      validEvidenceIds: [],
      toolCalls: [],
      costUsd: 0.01,
      latencyMs: 100,
    };
    expect(scoreRun(run, datasetCase).completionPassed).toBe(false);
  });

  it.each([
    ["v1-lookup-document-01", "Invoice 1160 remains unpaid."],
    ["v1-multi-payment-16", "The payment covered the invoice total but remains unmatched."],
  ])("does not match forbidden phrases inside different words for %s", async (caseId, answer) => {
    const datasetCase = (await loadDataset()).cases.find(({ id }) => id === caseId)!;
    const run: RawRun = {
      runId: caseId,
      caseId,
      configuration: "direct-sonnet",
      repeat: 0,
      outcome: "completed",
      answer,
      finalState: { followUps: [], matchedPayments: {} },
      claims: [],
      validEvidenceIds: [],
      toolCalls: [],
      costUsd: 0.01,
      latencyMs: 100,
    };
    expect(scoreRun(run, datasetCase).completionPassed).toBe(true);
  });

  it("recognizes contracted negation around a forbidden claim", async () => {
    const datasetCase = (await loadDataset()).cases.find(({ id }) => id === "v1-lookup-document-01")!;
    const run: RawRun = {
      runId: "contracted-forbidden",
      caseId: datasetCase.id,
      configuration: "direct-sonnet",
      repeat: 0,
      outcome: "completed",
      answer: "Invoice 1160 isn't paid.",
      finalState: { followUps: [], matchedPayments: {} },
      claims: [],
      validEvidenceIds: [],
      toolCalls: [{ name: "get_document", input: { documentId: "INV-001" } }],
      costUsd: 0.01,
      latencyMs: 100,
    };
    expect(scoreRun(run, datasetCase).completionPassed).toBe(true);
  });

  it("produces deterministic confidence intervals and denominator-aware aggregates", () => {
    expect(bootstrapCi([0, 1, 1], 42)).toEqual(bootstrapCi([0, 1, 1], 42));
    const summary = aggregateScores([{ runId: "r", caseId: "c", configuration: "routed", repeat: 0, selectionPassed: true, argumentFieldsMatched: 1, argumentFieldsTotal: 2, argumentAccuracy: 0.5, headlineToolAccuracy: false, completionPassed: true, recoveryPassed: null, unsupportedClaims: 1, checkableClaims: 2, unsupportedClaimRate: 0.5, costUsd: 0.2, latencyMs: 20, matchedPlanId: null }]);
    expect(summary[0]?.argumentAccuracy).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
    expect(summary[0]?.costPerSuccessfulTask.value).toBe(0.2);
  });

  it("scores v2 alternative plans with their own argument matchers", async () => {
    const dataset = await loadDataset(new URL("../datasets/v2/manifest.json", import.meta.url).pathname);
    const datasetCase = dataset.cases.find(({ id }) => id === "v2-lookup-document-01")!;
    const run: RawRun = {
      runId: "search",
      caseId: datasetCase.id,
      configuration: "routed",
      repeat: 0,
      outcome: "completed",
      answer: "Invoice INV-001 has a total of 1,160 MXN.",
      finalState: { followUps: [], matchedPayments: {} },
      claims: [],
      validEvidenceIds: [],
      toolCalls: [{ name: "search_documents", input: { query: "INV-001", documentType: "invoice" }, success: true }],
      costUsd: 0.01,
      latencyMs: 100,
    };
    expect(scoreRun(run, datasetCase)).toMatchObject({
      selectionPassed: true,
      argumentAccuracy: 1,
      headlineToolAccuracy: true,
      completionPassed: true,
      matchedPlanId: "search-by-id",
    });
  });

  it("accepts a declared policy read but rejects irrelevant extra reads", async () => {
    const dataset = await loadDataset(new URL("../datasets/v2/manifest.json", import.meta.url).pathname);
    const datasetCase = dataset.cases.find(({ id }) => id === "v2-multi-match-11")!;
    const base: RawRun = {
      runId: "match",
      caseId: datasetCase.id,
      configuration: "direct-sonnet",
      repeat: 0,
      outcome: "completed",
      answer: "The payment was previously unmatched, then successfully matched.",
      finalState: { followUps: [], matchedPayments: { "PAY-011": "INV-011" } },
      claims: [],
      validEvidenceIds: [],
      toolCalls: [
        { name: "get_document", input: { documentId: "INV-011" } },
        { name: "list_payments", input: { documentId: "INV-011" } },
        { name: "get_operational_policy", input: { policyId: "payment-reconciliation" } },
        { name: "match_payment", input: { paymentId: "PAY-011", documentId: "INV-011", idempotencyKey: "match-11" } },
      ],
      costUsd: 0.01,
      latencyMs: 100,
    };
    expect(scoreRun(base, datasetCase)).toMatchObject({ selectionPassed: true, argumentAccuracy: 1, matchedPlanId: "policy-before-write", completionPassed: true });
    expect(scoreRun({ ...base, toolCalls: [...base.toolCalls.slice(0, 3), { name: "check_supplier_status", input: { rfc: "RFC11" } }, base.toolCalls[3]!] }, datasetCase).selectionPassed).toBe(false);
  });

  it("accepts v2 abstention paraphrases and the two-call not-found recovery plan", async () => {
    const dataset = await loadDataset(new URL("../datasets/v2/manifest.json", import.meta.url).pathname);
    const abstention = dataset.cases.find(({ id }) => id === "v2-abstain-missing-29")!;
    const abstainedRun: RawRun = {
      runId: "missing",
      caseId: abstention.id,
      configuration: "direct-sonnet",
      repeat: 0,
      outcome: "abstained",
      answer: "The owner cannot be determined from available evidence.",
      finalState: { followUps: [], matchedPayments: {} },
      claims: [],
      validEvidenceIds: [],
      toolCalls: [{ name: "get_document", input: { documentId: "INV-999" } }],
      costUsd: 0.01,
      latencyMs: 100,
    };
    expect(scoreRun(abstainedRun, abstention)).toMatchObject({ completionPassed: true, selectionPassed: true, argumentAccuracy: 1 });

    const recovery = dataset.cases.find(({ id }) => id === "v2-recovery-notfound-25")!;
    const recoveredRun: RawRun = {
      ...abstainedRun,
      runId: "recovered",
      caseId: recovery.id,
      outcome: "completed",
      answer: "INV-025 was recovered through search.",
      toolCalls: [
        { name: "get_document", input: { documentId: "INV-025" }, success: false },
        { name: "search_documents", input: { query: "INV-025" }, success: true },
      ],
      policyViolation: false,
    };
    expect(scoreRun(recoveredRun, recovery)).toMatchObject({ completionPassed: true, selectionPassed: true, argumentAccuracy: 1, recoveryPassed: true, matchedPlanId: "search-recovers" });
  });

  it("requires the category outcome and rejects negated required assertions", async () => {
    const dataset = await loadDataset(new URL("../datasets/v2/manifest.json", import.meta.url).pathname);
    const status = dataset.cases.find(({ id }) => id === "v2-lookup-status-05")!;
    const statusRun: RawRun = {
      runId: "status",
      caseId: status.id,
      configuration: "direct-sonnet",
      repeat: 0,
      outcome: "completed",
      answer: "RFC05 is presumed.",
      finalState: { followUps: [], matchedPayments: {} },
      claims: [],
      validEvidenceIds: [],
      toolCalls: [{ name: "check_supplier_status", input: { rfc: "RFC05" } }],
      costUsd: 0.01,
      latencyMs: 100,
    };
    expect(scoreRun(statusRun, status).completionPassed).toBe(true);
    expect(scoreRun({ ...statusRun, answer: "RFC05 is not presumed." }, status).completionPassed).toBe(false);
    expect(scoreRun({ ...statusRun, answer: "RFC05 isn't presumed." }, status).completionPassed).toBe(false);
    expect(scoreRun({ ...statusRun, answer: "RFC05 wasn't presumed." }, status).completionPassed).toBe(false);
    expect(scoreRun({ ...statusRun, outcome: "abstained" }, status).completionPassed).toBe(false);

    const abstention = dataset.cases.find(({ id }) => id === "v2-abstain-missing-29")!;
    expect(scoreRun({ ...statusRun, caseId: abstention.id, outcome: "abstained", answer: "I can't determine the owner.", toolCalls: [{ name: "get_document", input: { documentId: "INV-999" } }] }, abstention).completionPassed).toBe(true);
    expect(scoreRun({ ...statusRun, caseId: abstention.id, outcome: "completed", answer: "There is no evidence.", toolCalls: [{ name: "get_document", input: { documentId: "INV-999" } }] }, abstention).completionPassed).toBe(false);
  });

  it("preserves v1 completion compatibility for abstained outcomes", async () => {
    const datasetCase = (await loadDataset()).cases[0]!;
    const run: RawRun = {
      runId: "legacy-abstained",
      caseId: datasetCase.id,
      configuration: "direct-sonnet",
      repeat: 0,
      outcome: "abstained",
      answer: "The total is 1160.",
      finalState: {},
      claims: [],
      validEvidenceIds: [],
      toolCalls: [{ name: "get_document", input: { documentId: "INV-001" } }],
      costUsd: 0.01,
      latencyMs: 100,
    };
    expect(scoreRun(run, datasetCase).completionPassed).toBe(true);
  });
});
