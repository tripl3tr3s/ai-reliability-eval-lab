import { describe, expect, it } from "vitest";
import { clusterBootstrap, groupByCluster, mulberry32, pairedBootstrap, quantileSorted } from "../../src/stats/index.js";

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

describe("seeded generator", () => {
  it("is reproducible and uniform on [0, 1)", () => {
    const first = mulberry32(42);
    const second = mulberry32(42);
    const draws = Array.from({ length: 5_000 }, () => first());
    expect(draws.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => second()));
    expect(draws.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(mean(draws)).toBeCloseTo(0.5, 1);
    expect(mulberry32(43)()).not.toBe(mulberry32(42)());
  });
});

describe("quantile", () => {
  it("interpolates linearly like numpy.quantile", () => {
    // numpy.quantile([1, 2, 3, 4], [0, 0.25, 0.5, 0.975, 1]) -> [1, 1.75, 2.5, 3.925, 4]
    expect([0, 0.25, 0.5, 0.975, 1].map((probability) => quantileSorted([1, 2, 3, 4], probability))).toEqual([1, 1.75, 2.5, expect.closeTo(3.925, 12), 4]);
    expect(quantileSorted([7], 0.3)).toBe(7);
    expect(() => quantileSorted([], 0.5)).toThrow(RangeError);
    expect(() => quantileSorted([1], 1.1)).toThrow(RangeError);
  });
});

describe("cluster bootstrap", () => {
  it("returns byte-identical intervals for the same seed", () => {
    const clusters = Array.from({ length: 30 }, (_, index) => [index % 3 === 0 ? 0 : 1, 1, index % 5 === 0 ? 0 : 1]);
    const statistic = (sample: readonly (readonly number[])[]) => mean(sample.flat());
    const first = clusterBootstrap(clusters, statistic, { seed: 7, resamples: 2_000 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(clusterBootstrap(clusters, statistic, { seed: 7, resamples: 2_000 })));
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(clusterBootstrap(clusters, statistic, { seed: 8, resamples: 2_000 })));
    expect(first!.low).toBeLessThanOrEqual(first!.estimate);
    expect(first!.high).toBeGreaterThanOrEqual(first!.estimate);
  });

  it("is wider than a row-level bootstrap when repeats within a case are correlated", () => {
    // 30 cases with 5 perfectly correlated repeats each: 20 always pass, 10 always fail.
    const clusters = Array.from({ length: 30 }, (_, index) => Array.from({ length: 5 }, () => (index < 20 ? 1 : 0)));
    const clustered = clusterBootstrap(clusters, (sample) => mean(sample.flat()), { seed: 1, resamples: 4_000 })!;
    const pooled = clusterBootstrap(clusters.flat(), (sample) => mean(sample), { seed: 1, resamples: 4_000 })!;
    expect(clustered.estimate).toBeCloseTo(2 / 3, 12);
    expect(clustered.high - clustered.low).toBeGreaterThan(1.8 * (pooled.high - pooled.low));
    // With perfect correlation the clustered interval should match a binomial interval on n = 30 (Wilson: 0.488 to 0.808).
    expect(clustered.low).toBeGreaterThan(0.45);
    expect(clustered.low).toBeLessThan(0.55);
    expect(clustered.high).toBeGreaterThan(0.78);
    expect(clustered.high).toBeLessThan(0.86);
  });

  it("collapses to a point for constant data and a single cluster", () => {
    expect(clusterBootstrap([1, 1, 1], mean, { seed: 3, resamples: 200 })).toMatchObject({ estimate: 1, low: 1, high: 1 });
    expect(clusterBootstrap([0.4], mean, { seed: 3, resamples: 200 })).toMatchObject({ estimate: 0.4, low: 0.4, high: 0.4 });
  });

  it("returns null without data or when the statistic is undefined", () => {
    expect(clusterBootstrap([], mean, { seed: 1 })).toBeNull();
    expect(clusterBootstrap([1, 2], () => null, { seed: 1, resamples: 50 })).toBeNull();
    expect(clusterBootstrap([1, 2], () => Number.NaN, { seed: 1, resamples: 50 })).toBeNull();
  });

  it("counts resamples where the statistic is undefined", () => {
    const ratio = (sample: readonly number[]) => (sample.includes(1) ? 1 / sample.filter((value) => value === 1).length : null);
    const result = clusterBootstrap([1, 0, 0], ratio, { seed: 5, resamples: 500 })!;
    expect(result.validResamples).toBeLessThan(500);
    expect(result.validResamples).toBeGreaterThan(0);
  });

  it("honours the confidence level and validates options", () => {
    const clusters = Array.from({ length: 40 }, (_, index) => index % 4);
    const wide = clusterBootstrap(clusters, mean, { seed: 2, resamples: 2_000, confidence: 0.99 })!;
    const narrow = clusterBootstrap(clusters, mean, { seed: 2, resamples: 2_000, confidence: 0.8 })!;
    expect(wide.high - wide.low).toBeGreaterThan(narrow.high - narrow.low);
    expect(() => clusterBootstrap(clusters, mean, { seed: 1, resamples: 0 })).toThrow(RangeError);
    expect(() => clusterBootstrap(clusters, mean, { seed: 1, confidence: 1 })).toThrow(RangeError);
  });
});

describe("paired bootstrap", () => {
  it("estimates the mean paired difference with a seeded interval", () => {
    const pairs = Array.from({ length: 30 }, (_, index) => [1, index < 6 ? 0 : 1] as const);
    const result = pairedBootstrap(pairs, { seed: 11, resamples: 4_000 })!;
    expect(result.estimate).toBeCloseTo(0.2, 12);
    expect(result.low).toBeGreaterThan(0);
    expect(result.high).toBeLessThan(0.4);
    expect(JSON.stringify(result)).toBe(JSON.stringify(pairedBootstrap(pairs, { seed: 11, resamples: 4_000 })));
  });

  it("uses the pairing: a constant shift has no sampling variance", () => {
    const pairs = Array.from({ length: 20 }, (_, index) => [index / 20 + 0.1, index / 20] as const);
    const result = pairedBootstrap(pairs, { seed: 4, resamples: 500 })!;
    expect(result.low).toBeCloseTo(0.1, 10);
    expect(result.high).toBeCloseTo(0.1, 10);
  });

  it("returns null without pairs", () => {
    expect(pairedBootstrap([], { seed: 1 })).toBeNull();
  });
});

describe("cluster grouping", () => {
  it("groups by key in key order regardless of input order", () => {
    const rows = [{ id: "b", value: 1 }, { id: "a", value: 2 }, { id: "b", value: 3 }];
    expect(groupByCluster(rows, ({ id }) => id)).toEqual([[{ id: "a", value: 2 }], [{ id: "b", value: 1 }, { id: "b", value: 3 }]]);
    expect(groupByCluster([...rows].reverse(), ({ id }) => id).map((group) => group[0]!.id)).toEqual(["a", "b"]);
  });
});
