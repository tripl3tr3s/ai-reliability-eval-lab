import type { RawRun, RunScore } from "./scoring.js";
import {
  clopperPearsonInterval,
  clusterBootstrap,
  DEFAULT_RESAMPLES,
  mcnemarExact,
  minimumDetectableEffect,
  pairedBootstrap,
  passAtK,
  passPowerK,
  requiredPairs,
  wilsonInterval,
  zeroFailureSampleSize,
  type CaseTally,
  type Interval,
  type McNemarResult,
} from "./stats/index.js";

export const STATISTICS_METRICS = ["completion", "headlineToolAccuracy", "recovery"] as const;
export type StatisticsMetric = (typeof STATISTICS_METRICS)[number];

const METRIC_VALUE: Readonly<Record<StatisticsMetric, (score: RunScore) => boolean | null>> = {
  completion: (score) => score.completionPassed,
  headlineToolAccuracy: (score) => score.headlineToolAccuracy,
  recovery: (score) => score.recoveryPassed,
};

const CONFIDENCE = 0.95;
const ALPHA = 0.05;
const POWER = 0.8;
const PLANNING_FAILURE_RATE = 0.01;
const PLANNING_DISCORDANCE = [0.1, 0.2, 0.3, 0.5] as const;

export interface ArmMetricStatistics {
  readonly metric: StatisticsMetric;
  /** Cases where the metric applies. This is the sample size for every interval in this block. */
  readonly cases: number;
  readonly runs: number;
  readonly passRate: number | null;
  /** Percentile bootstrap that resamples cases, keeping all repeats of a case together. */
  readonly clusteredCi95: Interval | null;
  /** Wilson interval over runs as if they were independent. Shown only for contrast; it is too narrow. */
  readonly rowLevelWilson95: Interval | null;
  readonly casesAllPassed: number;
  readonly casesMajorityPassed: number;
  /** Wilson interval on the share of cases that passed every repeat. */
  readonly allPassWilson95: Interval | null;
  /** Largest number of repeats observed for one case; the k used for pass@k and pass^k. */
  readonly repeats: number;
  readonly passAtK: number | null;
  readonly passPowerK: number | null;
}

export interface ArmStatistics {
  readonly configuration: string;
  readonly cases: number;
  readonly runs: number;
  readonly totalCostUsd: number;
  /** Null when at least one run predates token recording. */
  readonly totalTokens: number | null;
  readonly meanTokensPerRun: number | null;
  readonly metrics: readonly ArmMetricStatistics[];
}

export interface PairedComparison {
  readonly metric: StatisticsMetric;
  /** The difference is reported as first minus second. */
  readonly first: string;
  readonly second: string;
  /** Cases scored for this metric in both configurations. */
  readonly cases: number;
  readonly meanDifference: number | null;
  readonly bootstrapCi95: Interval | null;
  /** Exact McNemar test where a case passes only if every repeat passed. */
  readonly allPass: McNemarResult;
  /** Exact McNemar test where a case passes if more than half of its repeats passed. */
  readonly majority: McNemarResult;
  readonly discordanceRate: number | null;
  /** Smallest difference detectable at the observed discordance, or null when none is detectable at this n. */
  readonly minimumDetectableEffect: number | null;
  /** Cases needed to detect a difference even if every discordant case favoured one side. */
  readonly casesNeededAtObservedDiscordance: number | null;
}

export interface DetectionLimits {
  readonly cases: number;
  readonly repeatsPerCase: number;
  /** One-sided 95% Clopper-Pearson upper bound on a failure rate after zero failures in `cases` cases. */
  readonly zeroFailureUpperBound95: number | null;
  readonly planningFailureRate: number;
  readonly casesToBoundPlanningFailureRate: number;
  readonly planning: readonly { readonly discordanceRate: number; readonly minimumDetectableEffect: number | null; readonly casesNeeded: number }[];
}

export interface RunStatistics {
  readonly method: {
    readonly unitOfAnalysis: "case";
    readonly confidence: number;
    readonly bootstrap: "percentile";
    readonly resamples: number;
    readonly seed: number;
    readonly alpha: number;
    readonly power: number;
  };
  readonly arms: readonly ArmStatistics[];
  readonly comparisons: readonly PairedComparison[];
  readonly detection: DetectionLimits;
}

const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const plain = ({ low, high }: Interval): Interval => ({ low, high });

/** One tally per case for one metric in one configuration, skipping runs where the metric does not apply. */
export function caseTallies(scores: readonly RunScore[], configuration: string, metric: StatisticsMetric): readonly CaseTally[] {
  const tallies = new Map<string, { passes: number; trials: number }>();
  for (const score of scores) {
    if (score.configuration !== configuration) continue;
    const value = METRIC_VALUE[metric](score);
    if (value === null) continue;
    const tally = tallies.get(score.caseId) ?? { passes: 0, trials: 0 };
    tallies.set(score.caseId, { passes: tally.passes + Number(value), trials: tally.trials + 1 });
  }
  return [...tallies.entries()].sort(([left], [right]) => byText(left, right)).map(([caseId, tally]) => ({ caseId, ...tally }));
}

const pooledRate = (tallies: readonly CaseTally[]): number | null => {
  const trials = tallies.reduce((sum, tally) => sum + tally.trials, 0);
  return trials === 0 ? null : tallies.reduce((sum, tally) => sum + tally.passes, 0) / trials;
};
const allPassed = ({ passes, trials }: CaseTally): boolean => passes === trials;
const majorityPassed = ({ passes, trials }: CaseTally): boolean => passes * 2 > trials;

function armMetric(scores: readonly RunScore[], configuration: string, metric: StatisticsMetric, seed: number): ArmMetricStatistics {
  const tallies = caseTallies(scores, configuration, metric);
  const runs = tallies.reduce((sum, { trials }) => sum + trials, 0);
  const passes = tallies.reduce((sum, tally) => sum + tally.passes, 0);
  const repeats = tallies.reduce((largest, { trials }) => Math.max(largest, trials), 0);
  const casesAllPassed = tallies.filter(allPassed).length;
  const clustered = clusterBootstrap(tallies, pooledRate, { seed, confidence: CONFIDENCE });
  return {
    metric,
    cases: tallies.length,
    runs,
    passRate: pooledRate(tallies),
    clusteredCi95: clustered === null ? null : plain(clustered),
    rowLevelWilson95: runs === 0 ? null : wilsonInterval(passes, runs, CONFIDENCE),
    casesAllPassed,
    casesMajorityPassed: tallies.filter(majorityPassed).length,
    allPassWilson95: tallies.length === 0 ? null : wilsonInterval(casesAllPassed, tallies.length, CONFIDENCE),
    repeats,
    passAtK: repeats === 0 ? null : passAtK(tallies, repeats),
    passPowerK: repeats === 0 ? null : passPowerK(tallies, repeats),
  };
}

function compare(scores: readonly RunScore[], first: string, second: string, metric: StatisticsMetric, seed: number): PairedComparison {
  const secondByCase = new Map(caseTallies(scores, second, metric).map((tally) => [tally.caseId, tally]));
  const pairs = caseTallies(scores, first, metric).flatMap((tally) => {
    const other = secondByCase.get(tally.caseId);
    return other ? [[tally, other] as const] : [];
  });
  const bootstrap = pairedBootstrap(pairs.map(([left, right]) => [left.passes / left.trials, right.passes / right.trials] as const), { seed, confidence: CONFIDENCE });
  const allPass = mcnemarExact(pairs.map(([left, right]) => [allPassed(left), allPassed(right)] as const));
  const discordanceRate = pairs.length === 0 ? null : allPass.discordant / pairs.length;
  return {
    metric,
    first,
    second,
    cases: pairs.length,
    meanDifference: bootstrap?.estimate ?? null,
    bootstrapCi95: bootstrap === null ? null : plain(bootstrap),
    allPass,
    majority: mcnemarExact(pairs.map(([left, right]) => [majorityPassed(left), majorityPassed(right)] as const)),
    discordanceRate,
    minimumDetectableEffect: discordanceRate === null ? null : minimumDetectableEffect(pairs.length, discordanceRate, { alpha: ALPHA, power: POWER }),
    casesNeededAtObservedDiscordance: discordanceRate === null || discordanceRate === 0 ? null : Math.ceil(requiredPairs(discordanceRate, discordanceRate, { alpha: ALPHA, power: POWER })),
  };
}

/**
 * Case-level statistics for a scored run. The case is the unit of analysis throughout:
 * repeats of one case are never treated as independent observations.
 */
export function computeRunStatistics(scores: readonly RunScore[], runs: readonly RawRun[], seed: number): RunStatistics {
  const configurations = [...new Set(scores.map(({ configuration }) => configuration))].sort(byText);
  const arms = configurations.map((configuration, armIndex): ArmStatistics => {
    const armRuns = runs.filter((run) => run.configuration === configuration);
    const tokens = armRuns.map((run) => run.tokens);
    const totalTokens = armRuns.length > 0 && tokens.every((value): value is number => typeof value === "number")
      ? tokens.reduce((sum, value) => sum + value, 0)
      : null;
    return {
      configuration,
      cases: new Set(armRuns.map(({ caseId }) => caseId)).size,
      runs: armRuns.length,
      totalCostUsd: armRuns.reduce((sum, run) => sum + run.costUsd, 0),
      totalTokens,
      meanTokensPerRun: totalTokens === null ? null : totalTokens / armRuns.length,
      metrics: STATISTICS_METRICS.map((metric, metricIndex) => armMetric(scores, configuration, metric, seed + 1_000 + armIndex * 100 + metricIndex)),
    };
  });
  const comparisons = STATISTICS_METRICS.flatMap((metric, metricIndex) =>
    configurations.flatMap((first, firstIndex) =>
      configurations.slice(firstIndex + 1).map((second, offset) =>
        compare(scores, first, second, metric, seed + 50_000 + metricIndex * 1_000 + firstIndex * 100 + offset))));
  const cases = new Set(scores.map(({ caseId }) => caseId)).size;
  return {
    method: { unitOfAnalysis: "case", confidence: CONFIDENCE, bootstrap: "percentile", resamples: DEFAULT_RESAMPLES, seed, alpha: ALPHA, power: POWER },
    arms,
    comparisons,
    detection: {
      cases,
      repeatsPerCase: arms.reduce((largest, arm) => Math.max(largest, ...arm.metrics.map(({ repeats }) => repeats)), 0),
      zeroFailureUpperBound95: cases === 0 ? null : clopperPearsonInterval(0, cases, CONFIDENCE, "upper").high,
      planningFailureRate: PLANNING_FAILURE_RATE,
      casesToBoundPlanningFailureRate: zeroFailureSampleSize(PLANNING_FAILURE_RATE, CONFIDENCE),
      planning: PLANNING_DISCORDANCE.map((discordanceRate) => ({
        discordanceRate,
        minimumDetectableEffect: cases === 0 ? null : minimumDetectableEffect(cases, discordanceRate, { alpha: ALPHA, power: POWER }),
        casesNeeded: Math.ceil(requiredPairs(discordanceRate, discordanceRate, { alpha: ALPHA, power: POWER })),
      })),
    },
  };
}

export interface ReportTable { readonly caption: string; readonly head: readonly string[]; readonly rows: readonly (readonly string[])[] }
export interface ReportSection { readonly title: string; readonly paragraphs: readonly string[]; readonly tables: readonly ReportTable[] }

const percent = (value: number | null): string => value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
const points = (value: number | null): string => value === null ? "N/A" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pts`;
const range = (interval: Interval | null, format: (value: number) => string = percent): string => interval === null ? "N/A" : `${format(interval.low)} to ${format(interval.high)}`;
const pValue = (value: number): string => value < 0.001 ? "<0.001" : value.toFixed(3);
const METRIC_LABEL: Readonly<Record<StatisticsMetric, string>> = { completion: "Completion", headlineToolAccuracy: "Tool accuracy", recovery: "Recovery" };

/** Renders the statistics as format-neutral sections so Markdown and HTML stay in step. */
export function statisticsSections(statistics: RunStatistics): readonly ReportSection[] {
  const { detection } = statistics;
  if (statistics.arms.length === 0) return [];
  return [
    {
      title: "Reliability by case",
      paragraphs: [
        `The unit of analysis is the case. Intervals are 95% percentile bootstraps that resample cases (${statistics.method.resamples} resamples, seed ${statistics.method.seed}) and keep all repeats of a case together.`,
        "pass@k is the chance that at least one of k attempts passes, 1 - (1 - p)^k. pass^k is the chance that all k attempts pass, p^k. Both are computed per case and then averaged, with k equal to the repeats per case.",
      ],
      tables: [{
        caption: "Per-configuration pass rates with case-clustered intervals",
        head: ["Configuration", "Metric", "Cases", "Pass rate", "95% CI (case-clustered)", "Cases passing every repeat", "Wilson 95% on that share", "k", "pass@k", "pass^k"],
        rows: statistics.arms.flatMap((arm) => arm.metrics.map((item) => [
          arm.configuration, METRIC_LABEL[item.metric], String(item.cases), percent(item.passRate), range(item.clusteredCi95),
          `${item.casesAllPassed}/${item.cases}`, range(item.allPassWilson95), String(item.repeats), percent(item.passAtK), percent(item.passPowerK),
        ])),
      }],
    },
    {
      title: "Cost and tokens",
      paragraphs: ["Tokens are recorded per run from provider usage. Runs recorded before token capture show N/A."],
      tables: [{
        caption: "Spend and token usage by configuration",
        head: ["Configuration", "Runs", "Total cost", "Total tokens", "Mean tokens per run"],
        rows: statistics.arms.map((arm) => [
          arm.configuration, String(arm.runs), `$${arm.totalCostUsd.toFixed(4)}`,
          arm.totalTokens === null ? "N/A" : String(arm.totalTokens), arm.meanTokensPerRun === null ? "N/A" : arm.meanTokensPerRun.toFixed(0),
        ]),
      }],
    },
    {
      title: "Paired comparisons",
      paragraphs: [
        "Configurations run the same cases, so they are compared within case. The difference is the mean over cases of the per-case pass rate in the first configuration minus the second, with a paired bootstrap interval.",
        "McNemar's exact test needs one binary outcome per case. The primary rule counts a case as passed only if every repeat passed; the majority rule is shown as a sensitivity check.",
      ],
      tables: [{
        caption: "Paired differences between configurations",
        head: ["Metric", "First minus second", "Cases", "Mean difference", "95% CI (paired bootstrap)", "Discordant cases (first only / second only)", "McNemar exact p (every repeat)", "McNemar exact p (majority)"],
        rows: statistics.comparisons.map((item) => [
          METRIC_LABEL[item.metric], `${item.first} minus ${item.second}`, String(item.cases), points(item.meanDifference), range(item.bootstrapCi95, points),
          `${item.allPass.firstOnly} / ${item.allPass.secondOnly}`, pValue(item.allPass.pValue), pValue(item.majority.pValue),
        ]),
      }],
    },
    {
      title: "What this run can and cannot detect",
      paragraphs: [
        `This run covers ${detection.cases} cases with up to ${detection.repeatsPerCase} repeats per case. Repeats are draws from the same case: they show how stable a case is, but ${detection.repeatsPerCase} repeats are not ${detection.repeatsPerCase} times as many independent samples. The sample size for every claim here is ${detection.cases}.`,
        `Zero failures in ${detection.cases} cases would still leave a one-sided 95% upper bound of ${percent(detection.zeroFailureUpperBound95)} on the failure rate. Showing a rate below ${percent(detection.planningFailureRate)} with zero failures needs ${detection.casesToBoundPlanningFailureRate} cases.`,
        `Minimum detectable differences use a two-sided alpha of ${statistics.method.alpha} and ${percent(statistics.method.power)} power for a paired binary comparison. A difference can never exceed the share of discordant cases, so low discordance at small n means nothing is detectable.`,
      ],
      tables: [
        {
          caption: "Detectable difference at the observed discordance",
          head: ["Metric", "Comparison", "Cases", "Observed discordance", "Minimum detectable difference"],
          rows: statistics.comparisons.map((item) => [
            METRIC_LABEL[item.metric], `${item.first} vs ${item.second}`, String(item.cases), percent(item.discordanceRate),
            item.minimumDetectableEffect !== null
              ? points(item.minimumDetectableEffect).replace("+", "")
              : item.casesNeededAtObservedDiscordance === null
                ? "No discordant cases observed; see planning table"
                : `Not detectable at ${item.cases} cases (needs at least ${item.casesNeededAtObservedDiscordance})`,
          ]),
        },
        {
          caption: `Planning: detectable difference at ${detection.cases} cases by assumed discordance`,
          head: ["Assumed discordance", "Minimum detectable difference", "Cases needed to detect anything"],
          rows: detection.planning.map((item) => [
            percent(item.discordanceRate),
            item.minimumDetectableEffect === null ? "Not detectable" : points(item.minimumDetectableEffect).replace("+", ""),
            String(item.casesNeeded),
          ]),
        },
      ],
    },
  ];
}
