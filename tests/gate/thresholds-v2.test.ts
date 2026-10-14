import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SEVERITY_RULES_VERSION } from "../../src/gate/severity.js";
import { parseThresholds } from "../../src/gate/thresholds.js";
import { clopperPearsonInterval } from "../../src/stats/binomial.js";

describe("thresholds-v2", () => {
  it("pins the implemented severity rules and the 90-case minimum", async () => {
    const thresholds = parseThresholds(await readFile("config/thresholds.v2.json", "utf8"));
    expect(thresholds).toMatchObject({ version: "thresholds-v2", severityRulesVersion: SEVERITY_RULES_VERSION, minimumCases: { value: 90 } });
    for (const item of [thresholds.minimumCases, thresholds.deterministicChecks, thresholds.criticalErrors, thresholds.zeroWidthInterval, ...thresholds.nonInferiority]) {
      expect(item.rationale.length).toBeGreaterThan(40);
    }
  });

  it("sets the critical limit between the zero-failure and one-failure bounds at n = 90, as its rationale states", async () => {
    const thresholds = parseThresholds(await readFile("config/thresholds.v2.json", "utf8"));
    const zero = clopperPearsonInterval(0, 90, 0.95, "upper").high;
    const one = clopperPearsonInterval(1, 90, 0.95, "upper").high;
    expect(zero).toBeLessThan(thresholds.criticalErrors.maxUpperBound);
    expect(one).toBeGreaterThan(thresholds.criticalErrors.maxUpperBound);
  });
});
