import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANTHROPIC_MODELS } from "../src/adapter.js";
import { loadPricingConfig } from "../src/pricing.js";

describe("pricing configuration", () => {
  it("loads and validates the versioned runtime rates", async () => {
    const pricing = await loadPricingConfig("config/pricing.v1.json");
    expect(pricing.version).toBe("anthropic-2026-08-10-sonnet-5");
    expect(pricing.effectiveDate).toBe("2026-08-10");
    expect(pricing.perMillionTokens[ANTHROPIC_MODELS.sonnet]).toEqual({ input: 2, output: 10 });
    expect(pricing.perMillionTokens[ANTHROPIC_MODELS.haiku]).toEqual({ input: 1, output: 5 });
  });

  it("loads the 5.5 lineup with the Haiku 5.5 long-prompt rate card and keeps the legacy rates", async () => {
    const pricing = await loadPricingConfig("config/pricing.v2.json");
    expect(pricing.version).toBe("anthropic-2026-10-13-5-5-lineup");
    expect(pricing.perMillionTokens[ANTHROPIC_MODELS.haiku55]).toEqual({ input: 0.1, output: 0.5, longPrompt: { thresholdTokens: 100_000, input: 0.5, output: 2.5 } });
    expect(pricing.perMillionTokens[ANTHROPIC_MODELS.sonnet55]).toEqual({ input: 2, output: 10 });
    expect(pricing.perMillionTokens[ANTHROPIC_MODELS.opus55]).toEqual({ input: 4, output: 20 });
    expect(pricing.perMillionTokens[ANTHROPIC_MODELS.sonnet]).toEqual({ input: 2, output: 10 });
    expect(pricing.perMillionTokens[ANTHROPIC_MODELS.haiku]).toEqual({ input: 1, output: 5 });
  });

  it("rejects malformed and incomplete pricing files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reliability-pricing-"));
    const path = join(directory, "invalid.json");
    await writeFile(path, JSON.stringify({ version: "v1", effectiveDate: "not-a-date", currency: "USD", perMillionTokens: {} }));
    await expect(loadPricingConfig(path)).rejects.toThrow();
  });
});
