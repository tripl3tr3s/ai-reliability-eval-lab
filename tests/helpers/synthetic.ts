import type { DatasetCase, DatasetCaseV2 } from "../../src/dataset.js";
import type { RawRun } from "../../src/scoring.js";

export const ARMS = ["direct-sonnet", "routed", "no-resource-injection"] as const;

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = target;
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) current[part] = value;
    else current = (current[part] ??= /^\d+$/u.test(parts[index + 1]!) ? [] : {}) as Record<string, unknown>;
  }
}

/** A hand-built raw row for a v2 case. It never touches a model or the runner. */
export function syntheticRun(datasetCase: DatasetCase, configuration: string, repeat: number, passed: boolean, overrides: Partial<RawRun> = {}): RawRun {
  const v2 = datasetCase as DatasetCaseV2;
  const finalState: Record<string, unknown> = {};
  for (const assertion of v2.expectedState) setPath(finalState, assertion.path, assertion.equals);
  return {
    runId: `${v2.id}:${configuration}:${repeat}`,
    caseId: v2.id,
    configuration,
    repeat,
    outcome: v2.category === "abstention" ? "abstained" : "completed",
    answer: passed ? v2.requiredAssertions[0]!.map(({ includes }) => includes).join(". ") : "No result.",
    finalState,
    claims: [],
    toolCalls: v2.acceptedPlans[0]!.calls.map((call) => ({
      name: call.tool,
      input: Object.fromEntries(call.argumentMatchers.map((matcher) => [matcher.path, "equals" in matcher ? matcher.equals : "key-1"])),
    })),
    validEvidenceIds: [],
    latencyMs: 100 + repeat,
    costUsd: 0.01,
    tokens: 1_000,
    modelIds: ["synthetic-model"],
    policyViolation: false,
    duplicateMutation: false,
    ...overrides,
  };
}

/** Full case x configuration x repeat grid. `passes` decides the outcome of each cell. */
export function syntheticGrid(
  cases: readonly DatasetCase[],
  passes: (cell: { caseIndex: number; caseId: string; configuration: string; repeat: number }) => boolean = () => true,
  repeats = 5,
  configurations: readonly string[] = ARMS,
): RawRun[] {
  return configurations.flatMap((configuration) => cases.flatMap((datasetCase, caseIndex) =>
    Array.from({ length: repeats }, (_, repeat) => syntheticRun(datasetCase, configuration, repeat, passes({ caseIndex, caseId: datasetCase.id, configuration, repeat })))));
}

export const toJsonl = (rows: readonly unknown[]): string => rows.map((row) => `${JSON.stringify(row)}\n`).join("");
