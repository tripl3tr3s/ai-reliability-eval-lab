export interface CaseTally {
  readonly caseId: string;
  readonly passes: number;
  readonly trials: number;
}

/** Collapses run rows into one tally per case, ordered by case id. */
export function tallyByCase(rows: readonly { readonly caseId: string; readonly passed: boolean }[]): readonly CaseTally[] {
  const tallies = new Map<string, { passes: number; trials: number }>();
  for (const { caseId, passed } of rows) {
    const tally = tallies.get(caseId) ?? { passes: 0, trials: 0 };
    tallies.set(caseId, { passes: tally.passes + Number(passed), trials: tally.trials + 1 });
  }
  return [...tallies.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([caseId, tally]) => ({ caseId, ...tally }));
}

function assertAttempts(attempts: number): void {
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError(`k must be a positive integer, received ${attempts}`);
}

const usable = (tallies: readonly CaseTally[]): readonly CaseTally[] => tallies.filter(({ trials }) => trials > 0);

/**
 * pass@k: probability that at least one of k attempts passes, 1 - (1 - p)^k,
 * computed per case from that case's own pass rate and then averaged over cases.
 */
export function passAtK(tallies: readonly CaseTally[], attempts: number): number | null {
  assertAttempts(attempts);
  const cases = usable(tallies);
  if (cases.length === 0) return null;
  return cases.reduce((sum, { passes, trials }) => sum + (1 - (1 - passes / trials) ** attempts), 0) / cases.length;
}

/**
 * pass^k: probability that all k attempts pass, p^k,
 * computed per case from that case's own pass rate and then averaged over cases.
 */
export function passPowerK(tallies: readonly CaseTally[], attempts: number): number | null {
  assertAttempts(attempts);
  const cases = usable(tallies);
  if (cases.length === 0) return null;
  return cases.reduce((sum, { passes, trials }) => sum + (passes / trials) ** attempts, 0) / cases.length;
}

export interface IntraclassCorrelation {
  /** One-way random-effects ICC(1) of the per-run outcome within a case. Can be negative. */
  readonly icc: number;
  /** Average repeats per case adjusted for unequal group sizes, k0 = (N - sum n_i^2 / N) / (g - 1). */
  readonly repeatsPerCase: number;
  /** Kish design effect 1 + (k0 - 1) * ICC: how much a run-level variance understates the case-level one. */
  readonly designEffect: number;
  readonly cases: number;
  readonly runs: number;
}

/**
 * One-way ANOVA ICC(1) for binary outcomes grouped by case:
 * (MSB - MSW) / (MSB + (k0 - 1) * MSW). Null with fewer than two cases, no within-case degrees of
 * freedom, or no variance at all (every run passed, or every run failed), where the ICC is undefined.
 * A multi-run stability summary: evalstats does not yet validate interval methods built on it.
 */
export function iccOneWay(tallies: readonly CaseTally[]): IntraclassCorrelation | null {
  const cases = usable(tallies);
  const runs = cases.reduce((sum, { trials }) => sum + trials, 0);
  if (cases.length < 2 || runs - cases.length < 1) return null;
  const grand = cases.reduce((sum, { passes }) => sum + passes, 0) / runs;
  const between = cases.reduce((sum, { passes, trials }) => sum + trials * (passes / trials - grand) ** 2, 0) / (cases.length - 1);
  const within = cases.reduce((sum, { passes, trials }) => sum + passes - (passes * passes) / trials, 0) / (runs - cases.length);
  const repeatsPerCase = (runs - cases.reduce((sum, { trials }) => sum + trials * trials, 0) / runs) / (cases.length - 1);
  const denominator = between + (repeatsPerCase - 1) * within;
  if (!(denominator > 0)) return null;
  const icc = (between - within) / denominator;
  return { icc, repeatsPerCase, designEffect: 1 + (repeatsPerCase - 1) * icc, cases: cases.length, runs };
}

/** C(passes, k) / C(trials, k) without forming large binomial coefficients. */
const allOfKFromCase = (passes: number, trials: number, attempts: number): number => {
  let product = 1;
  for (let index = 0; index < attempts; index += 1) product *= (passes - index) / (trials - index);
  return Math.max(0, product);
};

function unbiasedCases(tallies: readonly CaseTally[], attempts: number): readonly CaseTally[] | null {
  assertAttempts(attempts);
  const cases = usable(tallies);
  if (cases.length === 0 || cases.some(({ trials }) => trials < attempts)) return null;
  return cases;
}

/**
 * Unbiased pass^k per case, C(c, k) / C(n, k) for c passes in n runs (the tau-bench estimator), averaged
 * over cases. With k equal to the repeats it is the share of cases that passed every repeat. Null when a
 * case has fewer runs than k. Unlike the plug-in p^k, it is not biased upward.
 */
export function passPowerKUnbiased(tallies: readonly CaseTally[], attempts: number): number | null {
  const cases = unbiasedCases(tallies, attempts);
  if (cases === null) return null;
  return cases.reduce((sum, { passes, trials }) => sum + allOfKFromCase(passes, trials, attempts), 0) / cases.length;
}

/** Unbiased pass@k per case, 1 - C(n - c, k) / C(n, k) (Chen et al. 2021), averaged over cases. Null when a case has fewer runs than k. */
export function passAtKUnbiased(tallies: readonly CaseTally[], attempts: number): number | null {
  const cases = unbiasedCases(tallies, attempts);
  if (cases === null) return null;
  return cases.reduce((sum, { passes, trials }) => sum + 1 - allOfKFromCase(trials - passes, trials, attempts), 0) / cases.length;
}
