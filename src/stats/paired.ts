import { binomialCdf } from "./binomial.js";

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
