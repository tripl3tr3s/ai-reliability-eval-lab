import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DatasetCaseV2Schema, loadDataset } from "../src/dataset.js";
import { documents, payments } from "../src/fixtures.js";
import { createSyntheticTools } from "../src/tools.js";
import { zodToJsonSchema } from "zod-to-json-schema";

describe("dataset", () => {
  it("loads the immutable 30-case distribution", async () => {
    const dataset = await loadDataset();
    expect(dataset.cases).toHaveLength(30);
    expect(dataset.cases.filter(({ category }) => category === "lookup")).toHaveLength(10);
    expect(dataset.cases.filter(({ category }) => category === "multi_tool")).toHaveLength(10);
    expect(dataset.cases.filter(({ category }) => category === "recovery")).toHaveLength(8);
    expect(dataset.cases.filter(({ category }) => category === "abstention")).toHaveLength(2);
    expect(dataset.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects content changed after manifest publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eval-dataset-"));
    const originalManifest = new URL("../datasets/v1/manifest.json", import.meta.url);
    const originalCases = new URL("../datasets/v1/cases.jsonl", import.meta.url);
    await writeFile(join(directory, "manifest.json"), await readFile(originalManifest, "utf8"));
    await writeFile(join(directory, "cases.jsonl"), `${await readFile(originalCases, "utf8")}\n`);
    await expect(loadDataset(join(directory, "manifest.json"))).rejects.toThrow("Dataset hash mismatch");
  });

  it("loads the v2 semantic assertion and accepted-plan contract", async () => {
    const dataset = await loadDataset(new URL("../datasets/v2/manifest.json", import.meta.url).pathname);
    expect(dataset.version).toBe("v2");
    expect(dataset.cases).toHaveLength(30);
    expect(dataset.cases.every(({ id }) => id.startsWith("v2-"))).toBe(true);

    for (const datasetCase of dataset.cases) {
      if (!("acceptedPlans" in datasetCase)) throw new Error(`${datasetCase.id} did not load as v2`);
      expect(datasetCase.acceptedPlans.length, datasetCase.id).toBeGreaterThan(0);
      expect(datasetCase.requiredAssertions.length, datasetCase.id).toBeGreaterThan(0);
      expect(new Set(datasetCase.acceptedPlans.map(({ id }) => id)).size, datasetCase.id).toBe(datasetCase.acceptedPlans.length);
    }
  });

  it("rejects tampered v2 content against its published manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eval-dataset-v2-"));
    const originalManifest = new URL("../datasets/v2/manifest.json", import.meta.url);
    const originalCases = new URL("../datasets/v2/cases.jsonl", import.meta.url);
    await writeFile(join(directory, "manifest.json"), await readFile(originalManifest, "utf8"));
    await writeFile(join(directory, "cases.jsonl"), `${await readFile(originalCases, "utf8")}\n`);
    await expect(loadDataset(join(directory, "manifest.json"))).rejects.toThrow("Dataset hash mismatch");
  });

  it("keeps every v2 accepted plan executable against tool argument contracts", async () => {
    const dataset = await loadDataset(new URL("../datasets/v2/manifest.json", import.meta.url).pathname);
    const tools = new Map(createSyntheticTools().map((tool) => [tool.name, tool]));

    for (const datasetCase of dataset.cases) {
      if (!("acceptedPlans" in datasetCase)) throw new Error(`${datasetCase.id} did not load as v2`);
      for (const plan of datasetCase.acceptedPlans) {
        for (const call of plan.calls) {
          const tool = tools.get(call.tool);
          expect(tool, `${datasetCase.id}:${plan.id}:${call.tool}`).toBeDefined();
          expect(call.argumentMatchers.length, `${datasetCase.id}:${plan.id}:${call.tool}`).toBeGreaterThan(0);
          const schema = zodToJsonSchema(tool!.inputSchema, { $refStrategy: "none" }) as { properties?: Record<string, unknown> };
          for (const matcher of call.argumentMatchers) {
            expect(schema.properties, `${datasetCase.id}:${plan.id}:${call.tool}.${matcher.path}`).toHaveProperty(matcher.path.split(".")[0]!);
          }
        }
      }
    }

    const recovery25 = dataset.cases.find(({ id }) => id === "v2-recovery-notfound-25");
    const match11 = dataset.cases.find(({ id }) => id === "v2-multi-match-11");
    if (!recovery25 || !("acceptedPlans" in recovery25) || !match11 || !("acceptedPlans" in match11)) {
      throw new Error("Expected v2 audit cases were not loaded");
    }
    expect(recovery25.acceptedPlans.map(({ calls }) => calls.length)).toEqual([2, 3]);
    expect(match11.acceptedPlans[0]!.calls.at(-1)!.argumentMatchers).toContainEqual({ path: "idempotencyKey", operator: "nonempty" });
  });

  it("rejects equals matchers that omit the equals value", () => {
    expect(DatasetCaseV2Schema.safeParse({
      id: "v2-invalid-matcher",
      category: "lookup",
      fixture: "fiscal-base",
      tags: ["lookup"],
      prompt: "Retrieve one synthetic document.",
      acceptedPlans: [{ id: "primary", ordered: true, calls: [{ tool: "get_document", argumentMatchers: [{ path: "documentId" }] }] }],
      forbiddenTools: [],
      expectedState: [],
      requiredAssertions: [[{ type: "text", includes: "found" }]],
      forbiddenClaims: [],
      faultSchedule: [],
      recoveryExpectations: { mustRecover: false, noDuplicateMutation: true },
      metricApplicability: { completion: true, toolSelection: true, arguments: true, recovery: false, unsupportedClaims: true },
    }).success).toBe(false);
  });

  it("keeps every published case executable against the tool and fixture contracts", async () => {
    const dataset = await loadDataset();
    const tools = new Map(createSyntheticTools().map((tool) => [tool.name, tool]));
    const documentIds = new Set<string>(documents.map(({ id }) => id));
    const paymentIds = new Set<string>(payments.map(({ id }) => id));

    for (const datasetCase of dataset.cases) {
      if (!("acceptedToolPatterns" in datasetCase)) throw new Error(`${datasetCase.id} did not load as v1`);
      const referencedTools = [
        ...datasetCase.acceptedToolPatterns.flatMap(({ tools: names }) => names),
        ...datasetCase.forbiddenTools,
        ...datasetCase.faultSchedule.map(({ tool }) => tool),
        ...datasetCase.argumentMatchers.map(({ tool }) => tool),
      ];
      expect(referencedTools.every((name) => tools.has(name)), datasetCase.id).toBe(true);

      for (const matcher of datasetCase.argumentMatchers) {
        const tool = tools.get(matcher.tool)!;
        const schema = zodToJsonSchema(tool.inputSchema, { $refStrategy: "none" }) as { properties?: Record<string, unknown> };
        expect(schema.properties, `${datasetCase.id}:${matcher.tool}.${matcher.path}`).toHaveProperty(matcher.path.split(".")[0]!);
      }

      for (const assertion of datasetCase.expectedState) {
        expect(["followUps", "matchedPayments"], `${datasetCase.id}:${assertion.path}`).toContain(assertion.path.split(".")[0]);
      }

      const documentReferences = datasetCase.prompt.match(/INV-\d{3}/gu) ?? [];
      for (const id of documentReferences.filter((value) => value !== "INV-999")) {
        expect(documentIds.has(id), `${datasetCase.id}:${id}`).toBe(true);
      }
      const paymentReferences = datasetCase.prompt.match(/PAY-\d{3}/gu) ?? [];
      for (const id of paymentReferences) expect(paymentIds.has(id), `${datasetCase.id}:${id}`).toBe(true);
    }
  });
});
