import { describe, expect, it } from "vitest";
import { TERMINATION_REASONS } from "../src/contracts.js";
import { loadDataset } from "../src/dataset.js";
import { parseRawRuns } from "../src/raw-run.js";
import { syntheticRun, toJsonl } from "./helpers/synthetic.js";

const datasetCase = (await loadDataset("datasets/v2/manifest.json")).cases[0]!;

describe("raw run termination fields", () => {
  it("accepts every termination reason and a refusal category", () => {
    const rows = TERMINATION_REASONS.map((terminationReason, repeat) => syntheticRun(datasetCase, "routed", repeat, false, { outcome: "bounded", terminationReason }));
    const { runs, issues } = parseRawRuns(toJsonl([...rows, syntheticRun(datasetCase, "routed", 99, false, { outcome: "failed", terminationReason: "refusal", refusalCategory: "cyber" })]));
    expect(issues).toEqual([]);
    expect(runs.map(({ terminationReason }) => terminationReason)).toEqual([...TERMINATION_REASONS, "refusal"]);
    expect(runs.at(-1)?.refusalCategory).toBe("cyber");
  });

  it("still reads rows recorded before the fields existed", () => {
    const { runs, issues } = parseRawRuns(toJsonl([syntheticRun(datasetCase, "routed", 0, false, { outcome: "bounded" })]));
    expect(issues).toEqual([]);
    expect(runs[0]).not.toHaveProperty("terminationReason");
  });

  it("rejects an unknown reason and an empty or oversized refusal category", () => {
    const row = (overrides: Record<string, unknown>) => JSON.stringify({ ...syntheticRun(datasetCase, "routed", 0, false), ...overrides });
    const { issues } = parseRawRuns([row({ terminationReason: "provider_error" }), row({ refusalCategory: "" }), row({ refusalCategory: "x".repeat(65) })].join("\n"));
    expect(issues.map(({ line }) => line)).toEqual([1, 2, 3]);
  });
});
