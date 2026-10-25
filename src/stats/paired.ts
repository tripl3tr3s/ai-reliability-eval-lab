import { binomialCdf, binomialPmf, normalQuantile, type Interval } from "./binomial.js";

export interface DiscordantCounts {
  /** Pairs where the first condition passed and the second failed. */
  readonly firstOnly: number;
  /** Pairs where the second condition passed and the first failed. */
  readonly secondOnly: number;
  readonly bothPassed: number;
  readonly bothFailed: number;
}

export interface McNemarResult extends DiscordantCounts {
  readonly pairs: number;
  readonly discordant: number;
  /** Two-sided exact p-value from Binomial(discordant, 0.5). It is 1 when there are no discordant pairs. */
  readonly pValue: number;
}

export function discordantCounts(pairs: readonly (readonly [boolean, boolean])[]): DiscordantCounts {
  let firstOnly = 0;
  let secondOnly = 0;
  let bothPassed = 0;
  let bothFailed = 0;
  for (const [first, second] of pairs) {
    if (first && second) bothPassed += 1;
    else if (first) firstOnly += 1;
    else if (second) secondOnly += 1;
    else bothFailed += 1;
  }
  return { firstOnly, secondOnly, bothPassed, bothFailed };
}

/** Exact McNemar test on paired binary outcomes. Each pair must be one independent unit (here: one case). */
export function mcnemarExact(pairs: readonly (readonly [boolean, boolean])[]): McNemarResult {
  const counts = discordantCounts(pairs);
  const discordant = counts.firstOnly + counts.secondOnly;
  const pValue = discordant === 0
    ? 1
    : Math.min(1, 2 * binomialCdf(Math.min(counts.firstOnly, counts.secondOnly), discordant, 0.5));
  return { ...counts, pairs: pairs.length, discordant, pValue };
}

/**
 * Two-sided McNemar mid-p value: 2 * (P(X < k) + P(X = k) / 2) with X ~ Binomial(discordant, 0.5) and
 * k = min(firstOnly, secondOnly). The exact conditional test is conservative because the discrete binomial
 * rarely puts exactly alpha in the tail; mid-p keeps the Type I error near nominal (Fagerland, Lydersen and
 * Laake 2014) and agrees with the Bonett-Price interval. Returns 1 without discordant pairs.
 */
export function mcnemarMidP(counts: Pick<DiscordantCounts, "firstOnly" | "secondOnly">): number {
  const discordant = counts.firstOnly + counts.secondOnly;
  if (discordant === 0) return 1;
  const smaller = Math.min(counts.firstOnly, counts.secondOnly);
  const below = smaller > 0 ? binomialCdf(smaller - 1, discordant, 0.5) : 0;
  return Math.min(1, Math.max(0, 2 * (below + 0.5 * binomialPmf(smaller, discordant, 0.5))));
}

export interface PairedDifferenceInterval extends Interval {
  /** Observed mean difference (first minus second), before any adjustment. */
  readonly estimate: number;
}

const clipUnitDifference = (value: number): number => Math.min(1, Math.max(-1, value));

function assertConfidence(confidence: number): void {
  if (!(confidence > 0 && confidence < 1)) throw new RangeError(`confidence must be strictly between 0 and 1, received ${confidence}`);
}

/**
 * Bonett-Price Laplace-adjusted Wald interval for a difference of paired proportions (Fagerland, Lydersen
 * and Laake 2014, eq. 16): p12 = (b + 1) / (n + 2), p21 = (c + 1) / (n + 2),
 * (p12 - p21) +/- z * sqrt((p12 + p21 - (p12 - p21)^2) / (n + 2)), truncated to [-1, 1].
 * The add-one adjustment keeps the width positive even with no discordant pairs.
 */
export function bonettPriceInterval(counts: DiscordantCounts, confidence = 0.95): PairedDifferenceInterval {
  assertConfidence(confidence);
  const pairs = counts.firstOnly + counts.secondOnly + counts.bothPassed + counts.bothFailed;
  if (pairs === 0) throw new RangeError("the Bonett-Price interval needs at least one pair");
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const p12 = (counts.firstOnly + 1) / (pairs + 2);
  const p21 = (counts.secondOnly + 1) / (pairs + 2);
  const difference = p12 - p21;
  const se = Math.sqrt(Math.max(p12 + p21 - difference * difference, 0) / (pairs + 2));
  return {
    estimate: (counts.firstOnly - counts.secondOnly) / pairs,
    low: clipUnitDifference(difference - z * se),
    high: clipUnitDifference(difference + z * se),
  };
}

/**
 * Item-clustered multi-run Bonett-Price interval (evalstats `bonett_price_paired_ci_multirun_cluster`).
 * `differences` holds one value per case: that case's pass rate in the first arm minus the second. The
 * single-run construction is applied with the case as the unit and two pseudo-cases of +1 and -1:
 * d~ = sum(d) / (n + 2), V~ = (sum(d^2) + 2) / (n + 2) - d~^2, d~ +/- z * sqrt(V~ / (n + 2)).
 * It equals `bonettPriceInterval` when every case has one run. Unlike evalstats' shrunk default it uses
 * only the per-case rates, so it does not depend on which repeat of one arm is paired with which repeat
 * of the other; this benchmark's repeats share no seed across arms.
 */
export function bonettPriceClusterInterval(differences: readonly number[], confidence = 0.95): PairedDifferenceInterval {
  assertConfidence(confidence);
  if (differences.length === 0) throw new RangeError("the Bonett-Price interval needs at least one case");
  if (differences.some((value) => !(value >= -1 && value <= 1))) throw new RangeError("every per-case difference must be in [-1, 1]");
  const augmented = differences.length + 2;
  const sum = differences.reduce((total, value) => total + value, 0);
  const squares = differences.reduce((total, value) => total + value * value, 0);
  const centre = sum / augmented;
  const variance = Math.max((squares + 2) / augmented - centre * centre, 0);
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const se = Math.sqrt(variance / augmented);
  return { estimate: sum / differences.length, low: clipUnitDifference(centre - z * se), high: clipUnitDifference(centre + z * se) };
}

/**
 * Two-sided p-value dual to an interval family: the smallest alpha whose interval excludes zero, found by
 * bisection exactly as evalstats `_p_value_by_inversion` does (60 steps on [1e-12, 1 - 1e-12]). Used where
 * no p-value is validated for the data, so the p-value can never disagree with its own interval.
 */
export function pValueByInversion(intervalAt: (alpha: number) => Interval): number {
  const excludesZero = (alpha: number): boolean => {
    const { low, high } = intervalAt(alpha);
    return low > 0 || high < 0;
  };
  let low = 1e-12;
  let high = 1 - 1e-12;
  if (excludesZero(low)) return 0;
  if (!excludesZero(high)) return 1;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = 0.5 * (low + high);
    if (excludesZero(middle)) high = middle;
    else low = middle;
  }
  return high;
}
