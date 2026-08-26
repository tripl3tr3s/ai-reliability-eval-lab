import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_CONFIGURATIONS, PROMPT_VERSION, RESOURCE_VERSION, modelForRoutedTask } from "../src/config.js";
import { loadExperimentConfig } from "../src/experiment.js";

describe("agent configurations", () => {
  it("changes only resource injection in the no-resource condition", () => {
    expect(AGENT_CONFIGURATIONS["no-resource-injection"].tools).toEqual(
      AGENT_CONFIGURATIONS.routed.tools,
    );
    expect(AGENT_CONFIGURATIONS["no-resource-injection"].resources).toBe("excluded");
  });

  it("routes complex work to Sonnet", () => {
    expect(modelForRoutedTask("simple-read-only")).toContain("haiku");
    expect(modelForRoutedTask("recovery")).toContain("sonnet");
  });

  it("versions the corrected prompt and synthetic resources", () => {
    expect(PROMPT_VERSION).toBe("agent-prompt-v2");
    expect(RESOURCE_VERSION).toBe("operational-resources-v2");
  });

  it("preserves v1 config compatibility and rejects mixed version pairs", async () => {
    await expect(loadExperimentConfig("config/full.v1.json")).resolves.toMatchObject({ dataset: "datasets/v1", promptVersion: "agent-prompt-v1" });
    await expect(loadExperimentConfig("config/full.v2.json")).resolves.toMatchObject({ dataset: "datasets/v2", promptVersion: "agent-prompt-v2" });
    const directory = await mkdtemp(join(tmpdir(), "mixed-eval-config-"));
    const mixed = JSON.parse(await readFile("config/full.v2.json", "utf8")) as Record<string, unknown>;
    await writeFile(join(directory, "mixed.json"), JSON.stringify({ ...mixed, promptVersion: "agent-prompt-v1" }));
    await expect(loadExperimentConfig(join(directory, "mixed.json"))).rejects.toThrow();
  });

  it("records current Sonnet 5 pricing", async () => {
    const pricing = JSON.parse(await readFile("config/pricing.v1.json", "utf8")) as {
      version: string;
      effectiveDate: string;
      perMillionTokens: Record<string, { input: number; output: number }>;
    };
    expect(pricing.version).toBe("anthropic-2026-08-10-sonnet-5");
    expect(pricing.effectiveDate).toBe("2026-08-10");
    expect(pricing.perMillionTokens["claude-sonnet-5"]).toEqual({ input: 2, output: 10 });
    expect(pricing.perMillionTokens).not.toHaveProperty("claude-sonnet-4-6");
  });
});
