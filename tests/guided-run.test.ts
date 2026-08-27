import { describe, expect, it, vi } from "vitest";
import {
  GuidedRunCancelledError,
  GuidedRunDeclinedError,
  resolveGuidedRun,
  type GuidedPromptPort,
} from "../src/guided-run.js";

const config = {
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
} as const;

const plan = {
  jobs: [],
  totalJobs: 24,
  selectedCaseCount: 4,
  estimatedCostUsd: 0.96,
  budgetCeilingUsd: 2,
};

function prompts(overrides: Partial<GuidedPromptPort> = {}): GuidedPromptPort {
  return {
    chooseConfiguration: vi.fn(async () => "smoke-v2" as const),
    requestCustomConfigPath: vi.fn(async () => "config/custom.json"),
    showPreflight: vi.fn(),
    confirmRun: vi.fn(async () => true),
    ...overrides,
  };
}

describe("guided run setup", () => {
  it("defaults to Smoke v2 and displays a complete preflight", async () => {
    const prompt = prompts();
    const loadConfig = vi.fn(async () => config);
    const result = await resolveGuidedRun({
      isTTY: true,
      prompt,
      loadConfig,
      planExperiment: vi.fn(async () => plan),
      createArtifactPaths: vi.fn(async () => ({
        resultsPath: "runs/results-timestamp.jsonl",
        eventsPath: "runs/events-timestamp.jsonl",
      })),
    });

    expect(loadConfig).toHaveBeenCalledWith("config/smoke.v2.json");
    expect(prompt.showPreflight).toHaveBeenCalledWith(expect.stringMatching(
      /Configurations: direct-sonnet, routed, no-resource-injection[\s\S]*Repeats: 2[\s\S]*Jobs: 24[\s\S]*Estimated spend: \$0\.96[\s\S]*Budget ceiling: \$2\.00/u,
    ));
    expect(result).toMatchObject({
      configPath: "config/smoke.v2.json",
      outputPath: "runs/results-timestamp.jsonl",
      eventsPath: "runs/events-timestamp.jsonl",
      config,
      plan,
    });
  });

  it("uses supplied paths as guided defaults without asking for a preset", async () => {
    const prompt = prompts();
    const result = await resolveGuidedRun({
      isTTY: true,
      configPath: "config/full.v2.json",
      outputPath: "runs/supplied.jsonl",
      eventsPath: "runs/supplied-events.jsonl",
      prompt,
      loadConfig: vi.fn(async () => config),
      planExperiment: vi.fn(async () => plan),
      createArtifactPaths: vi.fn(async () => ({
        resultsPath: "runs/generated.jsonl",
        eventsPath: "runs/generated-events.jsonl",
      })),
    });

    expect(prompt.chooseConfiguration).not.toHaveBeenCalled();
    expect(result.outputPath).toBe("runs/supplied.jsonl");
    expect(result.eventsPath).toBe("runs/supplied-events.jsonl");
  });

  it("supports a custom validated configuration path", async () => {
    const prompt = prompts({ chooseConfiguration: vi.fn(async () => "custom" as const) });
    const loadConfig = vi.fn(async () => config);
    await resolveGuidedRun({
      isTTY: true,
      prompt,
      loadConfig,
      planExperiment: vi.fn(async () => plan),
      createArtifactPaths: vi.fn(async () => ({ resultsPath: "runs/r.jsonl", eventsPath: "runs/e.jsonl" })),
    });
    expect(loadConfig).toHaveBeenCalledWith("config/custom.json");
  });

  it("rejects non-TTY use and distinguishes prompt cancellation from a declined run", async () => {
    const dependencies = {
      loadConfig: vi.fn(async () => config),
      planExperiment: vi.fn(async () => plan),
      createArtifactPaths: vi.fn(async () => ({ resultsPath: "runs/r.jsonl", eventsPath: "runs/e.jsonl" })),
    };
    await expect(resolveGuidedRun({ isTTY: false, prompt: prompts(), ...dependencies })).rejects.toThrow(/interactive terminal/u);
    await expect(resolveGuidedRun({
      isTTY: true,
      prompt: prompts({ chooseConfiguration: vi.fn(async () => Symbol("cancel")) }),
      ...dependencies,
    })).rejects.toBeInstanceOf(GuidedRunCancelledError);
    await expect(resolveGuidedRun({
      isTTY: true,
      prompt: prompts({ confirmRun: vi.fn(async () => false) }),
      ...dependencies,
    })).rejects.toBeInstanceOf(GuidedRunDeclinedError);
  });

  it("refuses existing interactive artifacts instead of appending", async () => {
    await expect(resolveGuidedRun({
      isTTY: true,
      outputPath: "runs/existing.jsonl",
      eventsPath: "runs/new-events.jsonl",
      prompt: prompts(),
      loadConfig: vi.fn(async () => config),
      planExperiment: vi.fn(async () => plan),
      createArtifactPaths: vi.fn(async () => ({ resultsPath: "runs/r.jsonl", eventsPath: "runs/e.jsonl" })),
      artifactExists: vi.fn(async (path) => path === "runs/existing.jsonl"),
    })).rejects.toThrow(/already exists/u);
  });
});
