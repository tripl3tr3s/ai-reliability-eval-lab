import { describe, expect, it } from "vitest";
import { binomialCdf, clopperPearsonInterval, normalQuantile, ruleOfThree, wilsonInterval, zeroFailureSampleSize } from "../../src/stats/index.js";

// Reference constants were produced once with scipy (`uv run --with scipy python tests/stats/reference/scipy_reference.py`), not by this code:
//   norm.ppf(q)
//   binomtest(k, n).proportion_ci(confidence_level=c, method="wilson" | "exact")
//   one-sided Clopper-Pearson: beta.ppf(c, k + 1, n - k) (upper), beta.ppf(1 - c, k, n - k + 1) (lower)
//   one-sided Wilson: the two-sided closed form with z = norm.ppf(c)
//   binom.cdf(k, n, p)
describe("normal quantile", () => {
  it.each([
    [0.5, 0],
    [0.9, 1.2815515655446004],
    [0.95, 1.6448536269514722],
    [0.975, 1.959963984540054],
    [0.99, 2.3263478740408408],
    [0.999, 3.090232306167813],
    [0.0001, -3.7190164854556804],
  ])("matches scipy at %f", (probability, expected) => {
    expect(normalQuantile(probability)).toBeCloseTo(expected, 7);
  });

  it("rejects probabilities outside the open unit interval", () => {
    expect(() => normalQuantile(0)).toThrow(RangeError);
    expect(() => normalQuantile(1)).toThrow(RangeError);
  });
});

describe("Wilson interval", () => {
  it.each([
    [27, 30, 0.7437891742081592, 0.9654001112526657],
    [0, 30, 0, 0.11351339317396875],
    [30, 30, 0.8864866068260312, 1],
    [1, 1, 0.20654931437723745, 1],
    [0, 1, 0, 0.7934506856227626],
    [15, 30, 0.3315412564053377, 0.6684587435946623],
    [3, 300, 0.003406618437715286, 0.02898349336233983],
  ])("matches scipy for %i/%i", (successes, trials, low, high) => {
    const interval = wilsonInterval(successes, trials);
    expect(interval.low).toBeCloseTo(low, 8);
    expect(interval.high).toBeCloseTo(high, 8);
  });

  it("returns exact 0 and 1 at the boundaries", () => {
    expect(wilsonInterval(0, 30).low).toBe(0);
    expect(wilsonInterval(30, 30).high).toBe(1);
  });

  it("supports other confidence levels", () => {
    const interval = wilsonInterval(27, 30, 0.99);
    expect(interval.low).toBeCloseTo(0.6807647387170973, 8);
    expect(interval.high).toBeCloseTo(0.9743483427084142, 8);
  });

  it("computes one-sided bounds", () => {
    expect(wilsonInterval(2, 30, 0.95, "upper")).toEqual({ low: 0, high: expect.closeTo(0.18271556287508756, 8) });
    expect(wilsonInterval(2, 30, 0.95, "lower")).toEqual({ low: expect.closeTo(0.02231217083333183, 8), high: 1 });
    expect(wilsonInterval(0, 300, 0.95, "upper").high).toBeCloseTo(0.008937872175128179, 8);
    expect(wilsonInterval(30, 30, 0.95, "lower").low).toBeCloseTo(0.9172756918749005, 8);
    expect(wilsonInterval(0, 1, 0.95, "upper").high).toBeCloseTo(0.7301340512159458, 8);
    expect(wilsonInterval(1, 1, 0.95, "lower").low).toBeCloseTo(0.2698659487840541, 8);
  });

  it("rejects invalid counts and confidence", () => {
    expect(() => wilsonInterval(31, 30)).toThrow(RangeError);
    expect(() => wilsonInterval(-1, 30)).toThrow(RangeError);
    expect(() => wilsonInterval(1, 0)).toThrow(RangeError);
    expect(() => wilsonInterval(1.5, 30)).toThrow(RangeError);
    expect(() => wilsonInterval(1, 30, 1)).toThrow(RangeError);
  });
});

describe("binomial CDF", () => {
  it.each([
    [3, 10, 0.5, 0.171875],
    [0, 30, 0.1, 0.042391158275216195],
    [27, 30, 0.9, 0.5886487604404944],
    [30, 30, 0.9, 1],
    [5, 300, 0.01, 0.9170964367157393],
  ])("matches scipy for P(X <= %i | n=%i, p=%f)", (successes, trials, probability, expected) => {
    expect(binomialCdf(successes, trials, probability)).toBeCloseTo(expected, 12);
  });

  it("handles degenerate probabilities", () => {
    expect(binomialCdf(0, 5, 0)).toBe(1);
    expect(binomialCdf(4, 5, 1)).toBe(0);
    expect(binomialCdf(5, 5, 1)).toBe(1);
    expect(() => binomialCdf(1, 5, 1.2)).toThrow(RangeError);
  });
});

describe("Clopper-Pearson interval", () => {
  it.each([
    [27, 30, 0.7347115495257919, 0.9788828629702773],
    [0, 30, 0, 0.11570330822202779],
    [30, 30, 0.8842966917779722, 1],
    [1, 1, 0.025, 1],
    [0, 1, 0, 0.975],
    [15, 30, 0.3129702858680275, 0.6870297141319724],
    [3, 300, 0.0020670072350923176, 0.0289445112556926],
  ])("matches scipy for %i/%i", (successes, trials, low, high) => {
    const interval = clopperPearsonInterval(successes, trials);
    expect(interval.low).toBeCloseTo(low, 10);
    expect(interval.high).toBeCloseTo(high, 10);
  });

  it("supports other confidence levels", () => {
    const interval = clopperPearsonInterval(27, 30, 0.9);
    expect(interval.low).toBeCloseTo(0.761402142706749, 10);
    expect(interval.high).toBeCloseTo(0.9721844502602504, 10);
  });

  it("computes one-sided bounds", () => {
    expect(clopperPearsonInterval(0, 300, 0.95, "upper")).toEqual({ low: 0, high: expect.closeTo(0.009936081944457708, 10) });
    expect(clopperPearsonInterval(0, 30, 0.95, "upper").high).toBeCloseTo(0.09503385285530411, 10);
    expect(clopperPearsonInterval(2, 30, 0.95, "upper").high).toBeCloseTo(0.19532604365492595, 10);
    expect(clopperPearsonInterval(2, 30, 0.95, "lower")).toEqual({ low: expect.closeTo(0.011975800965209112, 10), high: 1 });
    expect(clopperPearsonInterval(30, 30, 0.95, "lower").low).toBeCloseTo(0.9049661471446959, 10);
    expect(clopperPearsonInterval(30, 30, 0.95, "upper").high).toBe(1);
    expect(clopperPearsonInterval(0, 1, 0.95, "upper").high).toBeCloseTo(0.95, 10);
    expect(clopperPearsonInterval(1, 1, 0.95, "lower").low).toBeCloseTo(0.05, 10);
  });

  it("agrees with the closed form for zero events", () => {
    expect(clopperPearsonInterval(0, 300, 0.95, "upper").high).toBeCloseTo(1 - 0.05 ** (1 / 300), 12);
  });

  it("is never narrower than Wilson at the same confidence", () => {
    for (const successes of [0, 1, 5, 15, 29, 30]) {
      const exact = clopperPearsonInterval(successes, 30);
      const wilson = wilsonInterval(successes, 30);
      expect(exact.high - exact.low).toBeGreaterThanOrEqual(wilson.high - wilson.low);
    }
  });
});

describe("zero-failure planning", () => {
  it("needs 299 clean trials to bound a 1% rate at 95%", () => {
    // ln(0.05) / ln(0.99) = 298.07; 0.99^298 = 0.05004 (not enough), 0.99^299 = 0.04954.
    expect(zeroFailureSampleSize(0.01, 0.95)).toBe(299);
    expect(clopperPearsonInterval(0, 299, 0.95, "upper").high).toBeLessThan(0.01);
    expect(clopperPearsonInterval(0, 298, 0.95, "upper").high).toBeGreaterThan(0.01);
  });

  it("covers other targets and rejects invalid input", () => {
    expect(zeroFailureSampleSize(0.1, 0.95)).toBe(29);
    expect(zeroFailureSampleSize(0.5, 0.5)).toBe(1);
    expect(() => zeroFailureSampleSize(0, 0.95)).toThrow(RangeError);
    expect(() => zeroFailureSampleSize(0.01, 1)).toThrow(RangeError);
  });

  it("approximates the exact bound with the rule of three", () => {
    expect(ruleOfThree(300)).toBe(0.01);
    expect(ruleOfThree(300)).toBeCloseTo(clopperPearsonInterval(0, 300, 0.95, "upper").high, 3);
    expect(ruleOfThree(1)).toBe(1);
    expect(() => ruleOfThree(0)).toThrow(RangeError);
  });
});
