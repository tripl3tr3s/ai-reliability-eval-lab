import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ToolPatternSchema = z.object({
  tools: z.array(z.string().min(1)).min(1),
  ordered: z.boolean().default(true),
});

const PlanArgumentMatcherSchema = z.union([
  z.object({
    path: z.string().min(1),
    operator: z.literal("nonempty"),
  }),
  z.object({
    path: z.string().min(1),
    equals: z.unknown(),
  }).refine((matcher) => Object.hasOwn(matcher, "equals"), {
    message: "Equals matcher must include equals",
  }),
]);

const PlanCallSchema = z.object({
  tool: z.string().min(1),
  argumentMatchers: z.array(PlanArgumentMatcherSchema).default([]),
});

const AcceptedPlanSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  calls: z.array(PlanCallSchema).min(1),
  ordered: z.boolean().default(true),
});

const RequiredAssertionTermSchema = z.object({
  type: z.literal("text"),
  includes: z.string().min(1),
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

export const DatasetCaseV1Schema = z.object({
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

export const DatasetCaseV2Schema = z.object({
  id: z.string().regex(/^v2-[a-z0-9-]+$/),
  category: z.enum(["lookup", "multi_tool", "recovery", "abstention"]),
  fixture: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
  prompt: z.string().min(10),
  acceptedPlans: z.array(AcceptedPlanSchema).min(1),
  forbiddenTools: z.array(z.string()).default([]),
  expectedState: z.array(StateAssertionSchema),
  requiredAssertions: z.array(z.array(RequiredAssertionTermSchema).min(1)).min(1),
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
  if (value.metricApplicability.arguments && !value.acceptedPlans.some(({ calls }) => calls.some(({ argumentMatchers }) => argumentMatchers.length > 0))) {
    context.addIssue({ code: "custom", path: ["acceptedPlans"], message: "argument-scored cases need plan matchers" });
  }
  if (value.metricApplicability.recovery !== (value.faultSchedule.length > 0)) {
    context.addIssue({ code: "custom", path: ["metricApplicability", "recovery"], message: "recovery applicability must match fault schedule" });
  }
  const planIds = new Set(value.acceptedPlans.map(({ id }) => id));
  if (planIds.size !== value.acceptedPlans.length) {
    context.addIssue({ code: "custom", path: ["acceptedPlans"], message: "accepted plan IDs must be unique within a case" });
  }
});

const AmountTermSchema = z.object({ type: z.literal("amount"), value: z.number(), currency: z.enum(["MXN", "USD"]).optional() });
const IdentifierTermSchema = z.object({ type: z.literal("identifier"), value: z.string().min(3) });

/**
 * v3 assertion terms. "text" is matched accent- and case-insensitively with Spanish negation; "amount" parses
 * the number formats an answer can use (1160, 1,160.00, $1 160, 1.160,00) and compares numerically;
 * "identifier" matches an RFC, UUID, or folio as a whole token.
 */
export const AssertionTermV3Schema = z.discriminatedUnion("type", [RequiredAssertionTermSchema, AmountTermSchema, IdentifierTermSchema]);
export type AssertionTermV3 = z.infer<typeof AssertionTermV3Schema>;

export const COUNTEREXAMPLE_KINDS = ["wrong_value", "negation", "false_completion", "omission", "false_abstention", "unsafe_advice"] as const;

export const CATEGORY_COUNTS = {
  v1: { lookup: 10, multi_tool: 10, recovery: 8, abstention: 2 },
  v2: { lookup: 10, multi_tool: 10, recovery: 8, abstention: 2 },
  v3: { lookup: 20, multi_tool: 24, recovery: 18, abstention: 14, confirmation: 14 },
} as const;

export const DatasetCaseV3Schema = z.object({
  id: z.string().regex(/^v3-[a-z0-9-]+$/),
  category: z.enum(["lookup", "multi_tool", "recovery", "abstention", "confirmation"]),
  language: z.literal("es-MX"),
  /** Domain the production router should assign; used for descriptive routing accuracy, never gated. */
  domain: z.enum(["facturacion", "pagos", "notas-credito", "cumplimiento", "cancelaciones", "general"]),
  fixture: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
  prompt: z.string().min(10),
  acceptedPlans: z.array(AcceptedPlanSchema).min(1),
  /** Read tools that may appear on top of an accepted plan without failing tool accuracy. */
  allowedExtraCalls: z.array(z.object({ tool: z.string().min(1), maxCount: z.number().int().positive().max(3) })).default([]),
  forbiddenTools: z.array(z.string()).default([]),
  expectedState: z.array(StateAssertionSchema),
  requiredAssertions: z.array(z.array(AssertionTermV3Schema).min(1)).min(1),
  forbiddenClaims: z.array(z.string().min(2)),
  /** A wrong amount or identifier in the answer is a critical error (severity-rules-v2 wrong_value). */
  forbiddenValues: z.array(AssertionTermV3Schema).default([]),
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
  /** A Spanish answer that must pass completion. Also the scripted mock's answer. */
  referenceAnswer: z.string().min(20),
  /** Answers that must fail completion, each with the reason it fails. */
  counterexamples: z.array(z.object({ kind: z.enum(COUNTEREXAMPLE_KINDS), answer: z.string().min(10) })).min(3),
}).superRefine((value, context) => {
  if (value.metricApplicability.arguments && !value.acceptedPlans.some(({ calls }) => calls.some(({ argumentMatchers }) => argumentMatchers.length > 0))) {
    context.addIssue({ code: "custom", path: ["acceptedPlans"], message: "argument-scored cases need plan matchers" });
  }
  if (value.metricApplicability.recovery !== (value.faultSchedule.length > 0)) {
    context.addIssue({ code: "custom", path: ["metricApplicability", "recovery"], message: "recovery applicability must match fault schedule" });
  }
  if (new Set(value.acceptedPlans.map(({ id }) => id)).size !== value.acceptedPlans.length) {
    context.addIssue({ code: "custom", path: ["acceptedPlans"], message: "accepted plan IDs must be unique within a case" });
  }
  if (value.category === "confirmation" && !value.expectedState.some(({ path }) => path.startsWith("confirmacionesPendientes"))) {
    context.addIssue({ code: "custom", path: ["expectedState"], message: "confirmation cases must assert the pending confirmation" });
  }
  const kinds = new Set(value.counterexamples.map(({ kind }) => kind));
  if (value.category !== "abstention" && !kinds.has("wrong_value") && value.forbiddenValues.length > 0) {
    context.addIssue({ code: "custom", path: ["counterexamples"], message: "cases with forbidden values need a wrong_value counterexample" });
  }
});

export const DatasetCaseSchema = z.union([DatasetCaseV1Schema, DatasetCaseV2Schema, DatasetCaseV3Schema]);
export type DatasetCaseV1 = z.infer<typeof DatasetCaseV1Schema>;
export type DatasetCaseV2 = z.infer<typeof DatasetCaseV2Schema>;
export type DatasetCaseV3 = z.infer<typeof DatasetCaseV3Schema>;
export type DatasetCase = DatasetCaseV1 | DatasetCaseV2 | DatasetCaseV3;

export const isV3Case = (datasetCase: DatasetCase): datasetCase is DatasetCaseV3 => "language" in datasetCase;

const CASE_COUNTS = { v1: 30, v2: 30, v3: 90 } as const;

const ManifestSchema = z.object({
  version: z.enum(["v1", "v2", "v3"]),
  caseFile: z.string().min(1),
  caseCount: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export interface DatasetBundle {
  version: "v1" | "v2" | "v3";
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
  if (manifest.caseCount !== CASE_COUNTS[manifest.version]) throw new Error(`Dataset ${manifest.version} must declare ${CASE_COUNTS[manifest.version]} cases, manifest declares ${manifest.caseCount}`);
  const casesPath = resolve(dirname(manifestPath), manifest.caseFile);
  const casesText = await readFile(casesPath, "utf8");
  const actualHash = sha256(casesText);
  if (actualHash !== manifest.sha256) throw new Error(`Dataset hash mismatch: expected ${manifest.sha256}, received ${actualHash}`);

  const lines = casesText.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length !== manifest.caseCount) throw new Error(`Dataset must contain exactly ${manifest.caseCount} cases, received ${lines.length}`);
  const caseSchema = { v1: DatasetCaseV1Schema, v2: DatasetCaseV2Schema, v3: DatasetCaseV3Schema }[manifest.version];
  const cases = lines.map((line, index) => {
    try { return caseSchema.parse(JSON.parse(line)); }
    catch (error) { throw new Error(`Invalid dataset case on line ${index + 1}`, { cause: error }); }
  });
  const ids = new Set(cases.map(({ id }) => id));
  if (ids.size !== cases.length) throw new Error("Dataset contains duplicate case IDs");
  const expectedCounts: Readonly<Record<string, number>> = CATEGORY_COUNTS[manifest.version];
  const counts = Object.fromEntries(Object.keys(expectedCounts).map((category) => [category, cases.filter((item) => item.category === category).length]));
  if (Object.entries(expectedCounts).some(([category, count]) => counts[category] !== count) || Object.values(counts).reduce((sum, count) => sum + count, 0) !== cases.length) {
    throw new Error(`Dataset category counts are invalid: ${JSON.stringify(counts)}`);
  }
  return Object.freeze({ version: manifest.version, cases: Object.freeze(cases), hash: actualHash, manifestPath });
}
