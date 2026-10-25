import type { Interval } from "./binomial.js";

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
] as const;

/** Natural log of the gamma function for x > 0 (Lanczos, g = 7), accurate to about 1e-15. */
export function logGamma(x: number): number {
  if (!(x > 0)) throw new RangeError(`logGamma needs x > 0, received ${x}`);
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const shifted = x - 1;
  let series = LANCZOS[0];
  for (let index = 1; index < LANCZOS.length; index += 1) series += LANCZOS[index]! / (shifted + index);
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(series);
}

/** Continued fraction for the incomplete beta function (modified Lentz). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= 10_000; m += 1) {
    const even = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + even * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + even / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    result *= d * c;
    const odd = (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + odd * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + odd / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const step = d * c;
    result *= step;
    if (Math.abs(step - 1) < 1e-16) return result;
  }
  throw new Error("incomplete beta continued fraction did not converge");
}

/** Regularized incomplete beta I_x(a, b) for x in [0, 1] and a, b > 0. */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (!(a > 0 && b > 0)) throw new RangeError("the incomplete beta needs a > 0 and b > 0");
  if (!(x >= 0 && x <= 1)) throw new RangeError(`x must be in [0, 1], received ${x}`);
  if (x === 0 || x === 1) return x;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(x, a, b)) / a
    : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

function assertDegreesOfFreedom(df: number): void {
  if (!(df > 0) || !Number.isFinite(df)) throw new RangeError(`degrees of freedom must be positive and finite, received ${df}`);
}

/** Student t cumulative distribution function. */
export function studentTCdf(t: number, df: number): number {
  assertDegreesOfFreedom(df);
  if (Number.isNaN(t)) throw new RangeError("t must be a number");
  if (t === Infinity) return 1;
  if (t === -Infinity) return 0;
  const tail = 0.5 * regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

/**
 * Student t quantile by bisection on the CDF. Matches scipy.stats.t.ppf to about 1e-12 for the degrees of
 * freedom a benchmark uses (1 to a few hundred).
 */
export function studentTQuantile(probability: number, df: number): number {
  assertDegreesOfFreedom(df);
  if (!(probability > 0 && probability < 1)) throw new RangeError(`probability must be strictly between 0 and 1, received ${probability}`);
  if (probability === 0.5) return 0;
  let high = 1;
  while (studentTCdf(high, df) < probability) high *= 2;
  let low = -1;
  while (studentTCdf(low, df) > probability) low *= 2;
  for (let iteration = 0; iteration < 200 && high - low > 1e-15 * Math.max(1, Math.abs(high)); iteration += 1) {
    const middle = 0.5 * (low + high);
    if (studentTCdf(middle, df) < probability) low = middle;
    else high = middle;
  }
  return 0.5 * (low + high);
}

export interface MeanInterval extends Interval {
  readonly estimate: number;
  /** Observations behind the interval. */
  readonly n: number;
}

/**
 * Two-sided Student t interval for a mean, mean +/- t(n - 1, 1 - alpha / 2) * s / sqrt(n), as evalstats
 * `t_interval_ci_1d` computes it. Null with fewer than two values or no spread: evalstats returns a
 * zero-width point there, which says nothing about uncertainty, so this benchmark reports no interval.
 */
export function tInterval(values: readonly number[], confidence = 0.95): MeanInterval | null {
  if (!(confidence > 0 && confidence < 1)) throw new RangeError(`confidence must be strictly between 0 and 1, received ${confidence}`);
  if (values.some((value) => !Number.isFinite(value))) throw new RangeError("every value must be finite");
  const n = values.length;
  // Checked on the values themselves: rounding in the mean gives identical values a tiny nonzero variance.
  if (n < 2 || values.every((value) => value === values[0])) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  if (!(se > 0)) return null;
  const t = studentTQuantile(1 - (1 - confidence) / 2, n - 1);
  return { estimate: mean, low: mean - t * se, high: mean + t * se, n };
}
