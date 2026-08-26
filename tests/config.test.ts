import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { AGENT_CONFIGURATIONS, modelForRoutedTask } from "../src/config.js";

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
