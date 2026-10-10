import { describe, expect, it } from "vitest";
import { discordantCounts, mcnemarExact, minimumDetectableEffect, requiredPairs } from "../../src/stats/index.js";

const pairs = (firstOnly: number, secondOnly: number, bothPassed = 0, bothFailed = 0): (readonly [boolean, boolean])[] => [
  ...Array.from({ length: firstOnly }, () => [true, false] as const),
  ...Array.from({ length: secondOnly }, () => [false, true] as const),
  ...Array.from({ length: bothPassed }, () => [true, true] as const),
  ...Array.from({ length: bothFailed }, () => [false, false] as const),
];

describe("exact McNemar test", () => {
  // Reference p-values: scipy binomtest(min(b, c), b + c, 0.5).pvalue (two-sided exact).
  it.each([
    [1, 7, 0.0703125],
    [0, 5, 0.0625],
    [5, 5, 1],
    [3, 12, 0.03515625],
    [10, 2, 0.03857421875],
    [0, 1, 1],
  ])("matches scipy for discordant counts b=%i, c=%i", (firstOnly, secondOnly, expected) => {
    expect(mcnemarExact(pairs(firstOnly, secondOnly, 4, 3)).pValue).toBeCloseTo(expected, 12);
  });

  it("reports the discordant counts and ignores concordant pairs", () => {
    expect(mcnemarExact(pairs(3, 12, 10, 5))).toMatchObject({ firstOnly: 3, secondOnly: 12, bothPassed: 10, bothFailed: 5, pairs: 30, discordant: 15 });
    expect(mcnemarExact(pairs(3, 12, 100, 0)).pValue).toBe(mcnemarExact(pairs(3, 12)).pValue);
  });

  it("returns p = 1 without discordant pairs or without data", () => {
    expect(mcnemarExact(pairs(0, 0, 30, 0)).pValue).toBe(1);
    expect(mcnemarExact([])).toMatchObject({ pairs: 0, discordant: 0, pValue: 1 });
    expect(discordantCounts([])).toEqual({ firstOnly: 0, secondOnly: 0, bothPassed: 0, bothFailed: 0 });
  });

  it("is symmetric in the direction of the difference", () => {
    expect(mcnemarExact(pairs(2, 9)).pValue).toBe(mcnemarExact(pairs(9, 2)).pValue);
  });
});

describe("paired binary power", () => {
  // Reference: n = (z_a * sqrt(psi) + z_b * sqrt(psi - d^2))^2 / d^2 with scipy norm.ppf(0.975), norm.ppf(0.8);
  // MDE values from scipy.optimize.brentq on n(d) - n = 0.
  it.each([
    [0.1, 0.2, 154.59856956021102],
    [0.2, 0.3, 56.44973666091138],
    [0.05, 0.1, 311.5868751756675],
  ])("computes required pairs for delta=%f, discordance=%f", (delta, discordance, expected) => {
    expect(requiredPairs(delta, discordance)).toBeCloseTo(expected, 4);
    expect(requiredPairs(-delta, discordance)).toBeCloseTo(expected, 4);
  });

  it.each([
    [30, 0.5, 0.3476447518054003],
    [300, 0.2, 0.07205272407758195],
    [100, 0.1, 0.08755348893461397],
    [30, 0.3, 0.2692844668274611],
    [30, 1, 0.49164392289101655],
  ])("computes the minimum detectable effect for n=%i, discordance=%f", (cases, discordance, expected) => {
    expect(minimumDetectableEffect(cases, discordance)).toBeCloseTo(expected, 6);
  });

  it("returns null when no difference is detectable at this sample size", () => {
    // 30 cases with 20% discordance would need 36.8 pairs even if every disagreement went one way.
    expect(minimumDetectableEffect(30, 0.2)).toBeNull();
    expect(minimumDetectableEffect(30, 0.1)).toBeNull();
    expect(minimumDetectableEffect(30, 0)).toBeNull();
    expect(minimumDetectableEffect(1, 1)).toBeNull();
  });

  it("round-trips with the sample size formula", () => {
    const effect = minimumDetectableEffect(120, 0.25)!;
    expect(requiredPairs(effect, 0.25)).toBeCloseTo(120, 6);
  });

  it("needs more pairs for higher power and stricter alpha", () => {
    expect(requiredPairs(0.1, 0.2, { power: 0.9 })).toBeGreaterThan(requiredPairs(0.1, 0.2));
    expect(requiredPairs(0.1, 0.2, { alpha: 0.01 })).toBeGreaterThan(requiredPairs(0.1, 0.2));
  });

  it("rejects impossible inputs", () => {
    expect(() => requiredPairs(0.3, 0.2)).toThrow(RangeError);
    expect(() => requiredPairs(0, 0.2)).toThrow(RangeError);
    expect(() => requiredPairs(0.1, 1.5)).toThrow(RangeError);
    expect(() => minimumDetectableEffect(0, 0.2)).toThrow(RangeError);
    expect(() => minimumDetectableEffect(30, -0.1)).toThrow(RangeError);
  });
});
