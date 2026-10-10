import { mulberry32 } from "./prng.js";

export interface BootstrapOptions {
  readonly seed: number;
  readonly resamples?: number;
  readonly confidence?: number;
}

export interface BootstrapInterval {
  /** Statistic on the original sample. */
  readonly estimate: number;
  readonly low: number;
  readonly high: number;
  readonly confidence: number;
  readonly resamples: number;
  /** Resamples where the statistic was defined. Lower than `resamples` signals an unstable statistic. */
  readonly validResamples: number;
}

export const DEFAULT_RESAMPLES = 10_000;

/** Linear-interpolation quantile of an ascending array (the "type 7" definition used by numpy and R). */
export function quantileSorted(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) throw new RangeError("quantile of an empty sample is undefined");
  if (!(probability >= 0 && probability <= 1)) throw new RangeError(`probability must be in [0, 1], received ${probability}`);
  const position = probability * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

/**
 * Percentile bootstrap that resamples whole clusters with replacement.
 * Pass one element per independent unit (one case with all of its repeats), never one element per run.
 * Returns null when there are no clusters or the statistic is undefined on the original sample.
 */
export function clusterBootstrap<T>(
  clusters: readonly T[],
  statistic: (sample: readonly T[]) => number | null,
  options: BootstrapOptions,
): BootstrapInterval | null {
  const resamples = options.resamples ?? DEFAULT_RESAMPLES;
  const confidence = options.confidence ?? 0.95;
  if (!Number.isInteger(resamples) || resamples < 1) throw new RangeError(`resamples must be a positive integer, received ${resamples}`);
  if (!(confidence > 0 && confidence < 1)) throw new RangeError(`confidence must be strictly between 0 and 1, received ${confidence}`);
  if (clusters.length === 0) return null;
  const estimate = statistic(clusters);
  if (estimate === null || !Number.isFinite(estimate)) return null;
  const random = mulberry32(options.seed);
  const estimates: number[] = [];
  for (let resample = 0; resample < resamples; resample += 1) {
    const sample = Array.from({ length: clusters.length }, () => clusters[Math.floor(random() * clusters.length)]!);
    const value = statistic(sample);
    if (value !== null && Number.isFinite(value)) estimates.push(value);
  }
  if (estimates.length === 0) return null;
  estimates.sort((left, right) => left - right);
  const tail = (1 - confidence) / 2;
  return {
    estimate,
    low: quantileSorted(estimates, tail),
    high: quantileSorted(estimates, 1 - tail),
    confidence,
    resamples,
    validResamples: estimates.length,
  };
}

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Paired bootstrap of the mean difference (first minus second).
 * Each pair is resampled as a unit, so the within-pair correlation is preserved.
 */
export function pairedBootstrap(pairs: readonly (readonly [number, number])[], options: BootstrapOptions): BootstrapInterval | null {
  return clusterBootstrap(pairs, (sample) => mean(sample.map(([first, second]) => first - second)), options);
}

/** Groups rows into clusters, ordered by key so the result does not depend on input order. */
export function groupByCluster<T>(rows: readonly T[], keyOf: (row: T) => string): readonly (readonly T[])[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, group]) => group);
}
