import { readFile } from "node:fs/promises";
import { z } from "zod";
import { STATISTICS_METRICS } from "./report-statistics.js";
import { STATS_METHODS_VERSION } from "./stats/index.js";

/**
 * Structural check of a generated summary.json: the statistics were produced by the current methods version
 * and every analysis plan v2 block is present. CI runs it on the mock v3 report so a refactor that drops a
 * block, or forgets to bump the version, fails before it reaches a live run.
 */
const SummaryStatisticsSchema = z.object({
  statistics: z.object({
    method: z.object({ version: z.string(), primaryEstimand: z.literal("all-pass"), intervals: z.record(z.string(), z.string()) }),
    arms: z.array(z.object({ configuration: z.string() })).min(1),
    primary: z.object({ estimand: z.literal("all-pass"), arms: z.array(z.unknown()), comparisons: z.array(z.unknown()) }),
    secondary: z.object({ estimand: z.literal("per-case-rate"), arms: z.array(z.unknown()), comparisons: z.array(z.unknown()) }),
    stability: z.object({ validated: z.literal(false), arms: z.array(z.unknown()) }),
    outcomes: z.array(z.unknown()),
    sensitivity: z.object({ rule: z.string().min(1), comparisons: z.array(z.unknown()) }),
    efficiency: z.object({ arms: z.array(z.unknown()), comparisons: z.array(z.unknown()) }),
    scope: z.string().min(1),
  }),
});

export function checkReportStatistics(summary: unknown): readonly string[] {
  const parsed = SummaryStatisticsSchema.safeParse(summary);
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join(".") || "summary"}: ${issue.message}`);
  const { statistics } = parsed.data;
  const configurations = statistics.arms.length;
  const pairs = (configurations * (configurations - 1)) / 2;
  const expectations: readonly (readonly [string, number, number])[] = [
    ["primary.arms", statistics.primary.arms.length, configurations * STATISTICS_METRICS.length],
    ["primary.comparisons", statistics.primary.comparisons.length, pairs * STATISTICS_METRICS.length],
    ["secondary.arms", statistics.secondary.arms.length, configurations * STATISTICS_METRICS.length],
    ["secondary.comparisons", statistics.secondary.comparisons.length, pairs * STATISTICS_METRICS.length],
    ["stability.arms", statistics.stability.arms.length, configurations * STATISTICS_METRICS.length],
    ["outcomes", statistics.outcomes.length, configurations],
    ["sensitivity.comparisons", statistics.sensitivity.comparisons.length, pairs * STATISTICS_METRICS.length],
    ["efficiency.arms", statistics.efficiency.arms.length, configurations],
    ["efficiency.comparisons", statistics.efficiency.comparisons.length, pairs],
  ];
  return [
    ...(statistics.method.version === STATS_METHODS_VERSION ? [] : [`statistics.method.version: expected ${STATS_METHODS_VERSION}, found ${statistics.method.version}`]),
    ...expectations.flatMap(([path, actual, expected]) => (actual === expected ? [] : [`statistics.${path}: expected ${expected} entries for ${configurations} configurations, found ${actual}`])),
  ];
}

export async function checkReportFile(path: string): Promise<readonly string[]> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path} as JSON`, { cause: error });
  }
  return checkReportStatistics(value);
}
