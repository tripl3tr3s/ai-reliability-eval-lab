import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ToolPatternSchema = z.object({
  tools: z.array(z.string().min(1)).min(1),
  ordered: z.boolean().default(true),
});

const ArgumentMatcherSchema = z.object({
  tool: z.string().min(1),
  invocation: z.number().int().positive().default(1),
  path: z.string().min(1),
  equals: z.unknown(),
});

const StateAssertionSchema = z.object({
  path: z.string().min(1),
  equals: z.unknown(),
});

const FaultSchema = z.object({
  tool: z.string().min(1),
  invocation: z.number().int().positive(),
  type: z.enum([
    "transient_failure",
    "timeout",
    "rate_limit",
    "schema_invalid",
    "not_found",
    "stale_response",
    "contradiction",
    "response_loss_after_commit",
  ]),
});

export const DatasetCaseSchema = z.object({
  id: z.string().regex(/^v1-[a-z0-9-]+$/),
  category: z.enum(["lookup", "multi_tool", "recovery", "abstention"]),
  fixture: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
  prompt: z.string().min(10),
  acceptedToolPatterns: z.array(ToolPatternSchema).min(1),
  forbiddenTools: z.array(z.string()).default([]),
  argumentMatchers: z.array(ArgumentMatcherSchema),
  expectedState: z.array(StateAssertionSchema),
  requiredFacts: z.array(z.string()),
  forbiddenClaims: z.array(z.string()),
  faultSchedule: z.array(FaultSchema),
  recoveryExpectations: z.object({
    mustRecover: z.boolean(),
    noDuplicateMutation: z.boolean(),
  }),
  metricApplicability: z.object({
    completion: z.literal(true),
    toolSelection: z.boolean(),
    arguments: z.boolean(),
    recovery: z.boolean(),
    unsupportedClaims: z.literal(true),
  }),
}).superRefine((value, context) => {
  if (value.metricApplicability.arguments && value.argumentMatchers.length === 0) {
    context.addIssue({ code: "custom", path: ["argumentMatchers"], message: "argument-scored cases need matchers" });
  }
  if (value.metricApplicability.recovery !== (value.faultSchedule.length > 0)) {
    context.addIssue({ code: "custom", path: ["metricApplicability", "recovery"], message: "recovery applicability must match fault schedule" });
  }
});

export type DatasetCase = z.infer<typeof DatasetCaseSchema>;

const ManifestSchema = z.object({
  version: z.literal("v1"),
  caseFile: z.string().min(1),
  caseCount: z.literal(30),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export interface DatasetBundle {
  version: "v1";
  cases: readonly DatasetCase[];
  hash: string;
  manifestPath: string;
}

export const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export async function loadDataset(
  manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), "../datasets/v1/manifest.json"),
): Promise<DatasetBundle> {
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = ManifestSchema.parse(JSON.parse(manifestText));
  const casesPath = resolve(dirname(manifestPath), manifest.caseFile);
  const casesText = await readFile(casesPath, "utf8");
  const actualHash = sha256(casesText);
  if (actualHash !== manifest.sha256) throw new Error(`Dataset hash mismatch: expected ${manifest.sha256}, received ${actualHash}`);

  const lines = casesText.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length !== manifest.caseCount) throw new Error(`Dataset must contain exactly ${manifest.caseCount} cases, received ${lines.length}`);
  const cases = lines.map((line, index) => {
    try { return DatasetCaseSchema.parse(JSON.parse(line)); }
    catch (error) { throw new Error(`Invalid dataset case on line ${index + 1}`, { cause: error }); }
  });
  const ids = new Set(cases.map(({ id }) => id));
  if (ids.size !== cases.length) throw new Error("Dataset contains duplicate case IDs");
  const counts = Object.fromEntries(["lookup", "multi_tool", "recovery", "abstention"].map((category) => [category, cases.filter((item) => item.category === category).length]));
  if (counts.lookup !== 10 || counts.multi_tool !== 10 || counts.recovery !== 8 || counts.abstention !== 2) {
    throw new Error(`Dataset category counts are invalid: ${JSON.stringify(counts)}`);
  }
  return Object.freeze({ version: manifest.version, cases: Object.freeze(cases), hash: actualHash, manifestPath });
}
