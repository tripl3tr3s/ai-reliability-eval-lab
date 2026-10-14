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
