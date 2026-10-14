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
