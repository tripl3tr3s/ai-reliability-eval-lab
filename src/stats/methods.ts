/**
 * Version of the statistical methods in this directory. Recorded with every report and gate decision so a
 * result can be tied to the exact formulas that produced it. Bump it when a method changes its output.
 */
export const STATS_METHODS_VERSION = "stats-methods-v2";

/** Reference implementation the binary methods are checked against (tests/stats/reference). */
export const STATS_REFERENCE = { package: "evalstats", version: "0.3.3" } as const;

/** Stable identifiers for the methods a report or gate can name in its output. */
export const STATS_METHODS = {
  wilson: "Wilson score interval",
  wilsonOnCaseRates: "Wilson score interval on per-case rates (evalstats Wilson flat)",
  clopperPearson: "Clopper-Pearson exact interval",
  bonettPrice: "Bonett-Price adjusted Wald interval for paired proportions",
  bonettPriceCluster: "Bonett-Price adjusted Wald interval, case-clustered over repeats (multi-run, not yet validated by evalstats)",
  mcnemarMidP: "McNemar mid-p test",
  mcnemarExact: "McNemar exact conditional test",
  ciInversion: "p-value by inverting the interval",
  sidak: "Sidak simultaneous intervals",
  shaffer: "Shaffer step-down adjustment",
  iccOneWay: "one-way ANOVA intraclass correlation ICC(1) (multi-run, not yet validated by evalstats)",
  passPowerKUnbiased: "unbiased pass^k",
  passAtKUnbiased: "unbiased pass@k",
  tInterval: "Student t interval for a mean (here, the mean per-case log ratio of cost or latency)",
  percentileBootstrapLegacy: "percentile bootstrap over cases (legacy; not used for decisions at small n)",
} as const;
export type StatsMethodId = keyof typeof STATS_METHODS;
