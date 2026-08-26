import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelAdapter } from "../src/contracts.js";
import { extractEvidenceFacts, extractToolCalls, loadExperimentConfig, runExperiment } from "../src/experiment.js";
import { operationalResourceText } from "../src/fixtures.js";

describe("experiment orchestration", () => {
  it("gives execution models the exact final-result contract", async () => {
    const seenSystemPrompts: string[] = [];
    const adapter: ModelAdapter = {
      async generate(request) {
        const system = request.messages.find(({ role }) => role === "system")?.content;
        if (system) seenSystemPrompts.push(system);
        return {
          text: JSON.stringify({ outcome: "abstained", answer: "Insufficient evidence.", claims: [] }),
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.000001 },
          modelId: request.model,
          latencyMs: 1,
        };
      },
    };
    const config = await loadExperimentConfig("config/smoke.v2.json");
    await runExperiment({ config: { ...config, configurations: ["direct-sonnet"], repeats: 1 }, adapter, outputPath: join(await mkdtemp(join(tmpdir(), "reliability-lab-")), "results.jsonl") });
    expect(seenSystemPrompts).not.toHaveLength(0);
    expect(seenSystemPrompts.every((prompt) => prompt.includes('"outcome":"completed"|"abstained"'))).toBe(true);
    expect(seenSystemPrompts.every((prompt) => prompt.includes('"claim":"string"'))).toBe(true);
    expect(seenSystemPrompts.every((prompt) => prompt.includes("no Markdown fences"))).toBe(true);
    expect(seenSystemPrompts.every((prompt) => prompt.includes(operationalResourceText))).toBe(true);
  });

  it("retains typed failed tool attempts in the scored call sequence", () => {
    const calls = extractToolCalls([
      { sequence: 1, type: "error", at: new Date(0).toISOString(), payload: { runId: "r", name: "check_supplier_status", message: "timeout" } },
      { sequence: 2, type: "tool", at: new Date(0).toISOString(), payload: { runId: "r", name: "check_supplier_status", input: { rfc: "RFC22" }, result: { ok: false, error: { code: "TIMEOUT" }, evidenceId: "r:check_supplier_status:1" } } },
      { sequence: 3, type: "tool", at: new Date(0).toISOString(), payload: { runId: "r", name: "check_supplier_status", input: { rfc: "RFC22" }, result: { ok: true, data: { status: "clear" }, evidenceId: "r:check_supplier_status:2" } } },
    ]);
    expect(calls).toEqual([
      { name: "check_supplier_status", input: { rfc: "RFC22" }, evidenceId: "r:check_supplier_status:1", success: false },
      { name: "check_supplier_status", input: { rfc: "RFC22" }, evidenceId: "r:check_supplier_status:2", success: true },
    ]);
  });

  it("records query-aware negative and failed evidence facts", () => {
    const facts = extractEvidenceFacts([
      { sequence: 1, type: "tool", at: new Date(0).toISOString(), payload: { runId: "r", name: "get_document", input: { documentId: "INV-999" }, result: { ok: true, data: null, evidenceId: "missing" } } },
      { sequence: 2, type: "tool", at: new Date(0).toISOString(), payload: { runId: "r", name: "search_documents", input: { query: "INV-999" }, result: { ok: true, data: [], evidenceId: "empty" } } },
      { sequence: 3, type: "tool", at: new Date(0).toISOString(), payload: { runId: "r", name: "get_document", input: { documentId: "INV-021" }, result: { ok: false, error: { code: "TRANSIENT", message: "retry", retryable: true }, evidenceId: "failed" } } },
    ]);
    expect(facts.missing).toContain("document INV-999 not found in available records");
    expect(facts.empty).toEqual(expect.arrayContaining(["zero documents found", "query.query INV-999"]));
    expect(facts.failed).toEqual(expect.arrayContaining(["tool get_document failed", "error.code TRANSIENT", "query.documentId INV-021"]));
  });

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
    const config = await loadExperimentConfig("config/smoke.v2.json");
    const first = await runExperiment({ config, adapter, outputPath });
    expect(first).toHaveLength(24);
    expect(new Set(first.map(({ configuration }) => configuration))).toEqual(
      new Set(["direct-sonnet", "routed", "no-resource-injection"]),
    );
    expect((await readFile(outputPath, "utf8")).trim().split("\n")).toHaveLength(24);
  });

  it("records successful tool data as evidence facts", async () => {
    const adapter: ModelAdapter = {
      async generate(request) {
        const isLookup = request.messages.some(({ content }) => content.includes("INV-001"));
        const hasToolResult = request.messages.some(({ role }) => role === "tool");
        return isLookup && !hasToolResult
          ? {
              text: "",
              toolCalls: [{ id: "call-1", name: "get_document", input: { documentId: "INV-001" } }],
              stopReason: "tool_use",
              usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.000001 },
              modelId: request.model,
              latencyMs: 1,
            }
          : {
              text: JSON.stringify({ outcome: "completed", answer: "The total is 1160.", claims: [{ claim: "The total is 1160.", evidenceIds: ["v2-lookup-document-01:get_document:1"] }] }),
              toolCalls: [],
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.000001 },
              modelId: request.model,
              latencyMs: 1,
            };
      },
    };
    const config = await loadExperimentConfig("config/smoke.v2.json");
    const runs = await runExperiment({ config: { ...config, configurations: ["direct-sonnet"], repeats: 1 }, adapter, outputPath: join(await mkdtemp(join(tmpdir(), "reliability-lab-")), "results.jsonl") });
    const lookup = runs.find(({ caseId }) => caseId === "v2-lookup-document-01");
    expect(lookup?.evidenceFacts?.["v2-lookup-document-01:get_document:1"]).toContain("result.total 1160");
  });
});
