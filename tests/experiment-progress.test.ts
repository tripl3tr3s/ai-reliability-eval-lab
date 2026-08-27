import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ModelAdapter, TelemetrySink } from "../src/contracts.js";
import {
  planExperiment,
  runExperiment,
  type ExperimentFile,
  type ExperimentProgressEvent,
} from "../src/experiment.js";

const completedResponse = (model: string) => ({
  text: JSON.stringify({ outcome: "completed", answer: "Done.", claims: [] }),
  toolCalls: [],
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
  modelId: model,
  latencyMs: 1,
});

const smokeConfig: ExperimentFile = {
  dataset: "datasets/v2",
  configurations: ["direct-sonnet", "routed", "no-resource-injection"],
  repeats: 2,
  seed: 20260825,
  concurrency: 1,
  pricing: "config/pricing.v1.json",
  budgetUsd: 2,
  estimatedCostPerRunUsd: 0.04,
  promptVersion: "agent-prompt-v2",
  resourceVersion: "operational-resources-v2",
  stratifiedSmoke: true,
};

describe("experiment progress and cancellation", () => {
  it("uses one deterministic plan for the smoke preflight and execution order", async () => {
    const first = await planExperiment(smokeConfig);
    const second = await planExperiment(smokeConfig);

    expect(first.totalJobs).toBe(24);
    expect(first.selectedCaseCount).toBe(4);
    expect(first.estimatedCostUsd).toBeCloseTo(0.96);
    expect(first.budgetCeilingUsd).toBe(2);
    expect(first.jobs).toEqual(second.jobs);
    expect(new Set(first.jobs.map(({ configuration }) => configuration))).toEqual(
      new Set(smokeConfig.configurations),
    );
  });

  it("emits sanitized lifecycle events and every execution phase", async () => {
    const events: ExperimentProgressEvent[] = [];
    let modelCalls = 0;
    const adapter: ModelAdapter = {
      async generate(request) {
        modelCalls += 1;
        if (request.tools.length === 0) {
          return { ...completedResponse(request.model), text: "multi-step" };
        }
        if (modelCalls === 2) {
          return {
            ...completedResponse(request.model),
            text: "",
            toolCalls: [{ id: "tool-1", name: "get_document", input: { documentId: "INV-001" } }],
            stopReason: "tool_use",
          };
        }
        return completedResponse(request.model);
      },
    };
    const outputPath = join(await mkdtemp(join(tmpdir(), "experiment-progress-")), "results.jsonl");
    const config = { ...smokeConfig, configurations: ["routed"] as const, repeats: 1 };

    await runExperiment({ config, adapter, outputPath, onProgress: (event) => { events.push(event); } });

    expect(events[0]).toMatchObject({ type: "experiment_started", totalJobs: 4 });
    expect(events.at(-1)).toMatchObject({
      type: "experiment_completed",
      status: "completed",
      completedJobs: 4,
      totalJobs: 4,
    });
    expect(events.find(({ type }) => type === "job_started")).toMatchObject({
      index: 1,
      totalJobs: 4,
      configuration: "routed",
    });
    expect(events.find(({ type }) => type === "job_completed")).toMatchObject({
      index: 1,
      outcome: expect.stringMatching(/completed|abstained|bounded|failed/u),
      costUsd: expect.any(Number),
      durationMs: expect.any(Number),
      elapsedMs: expect.any(Number),
    });
    const phases = events.flatMap((event) => event.type === "phase_changed" ? [event.phase] : []);
    expect(new Set(phases)).toEqual(new Set(["routing", "model", "tool", "scoring", "persistence"]));
    expect(JSON.stringify(events)).not.toContain("INV-001");
    expect(JSON.stringify(events)).not.toContain("Done.");
  });

  it("forwards the root signal to routing and agent execution", async () => {
    const controller = new AbortController();
    const seenSignals: AbortSignal[] = [];
    const adapter: ModelAdapter = {
      async generate(request) {
        seenSignals.push(request.signal);
        return request.tools.length === 0
          ? { ...completedResponse(request.model), text: "simple-read-only" }
          : completedResponse(request.model);
      },
    };
    const outputPath = join(await mkdtemp(join(tmpdir(), "experiment-signal-")), "results.jsonl");
    const config = { ...smokeConfig, configurations: ["routed"] as const, repeats: 1 };

    await runExperiment({ config, adapter, outputPath, signal: controller.signal });

    expect(seenSignals.filter((signal) => signal === controller.signal)).toHaveLength(4);
    expect(seenSignals.filter((signal) => signal !== controller.signal)).toHaveLength(4);
  });

  it("flushes telemetry and preserves only completed rows after cancellation", async () => {
    const controller = new AbortController();
    const flush = vi.fn(async () => undefined);
    const telemetry: TelemetrySink = { emit: vi.fn(), flush };
    let modelCalls = 0;
    const adapter: ModelAdapter = {
      async generate(request) {
        modelCalls += 1;
        if (modelCalls === 1) return completedResponse(request.model);
        queueMicrotask(() => controller.abort(new Error("cancelled by test")));
        return new Promise((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
      },
    };
    const events: ExperimentProgressEvent[] = [];
    const outputPath = join(await mkdtemp(join(tmpdir(), "experiment-cancel-")), "results.jsonl");
    const config = { ...smokeConfig, configurations: ["direct-sonnet"] as const, repeats: 1 };

    await expect(runExperiment({
      config,
      adapter,
      outputPath,
      telemetry,
      signal: controller.signal,
      onProgress: (event) => { events.push(event); },
    })).rejects.toThrow("cancelled by test");

    expect((await readFile(outputPath, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(flush).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({
      type: "experiment_completed",
      status: "cancelled",
      completedJobs: 1,
      totalJobs: 4,
    });
    expect(modelCalls).toBe(2);
  });

  it("preserves the primary provider failure when final progress and telemetry cleanup also fail", async () => {
    const providerFailure = new Error("provider failed");
    const telemetry: TelemetrySink = {
      emit: vi.fn(),
      flush: vi.fn(async () => { throw new Error("flush failed"); }),
    };
    const adapter: ModelAdapter = { async generate() { throw providerFailure; } };
    const outputPath = join(await mkdtemp(join(tmpdir(), "experiment-primary-error-")), "results.jsonl");
    const config = { ...smokeConfig, configurations: ["direct-sonnet"] as const, repeats: 1 };

    await expect(runExperiment({
      config,
      adapter,
      outputPath,
      telemetry,
      onProgress: (event) => {
        if (event.type === "experiment_completed") throw new Error("progress cleanup failed");
      },
    })).rejects.toBe(providerFailure);
    expect(telemetry.flush).toHaveBeenCalledOnce();
  });

  it("retains known response cost when cancellation interrupts the current job", async () => {
    const controller = new AbortController();
    let modelCalls = 0;
    const events: ExperimentProgressEvent[] = [];
    const adapter: ModelAdapter = {
      async generate(request) {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            ...completedResponse(request.model),
            text: "",
            toolCalls: [{ id: "tool-1", name: "get_document", input: { documentId: "INV-001" } }],
            stopReason: "tool_use",
          };
        }
        queueMicrotask(() => controller.abort(new Error("cancel after paid response")));
        return new Promise((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
      },
    };
    const outputPath = join(await mkdtemp(join(tmpdir(), "experiment-partial-cost-")), "results.jsonl");
    const config = { ...smokeConfig, configurations: ["direct-sonnet"] as const, repeats: 1 };

    await expect(runExperiment({
      config,
      adapter,
      outputPath,
      signal: controller.signal,
      onProgress: (event) => { events.push(event); },
    })).rejects.toThrow("cancel after paid response");

    expect(events.at(-1)).toMatchObject({
      type: "experiment_completed",
      status: "cancelled",
      completedJobs: 0,
      observedCostUsd: 0.01,
    });
    expect(events.some((event) => event.type === "phase_changed" && event.observedCostUsd === 0.01)).toBe(true);
  });

  it("does not execute a tool when cancellation occurs during its progress phase", async () => {
    const controller = new AbortController();
    const emitted: Array<{ type: string }> = [];
    const telemetry: TelemetrySink = {
      emit: async (event) => { emitted.push(event); },
      flush: async () => undefined,
    };
    const adapter: ModelAdapter = {
      async generate(request) {
        return {
          ...completedResponse(request.model),
          text: "",
          toolCalls: [{
            id: "write-1",
            name: "create_follow_up",
            input: { supplierRfc: "RFC14", reason: "review", idempotencyKey: "follow-14" },
          }],
          stopReason: "tool_use",
        };
      },
    };
    const outputPath = join(await mkdtemp(join(tmpdir(), "experiment-phase-cancel-")), "results.jsonl");
    const config = { ...smokeConfig, configurations: ["direct-sonnet"] as const, repeats: 1 };

    await expect(runExperiment({
      config,
      adapter,
      outputPath,
      telemetry,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.type === "phase_changed" && event.phase === "tool") {
          controller.abort(new Error("cancel during tool phase"));
        }
      },
    })).rejects.toThrow("cancel during tool phase");
    expect(emitted.some(({ type }) => type === "tool")).toBe(false);
  });
});
