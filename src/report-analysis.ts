import { caseTallies, STATISTICS_METRICS, type StatisticsMetric } from "./report-statistics.js";
import type { RawRun, RunScore } from "./scoring.js";
import {
  bonettPriceClusterInterval,
  bonettPriceInterval,
  discordantCounts,
  iccOneWay,
  mcnemarMidP,
  passAtKUnbiased,
  passPowerKUnbiased,
  pValueByInversion,
  shafferAdjust,
  sidakConfidence,
  tInterval,
  wilsonInterval,
  wilsonOnCaseRates,
  type CaseTally,
  type DiscordantCounts,
  type IntraclassCorrelation,
  type Interval,
} from "./stats/index.js";

/**
 * Analysis plan v2 (docs/decisions/2026-10-24-analysis-plan-v2.md). The primary outcome is binary per case:
 * the case passed only if every repeat passed. Everything here is deterministic, so a replay of the same
 * raw rows gives byte-identical output.
 */
const FAMILY_CONFIDENCE = 0.95;

export type Verdict = "first_better" | "second_better" | "indistinguishable";
export type ParetoLabel = "frontier" | "dominated" | "ambiguous";

export interface PrimaryArm {
  readonly metric: StatisticsMetric;
  readonly configuration: string;
  readonly cases: number;
  readonly casesAllPassed: number;
  readonly share: number | null;
  /** Wilson interval on the share, at the family confidence (one arm, one interval). */
  readonly wilson95: Interval | null;
  /** Possible ranks from best to worst: 1 + arms significantly better, and k - arms significantly worse. */
  readonly rankBand: { readonly best: number; readonly worst: number };
}

export interface PrimaryComparison {
  readonly metric: StatisticsMetric;
  /** Differences are first minus second. */
  readonly first: string;
  readonly second: string;
  /** Cases scored for this metric in both configurations. */
  readonly cases: number;
  /** Paired cases whose two arms have a different number of scored repeats (missing runs). Each still counts once. */
  readonly unequalRepeats: number;
  readonly counts: DiscordantCounts;
  readonly difference: number | null;
  /** Per-comparison confidence after the Sidak correction for the comparisons of one metric. */
  readonly confidence: number;
  /** Bonett-Price adjusted Wald interval at `confidence`. */
  readonly interval: Interval | null;
  /** Unadjusted two-sided McNemar mid-p. */
  readonly midP: number | null;
  /** Shaffer-adjusted mid-p over the comparisons of one metric; equal to midP with two configurations. */
  readonly adjustedP: number | null;
  readonly verdict: Verdict | null;
}

export interface SecondaryArm {
  readonly metric: StatisticsMetric;
  readonly configuration: string;
  readonly cases: number;
  /** Mean over cases of the per-case pass rate, so every case weighs the same whatever its repeat count. */
  readonly meanCaseRate: number | null;
  readonly wilsonOnCaseRates95: Interval | null;
}

export interface SecondaryComparison {
  readonly metric: StatisticsMetric;
  readonly first: string;
  readonly second: string;
  readonly cases: number;
  readonly difference: number | null;
  readonly confidence: number;
  /** Case-clustered Bonett-Price interval on the difference of per-case rates. */
  readonly interval: Interval | null;
  /** p-value by inverting the interval, then Shaffer-adjusted like the primary. */
  readonly pValue: number | null;
  readonly adjustedP: number | null;
  readonly verdict: Verdict | null;
}

export interface ArmStability {
  readonly metric: StatisticsMetric;
  readonly configuration: string;
  readonly cases: number;
  /** Cases where some repeats passed and some failed. */
  readonly mixedCases: number;
  readonly icc: IntraclassCorrelation | null;
  /** k for the unbiased estimates: the smallest repeat count of any case. */
  readonly k: number;
  readonly passPowerK: number | null;
  readonly passAtK: number | null;
}

export const RUN_OUTCOMES = ["completed", "abstained", "failed", "bounded"] as const;
export const NOT_RECORDED = "not_recorded";

export interface ArmOutcomes {
  readonly configuration: string;
  readonly runs: number;
  readonly byOutcome: Readonly<Record<(typeof RUN_OUTCOMES)[number], number>>;
  /** Termination reasons of bounded and failed runs, keys sorted. Rows written before the field read as not_recorded. */
  readonly byTerminationReason: Readonly<Record<string, number>>;
}

export interface Sensitivity {
  readonly rule: string;
  readonly casesKept: number;
  readonly droppedCaseIds: readonly string[];
  readonly comparisons: readonly PrimaryComparison[];
}

export interface RatioEstimate {
  /** Geometric mean over cases of first / second. */
  readonly ratio: number;
  readonly low: number;
  readonly high: number;
  readonly confidence: number;
}

export interface EfficiencyArm {
  readonly configuration: string;
  readonly cases: number;
  /** Mean over cases of the per-case mean, over every run including failed and bounded ones. */
  readonly meanCostUsdPerCase: number | null;
  readonly meanLatencyMsPerCase: number | null;
  readonly pareto: ParetoLabel;
}

export interface EfficiencyComparison {
  readonly first: string;
  readonly second: string;
  readonly cases: number;
  /** Paired cases left out of the cost ratio because a per-case mean cost was zero in either arm. */
  readonly casesWithoutCost: number;
  /** Null when fewer than two cases have a nonzero mean in both arms, or the log ratios have no spread. */
  readonly cost: RatioEstimate | null;
  /** Descriptive only: latency includes provider queueing and is not reproducible. */
  readonly latency: RatioEstimate | null;
}

export interface RunAnalysis {
  readonly primary: {
    readonly estimand: "all-pass";
    readonly familyConfidence: number;
    readonly comparisonsPerMetric: number;
    readonly comparisonConfidence: number;
    readonly arms: readonly PrimaryArm[];
    readonly comparisons: readonly PrimaryComparison[];
  };
  readonly secondary: {
    readonly estimand: "per-case-rate";
    readonly arms: readonly SecondaryArm[];
    readonly comparisons: readonly SecondaryComparison[];
  };
  readonly stability: { readonly validated: false; readonly arms: readonly ArmStability[] };
  readonly outcomes: readonly ArmOutcomes[];
  readonly sensitivity: Sensitivity;
  readonly efficiency: { readonly arms: readonly EfficiencyArm[]; readonly comparisons: readonly EfficiencyComparison[] };
  readonly scope: string;
}

const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const plain = ({ low, high }: Interval): Interval => ({ low, high });
const allPassed = ({ passes, trials }: CaseTally): boolean => passes === trials;

const verdictOf = (interval: Interval | null): Verdict | null => interval === null
  ? null
  : interval.low > 0 ? "first_better" : interval.high < 0 ? "second_better" : "indistinguishable";

const pairsOf = <T>(items: readonly T[]): readonly (readonly [T, T])[] =>
  items.flatMap((first, index) => items.slice(index + 1).map((second) => [first, second] as const));

function pairedTallies(scores: readonly RunScore[], first: string, second: string, metric: StatisticsMetric): readonly (readonly [CaseTally, CaseTally])[] {
  const secondByCase = new Map(caseTallies(scores, second, metric).map((tally) => [tally.caseId, tally]));
  return caseTallies(scores, first, metric).flatMap((tally) => {
    const other = secondByCase.get(tally.caseId);
    return other ? [[tally, other] as const] : [];
  });
}

/** Shaffer over the comparisons of one metric. A missing p-value (no paired cases) enters as 1 and stays null. */
function adjust(pValues: readonly (number | null)[], groups: number): readonly (number | null)[] {
  if (pValues.length === 0) return [];
  const adjusted = shafferAdjust(pValues.map((value) => value ?? 1), groups);
  return adjusted.map((value, index) => (pValues[index] === null ? null : value));
}

function primaryComparisons(scores: readonly RunScore[], configurations: readonly string[], confidence: number): readonly PrimaryComparison[] {
  return STATISTICS_METRICS.flatMap((metric) => {
    const raw = pairsOf(configurations).map(([first, second]) => {
      const pairs = pairedTallies(scores, first, second, metric);
      const counts = discordantCounts(pairs.map(([left, right]) => [allPassed(left), allPassed(right)] as const));
      const interval = pairs.length === 0 ? null : bonettPriceInterval(counts, confidence);
      return {
        metric, first, second, cases: pairs.length,
        unequalRepeats: pairs.filter(([left, right]) => left.trials !== right.trials).length,
        counts,
        difference: interval?.estimate ?? null,
        confidence,
        interval: interval === null ? null : plain(interval),
        midP: pairs.length === 0 ? null : mcnemarMidP(counts),
        verdict: verdictOf(interval),
      };
    });
    const adjusted = adjust(raw.map(({ midP }) => midP), configurations.length);
    return raw.map((item, index): PrimaryComparison => ({ ...item, adjustedP: adjusted[index] ?? null }));
  });
}

function rankBand(configuration: string, metric: StatisticsMetric, configurations: readonly string[], comparisons: readonly PrimaryComparison[]): PrimaryArm["rankBand"] {
  const own = comparisons.filter((item) => item.metric === metric && (item.first === configuration || item.second === configuration));
  const better = own.filter((item) => (item.first === configuration ? item.verdict === "second_better" : item.verdict === "first_better")).length;
  const worse = own.filter((item) => (item.first === configuration ? item.verdict === "first_better" : item.verdict === "second_better")).length;
  return { best: 1 + better, worst: configurations.length - worse };
}

function secondaryComparisons(scores: readonly RunScore[], configurations: readonly string[], confidence: number): readonly SecondaryComparison[] {
  return STATISTICS_METRICS.flatMap((metric) => {
    const raw = pairsOf(configurations).map(([first, second]) => {
      const differences = pairedTallies(scores, first, second, metric).map(([left, right]) => left.passes / left.trials - right.passes / right.trials);
      const interval = differences.length === 0 ? null : bonettPriceClusterInterval(differences, confidence);
      return {
        metric, first, second, cases: differences.length,
        difference: interval?.estimate ?? null,
        confidence,
        interval: interval === null ? null : plain(interval),
        pValue: differences.length === 0 ? null : pValueByInversion((alpha) => bonettPriceClusterInterval(differences, 1 - alpha)),
        verdict: verdictOf(interval),
      };
    });
    const adjusted = adjust(raw.map(({ pValue }) => pValue), configurations.length);
    return raw.map((item, index): SecondaryComparison => ({ ...item, adjustedP: adjusted[index] ?? null }));
  });
}

function stability(scores: readonly RunScore[], configuration: string, metric: StatisticsMetric): ArmStability {
  const tallies = caseTallies(scores, configuration, metric);
  const k = tallies.length === 0 ? 0 : Math.min(...tallies.map(({ trials }) => trials));
  return {
    metric,
    configuration,
    cases: tallies.length,
    mixedCases: tallies.filter(({ passes, trials }) => passes > 0 && passes < trials).length,
    icc: iccOneWay(tallies),
    k,
    passPowerK: k === 0 ? null : passPowerKUnbiased(tallies, k),
    passAtK: k === 0 ? null : passAtKUnbiased(tallies, k),
  };
}

function outcomes(runs: readonly RawRun[], configuration: string): ArmOutcomes {
  const armRuns = runs.filter((run) => run.configuration === configuration);
  const stopped = armRuns.filter(({ outcome }) => outcome === "bounded" || outcome === "failed");
  const reasons = [...new Set(stopped.map(({ terminationReason }) => terminationReason ?? NOT_RECORDED))].sort(byText);
  return {
    configuration,
    runs: armRuns.length,
    byOutcome: Object.fromEntries(RUN_OUTCOMES.map((outcome) => [outcome, armRuns.filter((run) => run.outcome === outcome).length])) as ArmOutcomes["byOutcome"],
    byTerminationReason: Object.fromEntries(reasons.map((reason) => [reason, stopped.filter(({ terminationReason }) => (terminationReason ?? NOT_RECORDED) === reason).length])),
  };
}

/** Per-case means of one run field for one configuration, keyed by case. */
function caseMeans(runs: readonly RawRun[], configuration: string, field: (run: RawRun) => number): ReadonlyMap<string, number> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const run of runs) {
    if (run.configuration !== configuration) continue;
    const entry = sums.get(run.caseId) ?? { total: 0, count: 0 };
    sums.set(run.caseId, { total: entry.total + field(run), count: entry.count + 1 });
  }
  return new Map([...sums.entries()].sort(([left], [right]) => byText(left, right)).map(([caseId, { total, count }]) => [caseId, total / count]));
}

const meanOf = (values: Iterable<number>): number | null => {
  const list = [...values];
  return list.length === 0 ? null : list.reduce((sum, value) => sum + value, 0) / list.length;
};

/**
 * Paired t interval on the mean per-case log ratio, reported as a geometric-mean ratio. Cases with a zero
 * mean in either arm (no provider call, or a mock run) have no ratio; they are left out and counted.
 */
function ratio(first: ReadonlyMap<string, number>, second: ReadonlyMap<string, number>, confidence: number): { cases: number; excluded: number; estimate: RatioEstimate | null } {
  const pairs = [...first.entries()].flatMap(([caseId, value]) => {
    const other = second.get(caseId);
    return other === undefined ? [] : [[value, other] as const];
  });
  const usable = pairs.filter(([left, right]) => left > 0 && right > 0);
  const interval = tInterval(usable.map(([left, right]) => Math.log(left / right)), confidence);
  return {
    cases: pairs.length,
    excluded: pairs.length - usable.length,
    estimate: interval === null ? null : { ratio: Math.exp(interval.estimate), low: Math.exp(interval.low), high: Math.exp(interval.high), confidence },
  };
}

/**
 * Y dominates X only when Y is significantly better on primary completion and significantly cheaper. An arm
 * no other arm dominates is on the frontier when every pairing with it is decided on at least one axis in
 * its favour, and ambiguous otherwise.
 */
function paretoLabels(configurations: readonly string[], primary: readonly PrimaryComparison[], comparisons: readonly EfficiencyComparison[]): ReadonlyMap<string, ParetoLabel> {
  const quality = (configuration: string, other: string): "better" | "worse" | "same" => {
    const item = primary.find((entry) => entry.metric === "completion" && ((entry.first === configuration && entry.second === other) || (entry.first === other && entry.second === configuration)));
    if (!item || item.verdict === null || item.verdict === "indistinguishable") return "same";
    const firstWins = item.verdict === "first_better";
    return (item.first === configuration) === firstWins ? "better" : "worse";
  };
  const cost = (configuration: string, other: string): "cheaper" | "dearer" | "same" => {
    const item = comparisons.find((entry) => (entry.first === configuration && entry.second === other) || (entry.first === other && entry.second === configuration));
    if (!item?.cost) return "same";
    const firstCheaper = item.cost.high < 1;
    const firstDearer = item.cost.low > 1;
    if (!firstCheaper && !firstDearer) return "same";
    return (item.first === configuration) === firstCheaper ? "cheaper" : "dearer";
  };
  return new Map(configurations.map((configuration) => {
    const others = configurations.filter((other) => other !== configuration);
    if (others.some((other) => quality(configuration, other) === "worse" && cost(configuration, other) === "dearer")) return [configuration, "dominated"] as const;
    const decided = others.length > 0 && others.every((other) => quality(configuration, other) === "better" || cost(configuration, other) === "cheaper");
    return [configuration, decided ? "frontier" : "ambiguous"] as const;
  }));
}

export function scopeStatement(cases: number, configurations: readonly string[]): string {
  return `Intervals and tests describe sampling variation over these ${cases} cases and the ${configurations.length} configurations listed. They do not describe real fiscal traffic, other prompts, other tool sets, or model versions other than those recorded in the manifest. A difference that is not significant here is not evidence that the configurations are equivalent.`;
}

export const SENSITIVITY_RULE = "Drops every case with a bounded or failed run in any configuration, then repeats the primary analysis. A shift between the two shows how much the primary result depends on runs that stopped early.";

/** Case-level analysis under analysis plan v2. `scores` and `runs` are the same rows, scored and raw. */
export function computeRunAnalysis(scores: readonly RunScore[], runs: readonly RawRun[]): RunAnalysis {
  const configurations = [...new Set(scores.map(({ configuration }) => configuration))].sort(byText);
  const comparisonsPerMetric = (configurations.length * (configurations.length - 1)) / 2;
  const confidence = comparisonsPerMetric === 0 ? FAMILY_CONFIDENCE : sidakConfidence(FAMILY_CONFIDENCE, comparisonsPerMetric);
  const primary = primaryComparisons(scores, configurations, confidence);
  const metricsByArm = configurations.flatMap((configuration) => STATISTICS_METRICS.map((metric) => ({ configuration, metric, tallies: caseTallies(scores, configuration, metric) })));

  const stoppedCases = new Set(runs.filter(({ outcome }) => outcome === "bounded" || outcome === "failed").map(({ caseId }) => caseId));
  const keptScores = scores.filter(({ caseId }) => !stoppedCases.has(caseId));

  const costs = new Map(configurations.map((configuration) => [configuration, caseMeans(runs, configuration, (run) => run.costUsd)]));
  const latencies = new Map(configurations.map((configuration) => [configuration, caseMeans(runs, configuration, (run) => run.latencyMs)]));
  const efficiencyComparisons = pairsOf(configurations).map(([first, second]): EfficiencyComparison => {
    const cost = ratio(costs.get(first)!, costs.get(second)!, confidence);
    return { first, second, cases: cost.cases, casesWithoutCost: cost.excluded, cost: cost.estimate, latency: ratio(latencies.get(first)!, latencies.get(second)!, confidence).estimate };
  });
  const pareto = paretoLabels(configurations, primary, efficiencyComparisons);

  return {
    primary: {
      estimand: "all-pass",
      familyConfidence: FAMILY_CONFIDENCE,
      comparisonsPerMetric,
      comparisonConfidence: confidence,
      arms: metricsByArm.map(({ configuration, metric, tallies }): PrimaryArm => {
        const casesAllPassed = tallies.filter(allPassed).length;
        return {
          metric, configuration, cases: tallies.length, casesAllPassed,
          share: tallies.length === 0 ? null : casesAllPassed / tallies.length,
          wilson95: tallies.length === 0 ? null : wilsonInterval(casesAllPassed, tallies.length, FAMILY_CONFIDENCE),
          rankBand: rankBand(configuration, metric, configurations, primary),
        };
      }),
      comparisons: primary,
    },
    secondary: {
      estimand: "per-case-rate",
      arms: metricsByArm.map(({ configuration, metric, tallies }): SecondaryArm => {
        const rates = tallies.map(({ passes, trials }) => passes / trials);
        return { metric, configuration, cases: tallies.length, meanCaseRate: meanOf(rates), wilsonOnCaseRates95: rates.length === 0 ? null : wilsonOnCaseRates(rates, FAMILY_CONFIDENCE) };
      }),
      comparisons: secondaryComparisons(scores, configurations, confidence),
    },
    stability: { validated: false, arms: metricsByArm.map(({ configuration, metric }) => stability(scores, configuration, metric)) },
    outcomes: configurations.map((configuration) => outcomes(runs, configuration)),
    sensitivity: {
      rule: SENSITIVITY_RULE,
      casesKept: new Set(keptScores.map(({ caseId }) => caseId)).size,
      droppedCaseIds: [...stoppedCases].filter((caseId) => scores.some((score) => score.caseId === caseId)).sort(byText),
      comparisons: primaryComparisons(keptScores, configurations, confidence),
    },
    efficiency: {
      arms: configurations.map((configuration): EfficiencyArm => ({
        configuration,
        cases: costs.get(configuration)!.size,
        meanCostUsdPerCase: meanOf(costs.get(configuration)!.values()),
        meanLatencyMsPerCase: meanOf(latencies.get(configuration)!.values()),
        pareto: pareto.get(configuration)!,
      })),
      comparisons: efficiencyComparisons,
    },
    scope: scopeStatement(new Set(scores.map(({ caseId }) => caseId)).size, configurations),
  };
}
