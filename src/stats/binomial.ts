export interface Interval { readonly low: number; readonly high: number }
export type Sided = "two-sided" | "lower" | "upper";

function assertCounts(successes: number, trials: number): void {
  if (!Number.isInteger(trials) || trials < 1) throw new RangeError(`trials must be a positive integer, received ${trials}`);
  if (!Number.isInteger(successes) || successes < 0 || successes > trials) throw new RangeError(`successes must be an integer in [0, ${trials}], received ${successes}`);
}

function assertOpenUnit(name: string, value: number): void {
  if (!(value > 0 && value < 1)) throw new RangeError(`${name} must be strictly between 0 and 1, received ${value}`);
}

/** Tail mass placed on each reported bound: alpha/2 for a two-sided interval, alpha for a one-sided bound. */
function tailMass(confidence: number, sided: Sided): number {
  assertOpenUnit("confidence", confidence);
  return sided === "two-sided" ? (1 - confidence) / 2 : 1 - confidence;
}

/** Standard normal quantile (Acklam's rational approximation, relative error below 1.2e-9). */
export function normalQuantile(probability: number): number {
  assertOpenUnit("probability", probability);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239] as const;
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1] as const;
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783] as const;
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416] as const;
  const low = 0.02425;
  const tail = (q: number): number =>
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  if (probability < low) return tail(Math.sqrt(-2 * Math.log(probability)));
  if (probability > 1 - low) return -tail(Math.sqrt(-2 * Math.log(1 - probability)));
  const q = probability - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Wilson score interval for a binomial proportion. One-sided variants return [0, upper] or [lower, 1]. */
export function wilsonInterval(successes: number, trials: number, confidence = 0.95, sided: Sided = "two-sided"): Interval {
  assertCounts(successes, trials);
  const z = normalQuantile(1 - tailMass(confidence, sided));
  const proportion = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = (proportion + (z * z) / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((proportion * (1 - proportion)) / trials + (z * z) / (4 * trials * trials))) / denominator;
  return {
    low: sided === "upper" || successes === 0 ? 0 : Math.max(0, centre - half),
    high: sided === "lower" || successes === trials ? 1 : Math.min(1, centre + half),
  };
}

const logFactorials: number[] = [0];
function logFactorial(value: number): number {
  for (let next = logFactorials.length; next <= value; next += 1) logFactorials.push(logFactorials[next - 1]! + Math.log(next));
  return logFactorials[value]!;
}

function binomialMass(from: number, to: number, trials: number, probability: number): number {
  if (from > to) return 0;
  if (probability <= 0) return from === 0 ? 1 : 0;
  if (probability >= 1) return to === trials ? 1 : 0;
  const logP = Math.log(probability);
  const logQ = Math.log1p(-probability);
  let sum = 0;
  for (let index = from; index <= to; index += 1) {
    sum += Math.exp(logFactorial(trials) - logFactorial(index) - logFactorial(trials - index) + index * logP + (trials - index) * logQ);
  }
  return Math.min(1, sum);
}

/** Exact P(X <= successes) for X ~ Binomial(trials, probability). */
export function binomialCdf(successes: number, trials: number, probability: number): number {
  assertCounts(successes, trials);
  if (!(probability >= 0 && probability <= 1)) throw new RangeError(`probability must be in [0, 1], received ${probability}`);
  return binomialMass(0, successes, trials, probability);
}

/** Finds the root of a function that is monotone on [0, 1] by bisection. */
function bisectUnit(isBelowRoot: (candidate: number) => boolean): number {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 200 && high - low > Number.EPSILON * Math.max(1, high); iteration += 1) {
    const middle = (low + high) / 2;
    if (isBelowRoot(middle)) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/**
 * Clopper-Pearson (exact) interval, found by bisection on the binomial tail probabilities.
 * The upper bound solves P(X <= k | p) = tail and the lower bound solves P(X >= k | p) = tail.
 */
export function clopperPearsonInterval(successes: number, trials: number, confidence = 0.95, sided: Sided = "two-sided"): Interval {
  assertCounts(successes, trials);
  const tail = tailMass(confidence, sided);
  const high = sided === "lower" || successes === trials
    ? 1
    : bisectUnit((candidate) => binomialMass(0, successes, trials, candidate) > tail);
  const low = sided === "upper" || successes === 0
    ? 0
    : bisectUnit((candidate) => binomialMass(successes, trials, trials, candidate) < tail);
  return { low, high };
}

/** Smallest n such that n failure-free trials bound the failure rate below `maxFailureRate` at the given confidence. */
export function zeroFailureSampleSize(maxFailureRate: number, confidence = 0.95): number {
  assertOpenUnit("maxFailureRate", maxFailureRate);
  assertOpenUnit("confidence", confidence);
  return Math.ceil(Math.log(1 - confidence) / Math.log1p(-maxFailureRate));
}

/** Rule of three: approximate one-sided 95% upper bound on a rate after n trials with zero events. */
export function ruleOfThree(trials: number): number {
  if (!Number.isInteger(trials) || trials < 1) throw new RangeError(`trials must be a positive integer, received ${trials}`);
  return Math.min(1, 3 / trials);
}
