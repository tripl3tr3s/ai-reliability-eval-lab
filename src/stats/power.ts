import { normalQuantile } from "./binomial.js";

export interface PowerOptions {
  /** Two-sided significance level. */
  readonly alpha?: number;
  readonly power?: number;
}

function quantiles(options: PowerOptions): { zAlpha: number; zBeta: number } {
  return { zAlpha: normalQuantile(1 - (options.alpha ?? 0.05) / 2), zBeta: normalQuantile(options.power ?? 0.8) };
}

function assertDiscordance(discordanceRate: number): void {
  if (!(discordanceRate >= 0 && discordanceRate <= 1)) throw new RangeError(`discordanceRate must be in [0, 1], received ${discordanceRate}`);
}

/**
 * Pairs needed to detect a difference `delta` in paired pass rates with a McNemar-type test,
 * given the share of discordant pairs (normal approximation, Connor 1987):
 * n = (z_alpha * sqrt(psi) + z_beta * sqrt(psi - delta^2))^2 / delta^2.
 */
export function requiredPairs(delta: number, discordanceRate: number, options: PowerOptions = {}): number {
  assertDiscordance(discordanceRate);
  const size = Math.abs(delta);
  if (!(size > 0 && size <= discordanceRate)) throw new RangeError(`|delta| must be in (0, discordanceRate], received ${delta}`);
  const { zAlpha, zBeta } = quantiles(options);
  return (zAlpha * Math.sqrt(discordanceRate) + zBeta * Math.sqrt(discordanceRate - size * size)) ** 2 / (size * size);
}

/**
 * Smallest absolute difference in paired pass rates detectable with `pairs` independent pairs.
 * The difference cannot exceed the discordance rate, so the result is null when even a fully
 * one-directional disagreement would be undetectable at this sample size.
 */
export function minimumDetectableEffect(pairs: number, discordanceRate: number, options: PowerOptions = {}): number | null {
  if (!Number.isInteger(pairs) || pairs < 1) throw new RangeError(`pairs must be a positive integer, received ${pairs}`);
  assertDiscordance(discordanceRate);
  if (discordanceRate === 0 || requiredPairs(discordanceRate, discordanceRate, options) > pairs) return null;
  let low = 0;
  let high = discordanceRate;
  for (let iteration = 0; iteration < 200 && high - low > 1e-15; iteration += 1) {
    const middle = (low + high) / 2;
    if (middle === 0 || requiredPairs(middle, discordanceRate, options) > pairs) low = middle;
    else high = middle;
  }
  return high;
}
