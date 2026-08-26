import { readFile } from "node:fs/promises";
import { z } from "zod";

const ModelRateSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
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
