import { describe, expect, it } from "vitest";
import {
  binomialPmf,
  bonettPriceClusterInterval,
  bonettPriceInterval,
  iccOneWay,
  mcnemarExact,
  mcnemarMidP,
  passAtKUnbiased,
  passPowerK,
  passPowerKUnbiased,
  pValueByInversion,
  roundHalfEven,
  shafferAdjust,
  shafferTrueNullCounts,
  sidakConfidence,
  STATS_METHODS,
  STATS_METHODS_VERSION,
  wilsonInterval,
  wilsonOnCaseRates,
  type CaseTally,
} from "../../src/stats/index.js";

const counts = (firstOnly: number, secondOnly: number, bothPassed = 0, bothFailed = 0) => ({ firstOnly, secondOnly, bothPassed, bothFailed });
const tallies = (passes: readonly number[], trials: number | readonly number[]): CaseTally[] =>
  passes.map((count, index) => ({ caseId: `case-${String(index).padStart(3, "0")}`, passes: count, trials: typeof trials === "number" ? trials : trials[index]! }));
const pairs = (firstOnly: number, secondOnly: number, rest = 10): (readonly [boolean, boolean])[] => [
  ...Array.from({ length: firstOnly }, () => [true, false] as const),
  ...Array.from({ length: secondOnly }, () => [false, true] as const),
  ...Array.from({ length: rest }, () => [true, true] as const),
];

describe("binomial pmf and rounding helpers", () => {
  it("gives a pmf that sums to one and is symmetric at p = 0.5", () => {
    const mass = Array.from({ length: 31 }, (_, k) => binomialPmf(k, 30, 0.5));
    expect(mass.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    expect(mass[3]).toBeCloseTo(mass[27]!, 15);
    expect(() => binomialPmf(31, 30, 0.5)).toThrow(RangeError);
    expect(() => binomialPmf(1, 30, 1.5)).toThrow(RangeError);
  });

  it("rounds half to even like numpy", () => {
    expect([0.5, 1.5, 2.5, 3.5, 2.4999, 2.5001, 4].map(roundHalfEven)).toEqual([0, 2, 2, 4, 2, 3, 4]);
  });

  it("reduces Wilson on per-case rates to plain Wilson when every case ran once", () => {
    expect(wilsonOnCaseRates([1, 1, 0, 1, 0, 1])).toEqual(wilsonInterval(4, 6));
    expect(wilsonOnCaseRates([0.6, 0.6, 0.4])).toEqual(wilsonInterval(2, 3));
    expect(() => wilsonOnCaseRates([])).toThrow(RangeError);
    expect(() => wilsonOnCaseRates([1.2])).toThrow(RangeError);
  });
});

describe("McNemar mid-p", () => {
  it("is symmetric, never above the exact test, and 1 without discordance", () => {
    for (const [first, second] of [[1, 7], [3, 12], [10, 2], [0, 5], [17, 23]] as const) {
      expect(mcnemarMidP({ firstOnly: first, secondOnly: second })).toBe(mcnemarMidP({ firstOnly: second, secondOnly: first }));
      expect(mcnemarMidP({ firstOnly: first, secondOnly: second })).toBeLessThan(mcnemarExact(pairs(first, second)).pValue);
    }
    expect(mcnemarMidP({ firstOnly: 0, secondOnly: 0 })).toBe(1);
    expect(mcnemarMidP({ firstOnly: 4, secondOnly: 4 })).toBe(1);
  });
});

describe("Bonett-Price intervals", () => {
  it("never has zero width, even with no discordant pairs", () => {
    const interval = bonettPriceInterval(counts(0, 0, 90, 0));
    expect(interval.estimate).toBe(0);
    expect(interval.low).toBeLessThan(0);
    expect(interval.high).toBeGreaterThan(0);
    expect(interval.high).toBeCloseTo(-interval.low, 15);
  });

  it("is antisymmetric when the arms are swapped and stays inside [-1, 1]", () => {
    const forward = bonettPriceInterval(counts(9, 2, 15, 4));
    const backward = bonettPriceInterval(counts(2, 9, 15, 4));
    expect(backward.low).toBeCloseTo(-forward.high, 15);
    expect(backward.high).toBeCloseTo(-forward.low, 15);
    const extreme = bonettPriceInterval(counts(30, 0));
    expect(extreme.high).toBeLessThanOrEqual(1);
    expect(extreme.low).toBeGreaterThan(0);
  });

  it("widens with the confidence level and rejects invalid input", () => {
    expect(bonettPriceInterval(counts(4, 9, 60, 17), 0.99).low).toBeLessThan(bonettPriceInterval(counts(4, 9, 60, 17), 0.95).low);
    expect(() => bonettPriceInterval(counts(0, 0))).toThrow(RangeError);
    expect(() => bonettPriceInterval(counts(1, 0), 1)).toThrow(RangeError);
  });

  it("gives the single-run interval from the clustered form when every case ran once", () => {
    const differences = [...Array<number>(4).fill(1), ...Array<number>(9).fill(-1), ...Array<number>(77).fill(0)];
    const clustered = bonettPriceClusterInterval(differences);
    const single = bonettPriceInterval(counts(4, 9, 60, 17));
    expect(clustered.low).toBeCloseTo(single.low, 14);
    expect(clustered.high).toBeCloseTo(single.high, 14);
    expect(clustered.estimate).toBeCloseTo(single.estimate, 15);
  });

  it("does not depend on case order and rejects out-of-range differences", () => {
    const differences = [0.2, -0.4, 0, 0, 1, -0.2, 0.6];
    const forward = bonettPriceClusterInterval(differences);
    const reversed = bonettPriceClusterInterval([...differences].reverse());
    expect(reversed.low).toBeCloseTo(forward.low, 14);
    expect(reversed.high).toBeCloseTo(forward.high, 14);
    expect(reversed.estimate).toBeCloseTo(forward.estimate, 15);
    expect(() => bonettPriceClusterInterval([])).toThrow(RangeError);
    expect(() => bonettPriceClusterInterval([1.5])).toThrow(RangeError);
  });
});

describe("p-value by interval inversion", () => {
  it("returns 1 when no interval excludes zero and 0 when every one does", () => {
    expect(pValueByInversion(() => ({ low: -1, high: 1 }))).toBe(1);
    expect(pValueByInversion(() => ({ low: 0.1, high: 0.2 }))).toBe(0);
  });

  it("agrees with its interval at the 5% level", () => {
    for (const differences of [[0.2, 0.4, 0, 0.6, 0.2, 0, 0.4, 0.2], [0.2, -0.2, 0, 0.4, -0.4, 0], Array<number>(40).fill(0.2)]) {
      const p = pValueByInversion((alpha) => bonettPriceClusterInterval(differences, 1 - alpha));
      const interval = bonettPriceClusterInterval(differences, 0.95);
      expect(p < 0.05).toBe(interval.low > 0 || interval.high < 0);
    }
  });
});

describe("multiplicity", () => {
  it("applies Sidak and leaves a single comparison unchanged", () => {
    expect(sidakConfidence(0.95, 1)).toBe(0.95);
    expect(sidakConfidence(0.95, 3)).toBeCloseTo(0.95 ** (1 / 3), 15);
    expect(() => sidakConfidence(0.95, 0)).toThrow(RangeError);
    expect(() => sidakConfidence(1, 2)).toThrow(RangeError);
  });

  it("uses Shaffer's possible true-null counts", () => {
    expect(shafferTrueNullCounts(2)).toEqual([0, 1]);
    expect(shafferTrueNullCounts(3)).toEqual([0, 1, 3]);
    // Shaffer (1986) Table 1: the full sets for four and five groups include sums of separate clusters.
    expect(shafferTrueNullCounts(4)).toEqual([0, 1, 2, 3, 6]);
    expect(shafferTrueNullCounts(5)).toEqual([0, 1, 2, 3, 4, 6, 10]);
    expect(() => shafferTrueNullCounts(1)).toThrow(RangeError);
  });

  it("multiplies three pairwise p-values by 3, 1, 1 in order, keeps them monotone, and caps at 1", () => {
    expect(shafferAdjust([0.01, 0.04, 0.03], 3)).toEqual([0.03, 0.04, 0.03]);
    expect(shafferAdjust([0.2, 0.9, 0.1], 3).map((value) => Number(value.toFixed(12)))).toEqual([0.3, 0.9, 0.3]);
    expect(shafferAdjust([0.5, 0.9, 0.4], 3)).toEqual([1, 1, 1]);
    // Four groups: multipliers 6, 3, 3, 3, 2, 1 from {0, 1, 2, 3, 6}. evalstats 0.3.3 would use 1 at the fifth step.
    expect(shafferAdjust([0.001, 0.01, 0.02, 0.03, 0.04, 0.2], 4).map((value) => Number(value.toFixed(12)))).toEqual([0.006, 0.03, 0.06, 0.09, 0.09, 0.2]);
    expect(() => shafferAdjust([0.1, 0.2], 3)).toThrow(RangeError);
    expect(() => shafferAdjust([0.1, 0.2, 1.2], 3)).toThrow(RangeError);
  });
});

describe("intraclass correlation and unbiased pass^k", () => {
  it("is 1 when repeats of a case always agree and null without variance or groups", () => {
    expect(iccOneWay(tallies([5, 0, 5, 0, 5], 5))).toMatchObject({ icc: 1, designEffect: 5, cases: 5, runs: 25 });
    expect(iccOneWay(tallies([5, 5, 5], 5))).toBeNull();
    expect(iccOneWay(tallies([3], 5))).toBeNull();
    expect(iccOneWay(tallies([1, 0], 1))).toBeNull();
  });

  it("can be negative when cases agree more than their repeats", () => {
    expect(iccOneWay(tallies([1, 1, 1, 1], 2))!.icc).toBe(-1);
  });

  it("uses the adjusted group size k0 when repeats are unequal", () => {
    const result = iccOneWay(tallies([3, 1, 2], [4, 2, 3]))!;
    const runs = 9;
    expect(result.repeatsPerCase).toBeCloseTo((runs - (16 + 4 + 9) / runs) / 2, 14);
    // Hand ANOVA: means 0.75, 0.5, 0.667, grand 6/9. SSB = 4(0.75-g)^2 + 2(0.5-g)^2 + 3(0.667-g)^2, SSW = 0.75 + 0.5 + 0.667.
    const grand = 6 / 9;
    const msb = (4 * (0.75 - grand) ** 2 + 2 * (0.5 - grand) ** 2 + 3 * (2 / 3 - grand) ** 2) / 2;
    const msw = (3 - 9 / 4 + (1 - 1 / 2) + (2 - 4 / 3)) / 6;
    expect(result.icc).toBeCloseTo((msb - msw) / (msb + (result.repeatsPerCase - 1) * msw), 14);
  });

  it("equals the share of cases passing every repeat at k = repeats, and stays at or below the plug-in", () => {
    const sample = tallies([5, 4, 5, 2, 0, 5], 5);
    expect(passPowerKUnbiased(sample, 5)).toBeCloseTo(3 / 6, 15);
    for (const k of [1, 2, 3, 4, 5]) expect(passPowerKUnbiased(sample, k)!).toBeLessThanOrEqual(passPowerK(sample, k)! + 1e-15);
    expect(passPowerKUnbiased(sample, 1)).toBeCloseTo(21 / 30, 15);
    expect(passAtKUnbiased(sample, 5)).toBeCloseTo(5 / 6, 15);
    expect(passPowerKUnbiased(tallies([2, 3], [2, 5]), 3)).toBeNull();
    expect(passPowerKUnbiased([], 1)).toBeNull();
  });
});

describe("methods registry", () => {
  it("names a version and labels the multi-run methods as not yet validated", () => {
    expect(STATS_METHODS_VERSION).toBe("stats-methods-v2");
    expect(STATS_METHODS.bonettPriceCluster).toContain("not yet validated");
    expect(STATS_METHODS.iccOneWay).toContain("not yet validated");
    expect(STATS_METHODS.percentileBootstrapLegacy).toContain("legacy");
  });
});
