import { readFile } from "node:fs/promises";
import { z } from "zod";

const LongPromptRateSchema = z.object({
  thresholdTokens: z.number().int().positive(),
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
}).strict();

const ModelRateSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  /** Second rate card applied to the whole request when its input tokens exceed the threshold. */
  longPrompt: LongPromptRateSchema.optional(),
}).strict();

export const PricingConfigSchema = z.object({
  $schema: z.string().optional(),
  version: z.string().min(1),
  effectiveDate: z.string().date(),
  sourceUrl: z.string().url(),
  currency: z.literal("USD"),
  perMillionTokens: z.record(z.string().min(1), ModelRateSchema).refine(
    (rates) => Object.keys(rates).length > 0,
    "At least one model rate is required",
  ),
}).strict();

export type ModelRate = z.infer<typeof ModelRateSchema>;
export type PricingConfig = z.infer<typeof PricingConfigSchema>;

export async function loadPricingConfig(path: string): Promise<PricingConfig> {
  return PricingConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

/** USD cost of one request. A long-prompt rate card, when present, replaces the base rates for the whole request. */
export function costForUsage(rate: ModelRate, inputTokens: number, outputTokens: number): number {
  const card = rate.longPrompt !== undefined && inputTokens > rate.longPrompt.thresholdTokens ? rate.longPrompt : rate;
  return (inputTokens * card.input + outputTokens * card.output) / 1_000_000;
}
