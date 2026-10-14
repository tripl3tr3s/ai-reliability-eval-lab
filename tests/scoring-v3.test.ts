import { describe, expect, it } from "vitest";
import { DatasetCaseV3Schema, type DatasetCaseV3 } from "../src/dataset.js";
import { classifyCriticalErrors } from "../src/gate/severity.js";
import { scoreRun, v3AnswerFailure, type RawRun } from "../src/scoring.js";

const UUID18 = "5b1e0c3a-7d2f-4a9b-8c6e-000000000018";

const datasetCase: DatasetCaseV3 = DatasetCaseV3Schema.parse({
  id: "v3-pagos-saldo-test",
  category: "lookup",
  language: "es-MX",
  domain: "pagos",
  fixture: "sat-v3",
  tags: ["pagos"],
  prompt: `¿Cuánto le falta pagar a Hotelera Laguna de la factura ${UUID18}?`,
  acceptedPlans: [{ id: "estado-pago", calls: [{ tool: "consultar-estado-de-pago", argumentMatchers: [{ path: "invoiceUuid", equals: UUID18 }] }] }],
  allowedExtraCalls: [{ tool: "consultar-trazabilidad-fiscal", maxCount: 1 }],
  forbiddenTools: ["rastrear-pago", "crear-complemento-pago"],
  expectedState: [],
  requiredAssertions: [[{ type: "amount", value: 100_000 }, { type: "text", includes: "saldo" }]],
  forbiddenClaims: ["totalmente pagada", "esta liquidada"],
  forbiddenValues: [{ type: "amount", value: 190_000 }, { type: "amount", value: 90_000 }],
  faultSchedule: [],
  recoveryExpectations: { mustRecover: false, noDuplicateMutation: true },
  metricApplicability: { completion: true, toolSelection: true, arguments: true, recovery: false, unsupportedClaims: true },
  referenceAnswer: "El saldo insoluto de la factura es de $100,000.00 MXN; se han pagado dos parcialidades.",
  counterexamples: [
    { kind: "wrong_value", answer: "El saldo insoluto es de 90,000 pesos." },
    { kind: "false_completion", answer: "La factura está totalmente pagada, saldo 100,000 cubierto." },
    { kind: "omission", answer: "La factura tiene pagos registrados." },
  ],
});

const run = (answer: string, toolCalls: RawRun["toolCalls"], extra: Partial<RawRun> = {}): RawRun => ({
  runId: "r", caseId: datasetCase.id, configuration: "prod-routed-5-5", repeat: 0, outcome: "completed", answer, finalState: {},
  claims: [], toolCalls, validEvidenceIds: [], latencyMs: 1, costUsd: 0, ...extra,
});
const planCall = { name: "consultar-estado-de-pago", input: { invoiceUuid: UUID18 }, evidenceId: "e1", success: true };

describe("v3 completion", () => {
  it("passes the reference answer and fails each counterexample for its stated reason", () => {
    expect(v3AnswerFailure(datasetCase.referenceAnswer, datasetCase)).toBeNull();
    expect(v3AnswerFailure(datasetCase.counterexamples[0]!.answer, datasetCase)).toBe("forbidden_value");
    expect(v3AnswerFailure(datasetCase.counterexamples[1]!.answer, datasetCase)).toBe("forbidden_claim");
    expect(v3AnswerFailure(datasetCase.counterexamples[2]!.answer, datasetCase)).toBe("missing_assertion");
  });

  it("does not accept a correct amount whose sentence is negated", () => {
    expect(v3AnswerFailure("El saldo no es 100,000.", datasetCase)).toBe("missing_assertion");
  });

  it("scores completion with the Spanish rules", () => {
    expect(scoreRun(run(datasetCase.referenceAnswer, [planCall]), datasetCase).completionPassed).toBe(true);
    expect(scoreRun(run("No está totalmente pagada; el saldo es 100,000.", [planCall]), datasetCase).completionPassed).toBe(true);
    expect(scoreRun(run("Está totalmente pagada; saldo 100,000.", [planCall]), datasetCase).completionPassed).toBe(false);
  });
});

describe("v3 tool accuracy with allowed extra reads", () => {
  it("accepts one declared extra read anywhere in the sequence", () => {
    const extra = { name: "consultar-trazabilidad-fiscal", input: { cfdiUuid: UUID18 }, evidenceId: "e0", success: true };
    expect(scoreRun(run(datasetCase.referenceAnswer, [extra, planCall]), datasetCase).headlineToolAccuracy).toBe(true);
    expect(scoreRun(run(datasetCase.referenceAnswer, [planCall, extra]), datasetCase).headlineToolAccuracy).toBe(true);
  });

  it("rejects extra reads beyond maxCount and undeclared extra reads", () => {
    const extra = { name: "consultar-trazabilidad-fiscal", input: { cfdiUuid: UUID18 }, evidenceId: "e0", success: true };
    const undeclared = { name: "consultar-estado-csd", input: { rfc: "HTL180505YZ4" }, evidenceId: "e2", success: true };
    expect(scoreRun(run(datasetCase.referenceAnswer, [extra, extra, planCall]), datasetCase).headlineToolAccuracy).toBe(false);
    expect(scoreRun(run(datasetCase.referenceAnswer, [undeclared, planCall]), datasetCase).headlineToolAccuracy).toBe(false);
  });

  it("still fails forbidden tools", () => {
    const write = { name: "rastrear-pago", input: {}, evidenceId: "e3", success: true };
    expect(scoreRun(run(datasetCase.referenceAnswer, [planCall, write]), datasetCase).selectionPassed).toBe(false);
  });
});

describe("v3 critical errors", () => {
  const writeTools = new Set(["rastrear-pago", "crear-complemento-pago"]);

  it("classifies a forbidden amount as wrong_value and a false payoff as forbidden_claim", () => {
    expect(classifyCriticalErrors(run("El saldo es 90,000.", [planCall]), datasetCase, writeTools)).toEqual(["wrong_value"]);
    expect(classifyCriticalErrors(run("Ya está liquidada.", [planCall]), datasetCase, writeTools)).toEqual(["forbidden_claim"]);
    expect(classifyCriticalErrors(run("No está liquidada; saldo 100,000.", [planCall]), datasetCase, writeTools)).toEqual([]);
  });

  it("does not flag a forbidden amount that is explicitly negated", () => {
    expect(classifyCriticalErrors(run("El saldo no es 90,000 sino 100,000.", [planCall]), datasetCase, writeTools)).toEqual([]);
  });
});

describe("v3 unsupported claims", () => {
  it("checks claim identifiers and amounts against the cited evidence facts", () => {
    const facts = { e1: [`consulta.invoiceUuid ${UUID18}`, "result.saldoInsoluto 100000", "result.total 290000"] };
    const supported = scoreRun(run(datasetCase.referenceAnswer, [planCall], { validEvidenceIds: ["e1"], evidenceFacts: facts, claims: [{ text: "El saldo insoluto es 100,000.", evidenceIds: ["e1"] }] }), datasetCase);
    expect(supported.unsupportedClaims).toBe(0);
    const unsupported = scoreRun(run(datasetCase.referenceAnswer, [planCall], { validEvidenceIds: ["e1"], evidenceFacts: facts, claims: [{ text: "Se pagaron 120,000.", evidenceIds: ["e1"] }, { text: "El saldo es 100,000.", evidenceIds: ["e9"] }] }), datasetCase);
    expect(unsupported.unsupportedClaims).toBe(2);
  });
});

describe("v3 schema rules", () => {
  it("requires confirmation cases to assert the pending confirmation", () => {
    expect(() => DatasetCaseV3Schema.parse({ ...datasetCase, id: "v3-confirmacion-x", category: "confirmation" })).toThrow("pending confirmation");
  });

  it("requires a wrong_value counterexample when forbidden values exist", () => {
    expect(() => DatasetCaseV3Schema.parse({ ...datasetCase, counterexamples: datasetCase.counterexamples.filter(({ kind }) => kind !== "wrong_value").concat({ kind: "negation", answer: "No hay saldo pendiente alguno." }) })).toThrow("wrong_value");
  });
});
