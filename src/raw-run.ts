import { z } from "zod";
import type { RawRun } from "./scoring.js";

/** Model ids produced by the scripted mock model start with this prefix. */
export const MOCK_MODEL_PREFIX = "mock-";

/** True when any row was produced by a mock model. Such data must never be presented as a benchmark result. */
export const containsMockRuns = (modelIds: readonly string[]): boolean => modelIds.some((id) => id.startsWith(MOCK_MODEL_PREFIX));

/** Schema of one raw JSONL run row. Unknown keys are preserved so newer rows stay readable. */
export const RawRunSchema = z.object({
  runId: z.string().min(1),
  caseId: z.string().min(1),
  configuration: z.string().min(1),
  repeat: z.number().int().nonnegative(),
  outcome: z.enum(["completed", "abstained", "failed", "bounded"]),
  answer: z.string(),
  finalState: z.unknown(),
  claims: z.array(z.object({ text: z.string(), evidenceIds: z.array(z.string()), checkable: z.boolean().optional() }).passthrough()),
  toolCalls: z.array(z.object({ name: z.string().min(1), input: z.unknown(), evidenceId: z.string().optional(), success: z.boolean().optional() }).passthrough()),
  validEvidenceIds: z.array(z.string()),
  evidenceFacts: z.record(z.array(z.string())).optional(),
  latencyMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  tokens: z.number().int().nonnegative().optional(),
  modelIds: z.array(z.string()).optional(),
  policyViolation: z.boolean().optional(),
  duplicateMutation: z.boolean().optional(),
}).passthrough();

export interface RawRunIssue { readonly line: number; readonly message: string }

/** Parses raw JSONL text, collecting every invalid line instead of stopping at the first. */
export function parseRawRuns(text: string): { readonly runs: readonly RawRun[]; readonly issues: readonly RawRunIssue[] } {
  const runs: RawRun[] = [];
  const issues: RawRunIssue[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      issues.push({ line: index + 1, message: "Invalid JSON" });
      continue;
    }
    const parsed = RawRunSchema.safeParse(value);
    if (parsed.success) runs.push(parsed.data as RawRun);
    else issues.push({ line: index + 1, message: parsed.error.issues.map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`).join("; ") });
  }
  return { runs, issues };
}

/** Parses raw JSONL text and throws on the first invalid line. */
export function readRawRuns(text: string): readonly RawRun[] {
  const { runs, issues } = parseRawRuns(text);
  const first = issues[0];
  if (first) throw new Error(`Invalid raw result on line ${first.line}: ${first.message}`);
  return runs;
}
