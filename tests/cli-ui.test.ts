import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createInteractiveArtifactPaths,
  createProgressRenderer,
  formatProgressSnapshot,
  INTERACTIVE_SPINNER_DELAY_MS,
  INTERACTIVE_SPINNER_FRAMES,
  initialProgressSnapshot,
  reduceProgressSnapshot,
  reserveInteractiveArtifactPaths,
  resolveProgressMode,
  type CliProgressEvent,
  type ProgressControl,
} from "../src/cli-ui.js";

const started: CliProgressEvent = {
  type: "experiment_started",
  totalJobs: 24,
  estimatedCostUsd: 0.48,
  budgetCeilingUsd: 2,
};

const job = {
  index: 1,
  totalJobs: 24,
  runId: "run-1",
  caseId: "v2-lookup-document-01",
  configuration: "direct-sonnet",
  repeat: 0,
} as const;

describe("CLI progress UI", () => {
  it("uses a smooth, fixed-width spinner animation for interactive runs", () => {
    expect(INTERACTIVE_SPINNER_FRAMES).toEqual([
      "⠋",
      "⠙",
      "⠹",
      "⠸",
      "⠼",
      "⠴",
      "⠦",
      "⠧",
      "⠇",
      "⠏",
    ]);
    expect(new Set(INTERACTIVE_SPINNER_FRAMES)).toHaveLength(10);
    expect(INTERACTIVE_SPINNER_FRAMES.every((frame) => [...frame].length === 1)).toBe(true);
    expect(INTERACTIVE_SPINNER_DELAY_MS).toBe(70);
  });

  it("resolves automatic progress for TTY, CI, NO_COLOR, and quiet modes", () => {
    expect(resolveProgressMode({ requested: "auto", isTTY: true, isCI: false, noColor: false })).toBe("interactive");
    expect(resolveProgressMode({ requested: "auto", isTTY: true, isCI: true, noColor: false })).toBe("plain");
    expect(resolveProgressMode({ requested: "auto", isTTY: false, isCI: false, noColor: false })).toBe("plain");
    expect(resolveProgressMode({ requested: "auto", isTTY: true, isCI: false, noColor: true })).toBe("plain");
    expect(resolveProgressMode({ requested: "plain", isTTY: true, isCI: false, noColor: false })).toBe("plain");
    expect(resolveProgressMode({ requested: "quiet", isTTY: true, isCI: false, noColor: false })).toBe("quiet");
  });

  it("reduces lifecycle events into a sanitized progress snapshot and ETA", () => {
    const base = reduceProgressSnapshot(initialProgressSnapshot(1_000), started, 1_000);
    const active = reduceProgressSnapshot(base, { type: "job_started", ...job }, 2_000);
    const phased = reduceProgressSnapshot(active, { type: "phase_changed", ...job, phase: "model", observedCostUsd: 0 }, 2_500);
    expect(formatProgressSnapshot(phased, 2_500)).toContain("[0/24]");
    expect(formatProgressSnapshot(phased, 2_500)).toContain("v2-lookup-document-01 | direct-sonnet | repeat 1 | model");
    expect(formatProgressSnapshot(phased, 2_500)).toContain("ETA estimating");

    const completed = reduceProgressSnapshot(phased, {
      type: "job_completed",
      ...job,
      outcome: "completed",
      costUsd: 0.0123,
      observedCostUsd: 0.0123,
      durationMs: 4_000,
      elapsedMs: 4_000,
    }, 5_000);
    const formatted = formatProgressSnapshot(completed, 5_000);
    expect(formatted).toContain("[1/24]");
    expect(formatted).toContain("ETA 01:32");
    expect(formatted).toContain("cost $0.0123/$2.00");
    expect(formatted).toContain("outcomes C:1 A:0 B:0 F:0");
  });

  it("writes durable plain progress and final artifact paths to the injected stream", () => {
    let output = "";
    const renderer = createProgressRenderer({
      mode: "plain",
      output: { write: (chunk) => { output += chunk; } },
      artifacts: { resultsPath: "runs/results-safe.jsonl", eventsPath: "runs/events-safe.jsonl" },
      now: () => 5_000,
    });
    renderer.onEvent(started);
    renderer.onEvent({ type: "job_started", ...job });
    renderer.onEvent({ type: "phase_changed", ...job, phase: "scoring", observedCostUsd: 0 });
    renderer.onEvent({
      type: "job_completed",
      ...job,
      outcome: "abstained",
      costUsd: 0.01,
      observedCostUsd: 0.01,
      durationMs: 4_000,
      elapsedMs: 4_000,
    });
    renderer.onEvent({
      type: "experiment_completed",
      status: "completed",
      completedJobs: 1,
      totalJobs: 24,
      observedCostUsd: 0.01,
      elapsedMs: 4_000,
      outcomes: { completed: 0, abstained: 1, bounded: 0, failed: 0 },
    });

    expect(output).toContain("[start] jobs=24 estimate=$0.48 ceiling=$2.00");
    expect(output).toContain("[1/24] start case=v2-lookup-document-01 configuration=direct-sonnet repeat=1");
    expect(output).toContain("[1/24] phase=scoring");
    expect(output).toContain("phase=scoring case=v2-lookup-document-01 configuration=direct-sonnet repeat=1 total=$0.0000");
    expect(output).toContain("[1/24] complete outcome=abstained duration=00:04 cost=$0.0100 total=$0.0100");
    expect(output).toContain("Run completed: 1/24 jobs | elapsed 00:04 | cost $0.0100/$2.00");
    expect(output).toContain("Results: runs/results-safe.jsonl");
    expect(output).toContain("Events: runs/events-safe.jsonl");
    expect(output).not.toContain(String.fromCharCode(27));
  });

  it("drives a Clack progress control in interactive mode", () => {
    const control: ProgressControl = {
      start: vi.fn(),
      advance: vi.fn(),
      message: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn(),
      error: vi.fn(),
    };
    let output = "";
    const renderer = createProgressRenderer({
      mode: "interactive",
      output: { write: (chunk) => { output += chunk; } },
      artifacts: { resultsPath: "runs/results.jsonl", eventsPath: "runs/events.jsonl" },
      now: () => 5_000,
      createControl: () => control,
    });
    renderer.onEvent(started);
    renderer.onEvent({ type: "job_started", ...job });
    renderer.onEvent({ type: "phase_changed", ...job, phase: "tool", observedCostUsd: 0 });
    renderer.onEvent({
      type: "job_completed",
      ...job,
      outcome: "completed",
      costUsd: 0.01,
      observedCostUsd: 0.01,
      durationMs: 4_000,
      elapsedMs: 4_000,
    });
    renderer.onEvent({
      type: "experiment_completed",
      status: "cancelled",
      completedJobs: 1,
      totalJobs: 24,
      observedCostUsd: 0.01,
      elapsedMs: 4_000,
      outcomes: { completed: 1, abstained: 0, bounded: 0, failed: 0 },
    });

    expect(control.start).toHaveBeenCalledWith(expect.stringContaining("[0/24]"));
    expect(control.message).toHaveBeenCalledWith(expect.stringContaining("| tool |"));
    expect(control.advance).toHaveBeenCalledWith(1, expect.stringContaining("[1/24]"));
    expect(control.cancel).toHaveBeenCalledWith("Run cancelled after 1/24 jobs");
    expect(output).toContain("Partial run cancelled: 1/24 jobs");
  });

  it("suppresses quiet progress while retaining the final summary", () => {
    let output = "";
    const renderer = createProgressRenderer({ mode: "quiet", output: { write: (chunk) => { output += chunk; } }, now: () => 0 });
    renderer.onEvent(started);
    expect(output).toBe("");
    renderer.onEvent({
      type: "experiment_completed",
      status: "completed",
      completedJobs: 0,
      totalJobs: 24,
      observedCostUsd: 0,
      elapsedMs: 0,
      outcomes: { completed: 0, abstained: 0, bounded: 0, failed: 0 },
    });
    expect(output).toContain("Run completed: 0/24 jobs");
  });

  it("creates collision-safe timestamped paths with deterministic dependencies", async () => {
    const seen: string[] = [];
    const artifacts = await createInteractiveArtifactPaths({
      directory: "runs",
      now: () => new Date("2026-08-26T12:34:56.789Z"),
      exists: async (path) => {
        seen.push(path);
        return path.endsWith("results-2026-08-26T12-34-56-789Z.jsonl");
      },
    });
    expect(seen).toContain("runs/results-2026-08-26T12-34-56-789Z.jsonl");
    expect(artifacts).toEqual({
      resultsPath: "runs/results-2026-08-26T12-34-56-789Z-1.jsonl",
      eventsPath: "runs/events-2026-08-26T12-34-56-789Z-1.jsonl",
    });
  });

  it("atomically reserves both guided artifact files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-artifacts-"));
    const artifacts = {
      resultsPath: join(directory, "nested", "results.jsonl"),
      eventsPath: join(directory, "nested", "events.jsonl"),
    };
    try {
      await reserveInteractiveArtifactPaths(artifacts);
      expect(await readFile(artifacts.resultsPath, "utf8")).toBe("");
      expect(await readFile(artifacts.eventsPath, "utf8")).toBe("");
      await expect(reserveInteractiveArtifactPaths(artifacts)).rejects.toThrow(/unique interactive artifact/u);
      expect(await readFile(artifacts.resultsPath, "utf8")).toBe("");
      expect(await readFile(artifacts.eventsPath, "utf8")).toBe("");
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("strips control characters and bounds identifiers in rendered output", () => {
    const snapshot = reduceProgressSnapshot(
      reduceProgressSnapshot(initialProgressSnapshot(0), started, 0),
      {
        type: "job_started",
        ...job,
        caseId: `case\nsecret\u001B[31m${"x".repeat(300)}`,
      },
      0,
    );
    const rendered = formatProgressSnapshot(snapshot, 0);
    expect(rendered).not.toContain("\n");
    expect(rendered).not.toContain("\u001B");
    expect(rendered.length).toBeLessThan(400);
  });
});
