import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CATEGORY_COUNTS, DatasetCaseV3Schema, loadDataset, sha256, type DatasetCaseV3 } from "../src/dataset.js";
import { writeToolNames } from "../src/packs/index.js";
import { buildV3Cases, serializeCases } from "../src/packs/sat-v3/dataset/index.js";
import { satV3Pack } from "../src/packs/sat-v3/index.js";
import { ADVANCED_DOMAINS } from "../src/packs/sat-v3/router.js";
import { v3AnswerFailure } from "../src/scoring.js";

const cases = buildV3Cases();
const toolNames = new Set(satV3Pack.createTools().map(({ name }) => name));
const writes = writeToolNames(satV3Pack);

const setPath = (target: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> => {
  const [head, ...rest] = path.split(".");
  if (rest.length === 0) return { ...target, [head!]: value };
  const child = (target[head!] ?? {}) as Record<string, unknown>;
  return { ...target, [head!]: setPath(child, rest.join("."), value) };
};

describe("dataset v3 contents", () => {
  it("has 90 schema-valid cases with the declared category counts", () => {
    expect(cases).toHaveLength(90);
    for (const datasetCase of cases) expect(() => DatasetCaseV3Schema.parse(datasetCase)).not.toThrow();
    const counts = Object.fromEntries(Object.keys(CATEGORY_COUNTS.v3).map((category) => [category, cases.filter((item) => item.category === category).length]));
    expect(counts).toEqual(CATEGORY_COUNTS.v3);
  });

  it("has unique ids and unique prompts", () => {
    expect(new Set(cases.map(({ id }) => id)).size).toBe(90);
    expect(new Set(cases.map(({ prompt }) => prompt)).size).toBe(90);
  });

  it("routes at least 35 percent of cases to the advanced tier so both production tiers are exercised", () => {
    const advanced = cases.filter(({ domain }) => ADVANCED_DOMAINS.has(domain)).length;
    expect(advanced / cases.length).toBeGreaterThanOrEqual(0.35);
    expect(advanced / cases.length).toBeLessThanOrEqual(0.75);
  });

  it("commits the generated cases byte for byte, with a matching manifest hash", async () => {
    const committed = await readFile("datasets/v3/cases.jsonl", "utf8");
    expect(committed).toBe(serializeCases(cases));
    const bundle = await loadDataset("datasets/v3/manifest.json");
    expect(bundle.version).toBe("v3");
    expect(bundle.hash).toBe(sha256(committed));
  });
});

describe.each(cases.map((datasetCase) => [datasetCase.id, datasetCase] as const))("%s", (_id, datasetCase: DatasetCaseV3) => {
  it("passes its reference answer", () => {
    expect(v3AnswerFailure(datasetCase.referenceAnswer, datasetCase)).toBeNull();
  });

  it("fails every counterexample", () => {
    for (const { kind, answer } of datasetCase.counterexamples) {
      expect(v3AnswerFailure(answer, datasetCase), `${kind}: ${answer}`).not.toBeNull();
    }
  });

  it("uses no lone generic word as an assertion", () => {
    for (const alternative of datasetCase.requiredAssertions) {
      // Amounts, identifiers, and text carrying a date or number ("2026-11-02", "32 dias") are specific.
      const specific = alternative.some((term) => term.type !== "text" || /\d/u.test(term.includes));
      const multiword = alternative.every((term) => term.type !== "text" || term.includes.trim().split(/\s+/u).length >= 2);
      expect(specific || multiword, JSON.stringify(alternative)).toBe(true);
    }
  });

  it("names only pack tools, allows only extra reads, and forbids only writes", () => {
    for (const { calls } of datasetCase.acceptedPlans) for (const { tool } of calls) expect(toolNames.has(tool), tool).toBe(true);
    for (const { tool } of datasetCase.allowedExtraCalls) {
      expect(toolNames.has(tool), tool).toBe(true);
      expect(writes.has(tool), `extra ${tool} is a write`).toBe(false);
    }
    for (const tool of datasetCase.forbiddenTools) expect(writes.has(tool), `forbidden ${tool} is not a write`).toBe(true);
  });

  it("asserts final state whenever an accepted plan writes", () => {
    const writesSomething = datasetCase.acceptedPlans.some(({ calls }) => calls.some(({ tool }) => writes.has(tool)));
    if (writesSomething) expect(datasetCase.expectedState.length).toBeGreaterThan(0);
  });
});

describe("abstention cases rest on tool-established negative evidence", () => {
  it.each(cases.filter(({ category }) => category === "abstention").map((datasetCase) => [datasetCase.id, datasetCase] as const))("%s", async (_id, datasetCase) => {
    const state = satV3Pack.createState();
    const tools = satV3Pack.createTools();
    const [first] = datasetCase.acceptedPlans[0]!.calls;
    const input = first!.argumentMatchers.reduce<Record<string, unknown>>((acc, matcher) => setPath(acc, matcher.path, "operator" in matcher ? matcher.example : matcher.equals), {});
    const tool = tools.find(({ name }) => name === first!.tool)!;
    const result = await tool.execute(input, { caseId: datasetCase.id, seed: 1, invocation: 1, state, signal: new AbortController().signal });
    expect(result.ok).toBe(true);
    const data = (result as { data: unknown }).data;
    expect(data === null || (Array.isArray(data) && data.length === 0)).toBe(true);
  });
});

/** Correct answers that an earlier matcher version rejected (code review of 2026-10-14). They must pass. */
const ACCEPTED_PARAPHRASES: Readonly<Record<string, readonly string[]>> = {
  "v3-recuperacion-timeout-saldo-46": ["De la factura por $116,000.00 pesos se han pagado $50,000.00, por lo que el saldo es de $66,000.00 pesos."],
  "v3-recuperacion-desactualizado-saldo-49": ["La factura de $290,000 pesos lleva $190,000 pagados en dos parcialidades; el saldo es $100,000."],
  "v3-multi-rep-faltante-23": ["Ha pagado $190,000 en dos pagos; todavía debe $100,000 y el pago de $90,000 está sin complemento de pago."],
  "v3-confirmacion-rep-segunda-parcialidad-79": ["De la factura de $290,000 MXN preparé el complemento por $90,000.00, que quedó pendiente de confirmación."],
  "v3-recuperacion-transitorio-factura-45": ["La primera consulta no se pudo hacer por un error transitorio; al reintentar, la factura está vigente por $11,600.00."],
  "v3-recuperacion-pago-respuesta-perdida-51": ["El pago de $30,000.00 quedó registrado como parcialidad 2 y el saldo insoluto es $36,000.00. No se registró dos veces."],
  "v3-confirmacion-nota-factura-cancelada-88": ["No puedo crear la nota porque el CFDI 5b1e0c3a-7d2f-4a9b-8c6e-000000000024 está cancelado."],
  "v3-confirmacion-rep-factura-pue-87": ["Esa factura no requiere complemento de pago porque es PUE."],
  "v3-confirmacion-cancelar-recibida-90": ["No puedo cancelarla porque solo el emisor puede cancelar un CFDI."],
  "v3-confirmacion-cancelar-sin-folio-82": ["No puedo cancelar sin el folio fiscal del CFDI que la sustituye."],
  "v3-confirmacion-nota-excede-saldo-78": ["No puedo crear la nota porque excede el saldo acreditable de $8,120.00."],
  "v3-consulta-saldo-sin-pagos-20": ["No hay pagos registrados; el saldo es $34,800."],
  "v3-consulta-factura-liquidada-04": ["Sí, la factura está pagada por completo."],
};

describe("paraphrases found in code review are accepted", () => {
  it.each(Object.entries(ACCEPTED_PARAPHRASES).flatMap(([caseId, answers]) => answers.map((answer) => [caseId, answer] as const)))("%s: %s", (caseId, answer) => {
    const datasetCase = cases.find(({ id }) => id === caseId);
    expect(datasetCase, caseId).toBeDefined();
    expect(v3AnswerFailure(answer, datasetCase!)).toBeNull();
  });
});
