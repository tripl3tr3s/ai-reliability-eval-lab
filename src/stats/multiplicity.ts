/**
 * Per-comparison confidence that gives family-wise coverage `confidence` over `comparisons` intervals
 * (Sidak): confidence^(1/k), i.e. alpha_adj = 1 - (1 - alpha)^(1/k). evalstats uses it for simultaneous
 * intervals on binary and numeric data at every sample size.
 */
export function sidakConfidence(confidence: number, comparisons: number): number {
  if (!(confidence > 0 && confidence < 1)) throw new RangeError(`confidence must be strictly between 0 and 1, received ${confidence}`);
  if (!Number.isInteger(comparisons) || comparisons < 1) throw new RangeError(`comparisons must be a positive integer, received ${comparisons}`);
  return confidence ** (1 / comparisons);
}

/**
 * Counts of true null hypotheses that are logically possible among all k(k-1)/2 pairwise-equality tests
 * on k groups (Shaffer 1986): partition the groups into clusters of equal means, and each cluster of size
 * j contributes C(j, 2) true nulls. Recursively, S(k) is the union over j = 1..k of C(j, 2) + S(k - j),
 * with S(0) = {0}. For four groups this is {0, 1, 2, 3, 6}.
 *
 * evalstats 0.3.3 uses only {0} and C(i, 2), which omits sums such as 2 (two separate equal pairs). That
 * agrees for up to three groups and is slightly liberal from four on; this implementation is the full set.
 */
export function shafferTrueNullCounts(groups: number): readonly number[] {
  if (!Number.isInteger(groups) || groups < 2) throw new RangeError(`groups must be an integer of at least 2, received ${groups}`);
  const byGroups: Set<number>[] = [new Set([0])];
  for (let total = 1; total <= groups; total += 1) {
    const counts = new Set<number>();
    for (let cluster = 1; cluster <= total; cluster += 1) {
      for (const rest of byGroups[total - cluster]!) counts.add((cluster * (cluster - 1)) / 2 + rest);
    }
    byGroups.push(counts);
  }
  return [...byGroups[groups]!].sort((left, right) => left - right);
}

/**
 * Shaffer's modified step-down Holm adjustment for all pairwise comparisons among `groups` arms, following
 * evalstats `_shaffer_adjusted_pvalues` but with the full set of true-null counts (see above). The j-th
 * smallest p-value is multiplied by the largest possible count of true nulls not above m - j + 1, then made monotone and capped at 1. Returns the adjusted
 * p-values in the input order. For three arms the multipliers are 3, 1, 1.
 */
export function shafferAdjust(pValues: readonly number[], groups: number): readonly number[] {
  const expected = (groups * (groups - 1)) / 2;
  if (pValues.length !== expected) throw new RangeError(`Shaffer needs ${expected} p-values for ${groups} groups, received ${pValues.length}`);
  if (pValues.some((value) => !(value >= 0 && value <= 1))) throw new RangeError("every p-value must be in [0, 1]");
  const possible = shafferTrueNullCounts(groups);
  const order = pValues.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value || left.index - right.index);
  const adjusted = new Array<number>(pValues.length);
  let running = 0;
  order.forEach(({ value, index }, rank) => {
    const remaining = pValues.length - rank;
    const divisor = Math.max(1, ...possible.filter((count) => count <= remaining));
    running = Math.max(running, value * divisor);
    adjusted[index] = Math.min(running, 1);
  });
  return adjusted;
}
