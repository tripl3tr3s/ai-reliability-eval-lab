import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelAdapter } from "../src/contracts.js";
import { loadExperimentConfig, runExperiment } from "../src/experiment.js";

describe("experiment orchestration", () => {
  it("runs a deterministic stratified smoke across all configurations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reliability-lab-"));
    const outputPath = join(directory, "results.jsonl");
    const adapter: ModelAdapter = {
      async generate(request) {
        const router = request.tools.length === 0;
        return {
          text: router
            ? "simple-read-only"
            : JSON.stringify({ outcome: "abstained", answer: "Insufficient synthetic evidence.", claims: [] }),
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.000001 },
          modelId: request.model,
          latencyMs: 1,
        };
      },
    };
    const config = await loadExperimentConfig("config/smoke.v1.json");
    const first = await runExperiment({ config, adapter, outputPath });
    expect(first).toHaveLength(24);
    expect(new Set(first.map(({ configuration }) => configuration))).toEqual(
      new Set(["direct-sonnet", "routed", "no-resource-injection"]),
    );
    expect((await readFile(outputPath, "utf8")).trim().split("\n")).toHaveLength(24);
  });
});
