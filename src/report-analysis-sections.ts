import type { PrimaryComparison, RatioEstimate, RunAnalysis, Verdict } from "./report-analysis.js";
import { RUN_OUTCOMES } from "./report-analysis.js";
import type { ReportSection, ReportTable, StatisticsMetric } from "./report-statistics.js";
import type { Interval } from "./stats/index.js";

const percent = (value: number | null): string => value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
const points = (value: number | null): string => value === null ? "N/A" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pts`;
const range = (interval: Interval | null, format: (value: number) => string = percent): string => interval === null ? "N/A" : `${format(interval.low)} to ${format(interval.high)}`;
const pValue = (value: number | null): string => value === null ? "N/A" : value < 0.001 ? "<0.001" : value.toFixed(3);
const decimal = (value: number | null, digits: number): string => value === null ? "N/A" : value.toFixed(digits);
const usd = (value: number | null): string => value === null ? "N/A" : `$${value.toFixed(4)}`;
const ms = (value: number | null): string => value === null ? "N/A" : `${value.toFixed(0)} ms`;
const ratioText = (estimate: RatioEstimate | null): string => estimate === null ? "Not estimable" : `${estimate.ratio.toFixed(3)}x (${estimate.low.toFixed(3)}x to ${estimate.high.toFixed(3)}x)`;
const confidenceLabel = (confidence: number): string => `${(confidence * 100).toFixed(2)}%`;

export const METRIC_LABEL: Readonly<Record<StatisticsMetric, string>> = { completion: "Completion", headlineToolAccuracy: "Tool accuracy", recovery: "Recovery" };

const verdictText = (verdict: Verdict | null, first: string, second: string): string => {
  switch (verdict) {
    case "first_better": return `${first} better`;
    case "second_better": return `${second} better`;
    case "indistinguishable": return "No significant difference";
    case null: return "No paired cases";
  }
};

/** Headline table: the primary outcome per configuration, with the mean cost and latency per case. */
export function headlineTable(analysis: RunAnalysis): ReportTable {
  const configurations = analysis.efficiency.arms.map(({ configuration }) => configuration);
  const cell = (configuration: string, metric: StatisticsMetric): string => {
    const arm = analysis.primary.arms.find((item) => item.configuration === configuration && item.metric === metric);
    return !arm || arm.cases === 0 ? "N/A" : `${arm.casesAllPassed}/${arm.cases} cases, ${percent(arm.share)} (${range(arm.wilson95)})`;
  };
  return {
    caption: "Headline: cases that passed every repeat, with Wilson 95% intervals, and mean cost and latency per case over all runs",
    head: ["Configuration", "Completion", "Tool accuracy", "Recovery", "Mean cost per case", "Mean latency per case"],
    rows: configurations.map((configuration) => {
      const efficiency = analysis.efficiency.arms.find((item) => item.configuration === configuration)!;
      return [configuration, cell(configuration, "completion"), cell(configuration, "headlineToolAccuracy"), cell(configuration, "recovery"), usd(efficiency.meanCostUsdPerCase), ms(efficiency.meanLatencyMsPerCase)];
    }),
  };
}

function primaryTable(caption: string, comparisons: readonly PrimaryComparison[], confidence: number): ReportTable {
  return {
    caption,
    head: ["Metric", "First minus second", "Cases", "Unequal repeats", "Discordant (first only / second only)", "Difference", `${confidenceLabel(confidence)} CI (Bonett-Price)`, "McNemar mid-p", "Shaffer-adjusted p", "Verdict"],
    rows: comparisons.map((item) => [
      METRIC_LABEL[item.metric], `${item.first} minus ${item.second}`, String(item.cases), String(item.unequalRepeats), `${item.counts.firstOnly} / ${item.counts.secondOnly}`,
      points(item.difference), range(item.interval, points), pValue(item.midP), pValue(item.adjustedP), verdictText(item.verdict, item.first, item.second),
    ]),
  };
}

/** Sections for analysis plan v2, in reading order. */
export function analysisSections(analysis: RunAnalysis): readonly ReportSection[] {
  if (analysis.efficiency.arms.length === 0) return [];
  const { primary, secondary, stability, sensitivity, efficiency } = analysis;
  const multiple = primary.comparisonsPerMetric > 1;
  const correction = multiple
    ? `There are ${primary.comparisonsPerMetric} comparisons per metric, so each interval is at the Sidak-adjusted ${confidenceLabel(primary.comparisonConfidence)} level for ${percent(primary.familyConfidence)} simultaneous coverage, and p-values are Shaffer-adjusted.`
    : "There is one comparison per metric, so no multiplicity correction applies and the adjusted p equals the mid-p.";
  return [
    {
      title: "Scope",
      paragraphs: [analysis.scope, "Latency includes provider queueing and network time, so it is descriptive and never decides a comparison."],
      tables: [],
    },
    {
      title: "Primary comparison: every repeat passed",
      paragraphs: [
        "The primary outcome is binary per case: a case passes only if every one of its repeats passed. Configurations run the same cases, so they are compared within case with the Bonett-Price adjusted Wald interval for paired proportions and the McNemar mid-p test, the methods evalstats uses for binary data at every sample size.",
        correction,
        "A verdict names a better configuration only when its interval excludes zero; the p-values are shown for reference and do not drive it. The Shaffer step-down can be less conservative than the Sidak interval, so with three or more arms a row can show an adjusted p below 0.05 and no significant difference. Cases whose arms have a different number of scored repeats (missing runs) are counted in the table. The rank band is the range of ranks an arm could hold: 1 plus the arms significantly better than it, to the number of arms minus those significantly worse.",
      ],
      tables: [
        primaryTable("Paired differences in the share of cases that passed every repeat", primary.comparisons, primary.comparisonConfidence),
        {
          caption: "Share of cases that passed every repeat, with rank bands",
          head: ["Configuration", "Metric", "Cases passing every repeat", "Wilson 95%", "Rank band"],
          rows: primary.arms.map((item) => [
            item.configuration, METRIC_LABEL[item.metric], item.cases === 0 ? "N/A" : `${item.casesAllPassed}/${item.cases}`, range(item.wilson95),
            item.rankBand.best === item.rankBand.worst ? String(item.rankBand.best) : `${item.rankBand.best} to ${item.rankBand.worst}`,
          ]),
        },
      ],
    },
    {
      title: "Secondary comparison: per-case pass rate",
      paragraphs: [
        "The secondary outcome is each case's pass rate over its repeats. Arms use the Wilson interval on per-case rates and comparisons use the case-clustered Bonett-Price interval with its inverted p-value. Both are multi-run methods that evalstats has not yet validated, so they inform but do not decide.",
        "When the primary and secondary results disagree, the configurations differ in how consistently they pass a case, not only in how often.",
      ],
      tables: [
        {
          caption: "Mean per-case pass rate",
          head: ["Configuration", "Metric", "Cases", "Mean per-case rate", "Wilson 95% on per-case rates"],
          rows: secondary.arms.map((item) => [item.configuration, METRIC_LABEL[item.metric], String(item.cases), percent(item.meanCaseRate), range(item.wilsonOnCaseRates95)]),
        },
        {
          caption: "Paired differences in per-case pass rate",
          head: ["Metric", "First minus second", "Cases", "Difference", `${confidenceLabel(primary.comparisonConfidence)} CI (case-clustered Bonett-Price)`, "p by inversion", "Shaffer-adjusted p", "Verdict"],
          rows: secondary.comparisons.map((item) => [
            METRIC_LABEL[item.metric], `${item.first} minus ${item.second}`, String(item.cases), points(item.difference), range(item.interval, points),
            pValue(item.pValue), pValue(item.adjustedP), verdictText(item.verdict, item.first, item.second),
          ]),
        },
      ],
    },
    {
      title: "Stability across repeats (not validated)",
      paragraphs: [
        "ICC(1) is the share of outcome variance that lies between cases. Near 1, repeats of a case agree and add little information; near 0, they behave like fresh samples. The design effect is how much a run-level variance understates the case-level one. ICC is N/A when every run of an arm passed, or every run failed.",
        "pass^k and pass@k are the unbiased estimators, C(c, k) / C(n, k) and 1 - C(n - c, k) / C(n, k) per case, with k the smallest repeat count. These are multi-run summaries without validated intervals.",
      ],
      tables: [{
        caption: "Run-to-run stability by configuration",
        head: ["Configuration", "Metric", "Cases", "Mixed cases", "ICC(1)", "Design effect", "k", "pass^k", "pass@k"],
        rows: stability.arms.map((item) => [
          item.configuration, METRIC_LABEL[item.metric], String(item.cases), String(item.mixedCases), decimal(item.icc?.icc ?? null, 3),
          decimal(item.icc?.designEffect ?? null, 2), String(item.k), percent(item.passPowerK), percent(item.passAtK),
        ]),
      }],
    },
    {
      title: "Run outcomes and why runs stopped",
      paragraphs: ["Bounded and failed runs fail completion and are kept in the primary and secondary analyses; only the sensitivity analysis below drops them. Termination reasons come from the raw rows; rows written before reasons were recorded show not_recorded."],
      tables: [{
        caption: "Outcomes by configuration",
        head: ["Configuration", "Runs", ...RUN_OUTCOMES.map((outcome) => outcome[0]!.toUpperCase() + outcome.slice(1)), "Termination reasons"],
        rows: analysis.outcomes.map((item) => {
          const reasons = Object.entries(item.byTerminationReason).map(([reason, count]) => `${reason} ${count}`);
          return [item.configuration, String(item.runs), ...RUN_OUTCOMES.map((outcome) => String(item.byOutcome[outcome])), reasons.length === 0 ? "None" : reasons.join(", ")];
        }),
      }],
    },
    {
      title: "Sensitivity: without cases that stopped early",
      paragraphs: sensitivity.droppedCaseIds.length === 0
        ? [`${sensitivity.rule} No case had a bounded or failed run, so this analysis equals the primary one.`]
        : [`${sensitivity.rule} ${sensitivity.droppedCaseIds.length} cases were dropped and ${sensitivity.casesKept} kept. This is a sensitivity check, not the primary result.`],
      tables: sensitivity.droppedCaseIds.length === 0 ? [] : [primaryTable("Primary comparison without cases that stopped early", sensitivity.comparisons, primary.comparisonConfidence)],
    },
    {
      title: "Cost and latency per case",
      paragraphs: [
        "Cost and latency are averaged per case over every run, including failed and bounded ones, so an arm is not made cheaper or faster by failing. Configurations are compared by the geometric mean over cases of the cost ratio, with a Student t interval on the mean log ratio at the same per-comparison level as the primary.",
        "An arm is dominated only when another arm is significantly better on primary completion and significantly cheaper. It is on the frontier when every other arm is significantly worse than it on one of the two, and ambiguous otherwise. Cases with a zero mean cost in either arm (no provider call, or mock runs) have no ratio; they are left out and counted. A ratio is not estimable when fewer than two cases remain or the ratios have no spread, as when every case costs exactly the same multiple.",
      ],
      tables: [
        {
          caption: "Mean cost and latency per case",
          head: ["Configuration", "Cases", "Mean cost per case", "Mean latency per case", "Cost and quality"],
          rows: efficiency.arms.map((item) => [item.configuration, String(item.cases), usd(item.meanCostUsdPerCase), ms(item.meanLatencyMsPerCase), item.pareto[0]!.toUpperCase() + item.pareto.slice(1)]),
        },
        {
          caption: "Paired cost and latency ratios",
          head: ["First over second", "Cases", "Cases without cost", `Cost ratio (${confidenceLabel(primary.comparisonConfidence)} CI)`, "Latency ratio (descriptive)"],
          rows: efficiency.comparisons.map((item) => [`${item.first} over ${item.second}`, String(item.cases), String(item.casesWithoutCost), ratioText(item.cost), ratioText(item.latency)]),
        },
      ],
    },
  ];
}
