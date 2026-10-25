import { z } from "zod";
import { STATISTICS_METRICS } from "../report-statistics.js";

const Rationale = z.string().trim().min(20, "Every threshold needs a written rationale");

export const PRIMARY_ESTIMANDS = ["all-pass", "per-case-rate"] as const;
export const NON_INFERIORITY_INTERVALS = ["bonett-price", "percentile-bootstrap"] as const;
export type PrimaryEstimand = (typeof PRIMARY_ESTIMANDS)[number];
export type NonInferiorityInterval = (typeof NON_INFERIORITY_INTERVALS)[number];

/**
 * How the non-inferiority comparisons are computed. Absent in thresholds-v1 and thresholds-v2, which keep
 * the original analysis: per-case pass rates with a percentile paired bootstrap.
 */
const AnalysisSchema = z.object({
  /** "all-pass": a case passes only if every repeat passed. "per-case-rate": the case's pass rate over its repeats. */
  primaryEstimand: z.enum(PRIMARY_ESTIMANDS),
  nonInferiorityInterval: z.enum(NON_INFERIORITY_INTERVALS),
  /** Must equal STATS_METHODS_VERSION in src/stats/methods.ts; checked deterministically by the gate. */
  statsMethodsVersion: z.string().min(1),
  /** Must equal the scoring contract version, and the scorer must match its lock; checked deterministically. */
  scoringContractVersion: z.string().min(1),
  rationale: Rationale,
}).strict();
export type Analysis = z.infer<typeof AnalysisSchema>;

/** The analysis thresholds-v1 and thresholds-v2 were written for. */
export const LEGACY_ANALYSIS = { primaryEstimand: "per-case-rate", nonInferiorityInterval: "percentile-bootstrap" } as const;

export const ThresholdsSchema = z.object({
  $schema: z.string().optional(),
  version: z.string().regex(/^thresholds-v\d+$/u),
  date: z.string().date(),
  owner: z.string().trim().min(1),
  severityRulesVersion: z.string().min(1),
  confidence: z.number().gt(0.5).lt(1),
  analysis: AnalysisSchema.optional(),
  /** Percentile bootstrap settings. Required by the bootstrap interval and rejected by the others. */
  bootstrap: z.object({
    resamples: z.number().int().min(1_000).max(100_000),
    seed: z.number().int().nonnegative(),
  }).strict().optional(),
  minimumCases: z.object({ value: z.number().int().positive(), rationale: Rationale }).strict(),
  deterministicChecks: z.object({ requiredPassRate: z.literal(1), rationale: Rationale }).strict(),
  criticalErrors: z.object({ maxUpperBound: z.number().gt(0).lt(1), rationale: Rationale }).strict(),
  /**
   * What to do when no case differs between the arms and the bootstrap interval collapses to a point.
   * "warn" lets the comparison pass with a warning; "inconclusive" refuses to pass on a degenerate interval.
   * Required by the bootstrap interval and rejected by Bonett-Price, which never has zero width.
   */
  zeroWidthInterval: z.object({ policy: z.enum(["warn", "inconclusive"]), rationale: Rationale }).strict().optional(),
  nonInferiority: z.array(z.object({
    metric: z.enum(STATISTICS_METRICS),
    margin: z.number().gt(0).lt(1),
    rationale: Rationale,
  }).strict()).min(1),
}).strict().superRefine((value, context) => {
  const metrics = value.nonInferiority.map(({ metric }) => metric);
  if (new Set(metrics).size !== metrics.length) context.addIssue({ code: "custom", path: ["nonInferiority"], message: "Each metric may have only one margin" });
  const { primaryEstimand, nonInferiorityInterval } = value.analysis ?? LEGACY_ANALYSIS;
  if (nonInferiorityInterval === "percentile-bootstrap") {
    if (primaryEstimand !== "per-case-rate") context.addIssue({ code: "custom", path: ["analysis", "primaryEstimand"], message: "The percentile bootstrap is only implemented for per-case pass rates" });
    if (value.bootstrap === undefined) context.addIssue({ code: "custom", path: ["bootstrap"], message: "The percentile bootstrap needs bootstrap settings" });
    if (value.zeroWidthInterval === undefined) context.addIssue({ code: "custom", path: ["zeroWidthInterval"], message: "The percentile bootstrap needs a zero-width interval policy" });
  } else {
    if (value.bootstrap !== undefined) context.addIssue({ code: "custom", path: ["bootstrap"], message: "Bootstrap settings do nothing with the Bonett-Price interval; remove them" });
    if (value.zeroWidthInterval !== undefined) context.addIssue({ code: "custom", path: ["zeroWidthInterval"], message: "The Bonett-Price interval never has zero width; remove the policy" });
  }
});

/** The analysis a thresholds file selects, with the legacy default filled in. */
export function analysisOf(thresholds: Thresholds): { readonly primaryEstimand: PrimaryEstimand; readonly nonInferiorityInterval: NonInferiorityInterval } {
  return thresholds.analysis ?? LEGACY_ANALYSIS;
}

export type Thresholds = z.infer<typeof ThresholdsSchema>;

export function parseThresholds(text: string): Thresholds {
  return ThresholdsSchema.parse(JSON.parse(text));
}
