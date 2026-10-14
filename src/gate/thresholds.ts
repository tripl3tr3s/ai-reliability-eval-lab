import { z } from "zod";
import { STATISTICS_METRICS } from "../report-statistics.js";

const Rationale = z.string().trim().min(20, "Every threshold needs a written rationale");

export const ThresholdsSchema = z.object({
  $schema: z.string().optional(),
  version: z.string().regex(/^thresholds-v\d+$/u),
  date: z.string().date(),
  owner: z.string().trim().min(1),
  severityRulesVersion: z.string().min(1),
  confidence: z.number().gt(0.5).lt(1),
  bootstrap: z.object({
    resamples: z.number().int().min(1_000).max(100_000),
    seed: z.number().int().nonnegative(),
  }).strict(),
  minimumCases: z.object({ value: z.number().int().positive(), rationale: Rationale }).strict(),
  deterministicChecks: z.object({ requiredPassRate: z.literal(1), rationale: Rationale }).strict(),
  criticalErrors: z.object({ maxUpperBound: z.number().gt(0).lt(1), rationale: Rationale }).strict(),
  /**
   * What to do when no case differs between the arms and the bootstrap interval collapses to a point.
   * "warn" lets the comparison pass with a warning; "inconclusive" refuses to pass on a degenerate interval.
   */
  zeroWidthInterval: z.object({ policy: z.enum(["warn", "inconclusive"]), rationale: Rationale }).strict(),
  nonInferiority: z.array(z.object({
    metric: z.enum(STATISTICS_METRICS),
    margin: z.number().gt(0).lt(1),
    rationale: Rationale,
  }).strict()).min(1),
}).strict().superRefine((value, context) => {
  const metrics = value.nonInferiority.map(({ metric }) => metric);
  if (new Set(metrics).size !== metrics.length) context.addIssue({ code: "custom", path: ["nonInferiority"], message: "Each metric may have only one margin" });
});

export type Thresholds = z.infer<typeof ThresholdsSchema>;

export function parseThresholds(text: string): Thresholds {
  return ThresholdsSchema.parse(JSON.parse(text));
}
