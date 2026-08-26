import { bootstrapCi, type ConfigurationSummary, type RunScore } from "./scoring.js";

export interface Regression { configuration: string; metric: string; baseline: number; candidate: number; change: number; threshold: number; pairedCi95?: { low: number; high: number } }
export interface BaselineComparison { accepted: boolean; regressions: readonly Regression[]; requiresReviewedPromotion: true }

function pairedBootstrap<T>(pairs: readonly (readonly [T, T])[], statistic: (rows: readonly T[]) => number | null, seed: number): { low: number; high: number } | null {
  let state = seed >>> 0;
  const random = () => { state = Math.imul(state + 0x6d2b79f5, 48271) >>> 0; return state / 4294967296; };
  const changes = Array.from({ length: 2_000 }, () => {
    const sample = Array.from({ length: pairs.length }, () => pairs[Math.floor(random() * pairs.length)]!);
    const oldValue = statistic(sample.map(([oldRow]) => oldRow));
    const newValue = statistic(sample.map(([, newRow]) => newRow));
    return oldValue === null || newValue === null || oldValue === 0 ? null : newValue / oldValue - 1;
  }).filter((value): value is number => value !== null).sort((left, right) => left - right);
  return changes.length === 0 ? null : { low: changes[Math.floor(changes.length * 0.025)]!, high: changes[Math.min(changes.length - 1, Math.ceil(changes.length * 0.975) - 1)]! };
}

export function compareBaseline(baseline: readonly ConfigurationSummary[], candidate: readonly ConfigurationSummary[], approvedQualityTradeoff = false): BaselineComparison {
  const regressions: Regression[] = [];
  const quality = ["completion", "recovery", "argumentAccuracy", "headlineToolAccuracy"] as const;
  for (const current of candidate) {
    const previous = baseline.find(({ configuration }) => configuration === current.configuration);
    if (!previous) { regressions.push({ configuration: current.configuration, metric: "missing_baseline_configuration", baseline: 0, candidate: 0, change: 0, threshold: 0 }); continue; }
    for (const metric of quality) {
      const oldValue = previous[metric].value;
      const newValue = current[metric].value;
      if (oldValue !== null && newValue !== null && oldValue - newValue > 0.03) regressions.push({ configuration: current.configuration, metric, baseline: oldValue, candidate: newValue, change: newValue - oldValue, threshold: -0.03 });
    }
    const oldUnsupported = previous.unsupportedClaimRate.value;
    const newUnsupported = current.unsupportedClaimRate.value;
    if (oldUnsupported !== null && newUnsupported !== null && newUnsupported - oldUnsupported > 0.01) regressions.push({ configuration: current.configuration, metric: "unsupportedClaimRate", baseline: oldUnsupported, candidate: newUnsupported, change: newUnsupported - oldUnsupported, threshold: 0.01 });
    if (!approvedQualityTradeoff) {
      for (const metric of ["costPerSuccessfulTask", "p95LatencyMs"] as const) {
        const oldValue = previous[metric].value;
        const newValue = current[metric].value;
        if (oldValue !== null && newValue !== null && oldValue > 0 && newValue / oldValue - 1 > 0.15) regressions.push({ configuration: current.configuration, metric, baseline: oldValue, candidate: newValue, change: newValue / oldValue - 1, threshold: 0.15 });
      }
    }
  }
  return { accepted: regressions.length === 0, regressions, requiresReviewedPromotion: true };
}

type PairedMetric = "completionPassed" | "recoveryPassed" | "argumentAccuracy" | "headlineToolAccuracy" | "unsupportedClaimRate" | "costUsd" | "latencyMs";

export function comparePairedBaseline(baseline: readonly RunScore[], candidate: readonly RunScore[], approvedQualityTradeoff = false, seed = 1): BaselineComparison {
  const regressions: Regression[] = [];
  const key = ({ configuration, caseId, repeat }: RunScore) => `${configuration}:${caseId}:${repeat}`;
  const oldByKey = new Map(baseline.map((row) => [key(row), row]));
  const newByKey = new Map(candidate.map((row) => [key(row), row]));
  const allKeys = new Set([...oldByKey.keys(), ...newByKey.keys()]);
  const missing = [...allKeys].filter((pairKey) => !oldByKey.has(pairKey) || !newByKey.has(pairKey));
  if (missing.length > 0) return { accepted: false, regressions: [{ configuration: "all", metric: "missing_paired_runs", baseline: baseline.length, candidate: candidate.length, change: missing.length, threshold: 0 }], requiresReviewedPromotion: true };
  const configurations = [...new Set(candidate.map(({ configuration }) => configuration))].sort();
  const numeric = (value: boolean | number | null): number | null => value === null ? null : Number(value);
  const average = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  for (const [configurationIndex, configuration] of configurations.entries()) {
    const pairs = [...allKeys].filter((pairKey) => newByKey.get(pairKey)?.configuration === configuration).map((pairKey) => [oldByKey.get(pairKey)!, newByKey.get(pairKey)!] as const);
    const checks: readonly { metric: PairedMetric; threshold: number; direction: "lower" | "higher"; skip?: boolean }[] = [
      { metric: "completionPassed", threshold: 0.03, direction: "lower" },
      { metric: "recoveryPassed", threshold: 0.03, direction: "lower" },
      { metric: "argumentAccuracy", threshold: 0.03, direction: "lower" },
      { metric: "headlineToolAccuracy", threshold: 0.03, direction: "lower" },
      { metric: "unsupportedClaimRate", threshold: 0.01, direction: "higher" },
    ];
    for (const check of checks) {
      if (check.skip) continue;
      const applicable = pairs.map(([oldRow, newRow]) => [numeric(oldRow[check.metric]), numeric(newRow[check.metric])] as const).filter((pair): pair is readonly [number, number] => pair[0] !== null && pair[1] !== null);
      if (applicable.length === 0) continue;
      const oldValue = average(applicable.map(([value]) => value));
      const newValue = average(applicable.map(([, value]) => value));
      const relative = check.metric === "costUsd" || check.metric === "latencyMs";
      const deltas = applicable.map(([oldItem, newItem]) => relative ? (oldItem === 0 ? 0 : newItem / oldItem - 1) : newItem - oldItem);
      const change = relative ? (oldValue === 0 ? 0 : newValue / oldValue - 1) : newValue - oldValue;
      const ci95 = bootstrapCi(deltas, seed + configurationIndex * 31 + checks.indexOf(check));
      const regressed = check.direction === "lower" ? change < -check.threshold : change > check.threshold;
      if (regressed) regressions.push({ configuration, metric: check.metric, baseline: oldValue, candidate: newValue, change, threshold: check.direction === "lower" ? -check.threshold : check.threshold, ...(ci95 === null ? {} : { pairedCi95: ci95 }) });
    }
    if (!approvedQualityTradeoff) {
      const efficiency = (rows: readonly RunScore[]) => {
        const successes = rows.filter(({ completionPassed }) => completionPassed);
        const latency = successes.map(({ latencyMs }) => latencyMs).sort((left, right) => left - right);
        return { cost: successes.length === 0 ? null : rows.reduce((sum, row) => sum + row.costUsd, 0) / successes.length, p95: latency[Math.max(0, Math.ceil(latency.length * 0.95) - 1)] ?? null };
      };
      const oldEfficiency = efficiency(pairs.map(([row]) => row));
      const newEfficiency = efficiency(pairs.map(([, row]) => row));
      for (const item of [{ metric: "costPerSuccessfulTask", oldValue: oldEfficiency.cost, newValue: newEfficiency.cost }, { metric: "p95LatencyMs", oldValue: oldEfficiency.p95, newValue: newEfficiency.p95 }]) {
        if (item.oldValue !== null && item.newValue !== null && item.oldValue > 0) {
          const change = item.newValue / item.oldValue - 1;
          const statistic = item.metric === "costPerSuccessfulTask" ? (rows: readonly RunScore[]) => efficiency(rows).cost : (rows: readonly RunScore[]) => efficiency(rows).p95;
          const ci95 = pairedBootstrap(pairs, statistic, seed + configurationIndex * 31 + (item.metric === "costPerSuccessfulTask" ? 23 : 24));
          if (change > 0.15) regressions.push({ configuration, metric: item.metric, baseline: item.oldValue, candidate: item.newValue, change, threshold: 0.15, ...(ci95 === null ? {} : { pairedCi95: ci95 }) });
        }
      }
    }
  }
  return { accepted: regressions.length === 0, regressions, requiresReviewedPromotion: true };
}
