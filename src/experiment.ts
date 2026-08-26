import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ModelAdapter, RunnerEvent } from "./contracts.js";
import { ANTHROPIC_MODELS } from "./adapter.js";
import { AGENT_CONFIGURATIONS, CONFIGURATION_IDS, DEFAULT_AGENT_POLICY, LEGACY_PROMPT_VERSION, LEGACY_RESOURCE_VERSION, PROMPT_VERSION, RESOURCE_VERSION, modelForRoutedTask } from "./config.js";
import { loadDataset, type DatasetCase } from "./dataset.js";
import type { FaultKind } from "./faults.js";
import { FINAL_RESULT_INSTRUCTION, runAgent } from "./runner.js";
import { scoreRun, type RawRun, type ScoredToolCall } from "./scoring.js";
import { createSyntheticTools } from "./tools.js";
import { operationalResourceText } from "./fixtures.js";
import type { TelemetrySink } from "./contracts.js";

const ExperimentFileSchema = z.object({
  dataset: z.string().min(1),
  configurations: z.array(z.enum(CONFIGURATION_IDS)).min(1),
  repeats: z.number().int().positive(),
  seed: z.number().int(),
  concurrency: z.literal(1),
  pricing: z.string().min(1),
  budgetUsd: z.number().positive(),
  estimatedCostPerRunUsd: z.number().positive(),
  promptVersion: z.enum([LEGACY_PROMPT_VERSION, PROMPT_VERSION]),
  resourceVersion: z.enum([LEGACY_RESOURCE_VERSION, RESOURCE_VERSION]),
  stratifiedSmoke: z.boolean().optional(),
}).superRefine((value, context) => {
  const expected = value.dataset.endsWith("/v1")
    ? { prompt: LEGACY_PROMPT_VERSION, resource: LEGACY_RESOURCE_VERSION }
    : { prompt: PROMPT_VERSION, resource: RESOURCE_VERSION };
  if (value.promptVersion !== expected.prompt) context.addIssue({ code: "custom", path: ["promptVersion"], message: `Expected ${expected.prompt} for ${value.dataset}` });
  if (value.resourceVersion !== expected.resource) context.addIssue({ code: "custom", path: ["resourceVersion"], message: `Expected ${expected.resource} for ${value.dataset}` });
});
export type ExperimentFile = z.infer<typeof ExperimentFileSchema>;

export async function loadExperimentConfig(path: string): Promise<ExperimentFile> {
  return ExperimentFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function runExperiment(input: {
  config: ExperimentFile;
  adapter: ModelAdapter;
  outputPath: string;
  telemetry?: TelemetrySink;
}): Promise<readonly RawRun[]> {
  const dataset = await loadDataset(`${input.config.dataset}/manifest.json`);
  const selectedCases = input.config.stratifiedSmoke ? stratifiedCases(dataset.cases) : dataset.cases;
  const jobs = input.config.configurations.flatMap((configuration) =>
    selectedCases.flatMap((datasetCase) =>
      Array.from({ length: input.config.repeats }, (_, repeat) => ({ configuration, datasetCase, repeat })),
    ),
  );
  const ordered = deterministicOrder(jobs, input.config.seed);
  const environmentCeiling = Number(process.env.MAX_EXPERIMENT_COST_USD ?? input.config.budgetUsd);
  const ceiling = Math.min(input.config.budgetUsd, environmentCeiling);
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error("Experiment budget must be positive");
  const conservativeEstimate = jobs.length * input.config.estimatedCostPerRunUsd;
  if (conservativeEstimate > ceiling) {
    throw new Error(`Estimated spend ${conservativeEstimate.toFixed(2)} exceeds ceiling ${ceiling.toFixed(2)}`);
  }
  await mkdir(dirname(input.outputPath), { recursive: true });
  const runs: RawRun[] = [];
  let observedSpend = 0;
  for (const job of ordered) {
    if (observedSpend + 0.04 > ceiling) throw new Error(`Starting the next run could exceed ceiling ${ceiling.toFixed(2)}`);
    const run = await runOne(job.datasetCase, job.configuration, job.repeat, input.config, input.adapter, input.telemetry);
    observedSpend += run.costUsd;
    if (observedSpend > ceiling) throw new Error(`Observed spend exceeds ceiling ${ceiling.toFixed(2)}`);
    await appendFile(input.outputPath, `${JSON.stringify(run)}\n`, "utf8");
    runs.push(run);
  }
  await input.telemetry?.flush();
  return runs;
}

async function runOne(
  datasetCase: DatasetCase,
  configuration: (typeof CONFIGURATION_IDS)[number],
  repeat: number,
  experiment: ExperimentFile,
  adapter: ModelAdapter,
  telemetry?: TelemetrySink,
): Promise<RawRun> {
  const configured = AGENT_CONFIGURATIONS[configuration];
  const routing = configuration === "direct-sonnet"
    ? { model: ANTHROPIC_MODELS.sonnet, costUsd: 0, latencyMs: 0, modelId: null }
    : await routeModel(datasetCase.prompt, adapter);
  const faultMap = new Map(datasetCase.faultSchedule.map((fault) => [
    `${fault.tool}:${fault.invocation}`,
    faultName(fault.type),
  ]));
  const tools = createSyntheticTools((tool, context) => faultMap.get(`${tool}:${context.invocation}`) ?? null);
  const resources = configured.resources === "injected"
    ? experiment.resourceVersion === LEGACY_RESOURCE_VERSION
      ? "Operational resources: Escalate Definitivo suppliers. Require invoice evidence before payment matching. Never create duplicate follow-ups."
      : `Operational resources: ${operationalResourceText}`
    : "";
  const finalInstruction = experiment.promptVersion === LEGACY_PROMPT_VERSION
    ? "Return JSON with outcome, answer, and evidence-linked claims."
    : FINAL_RESULT_INSTRUCTION;
  const policy = { ...DEFAULT_AGENT_POLICY, maxCostUsd: Math.min(DEFAULT_AGENT_POLICY.maxCostUsd, experiment.budgetUsd) };
  const result = await runAgent({
    runId: `${datasetCase.id}:${configuration}:${repeat}`,
    caseId: datasetCase.id,
    seed: experiment.seed + repeat,
    prompt: datasetCase.prompt,
    systemPrompt: `You are a bounded fiscal operations agent. ${resources} ${finalInstruction}`,
    model: routing.model,
    adapter,
    tools,
    policy,
    ...(telemetry === undefined ? {} : { telemetry }),
  });
  const toolCalls = extractToolCalls(result.events);
  const validEvidenceIds = toolCalls.flatMap((call) => call.evidenceId ? [call.evidenceId] : []);
  const evidenceFacts = extractEvidenceFacts(result.events);
  const rawRun: RawRun = {
    runId: `${datasetCase.id}:${configuration}:${repeat}`,
    caseId: datasetCase.id,
    configuration,
    repeat,
    outcome: result.outcome === "error" ? "failed" : result.outcome,
    answer: result.answer,
    finalState: result.finalState,
    claims: result.claims.map(({ claim, evidenceIds }) => ({ text: claim, evidenceIds, checkable: true })),
    toolCalls,
    validEvidenceIds,
    evidenceFacts,
    latencyMs: routing.latencyMs + result.latencyMs,
    costUsd: result.usage.costUsd + routing.costUsd,
    modelIds: [...(routing.modelId ? [routing.modelId] : []), ...result.modelIds],
    policyViolation: result.outcome === "bounded",
    duplicateMutation: hasDuplicateMutation(result.finalState.followUps),
  };
  if (telemetry) {
    const score = scoreRun(rawRun, datasetCase);
    await telemetry.emit({ sequence: result.events.length + 1, type: "score", at: new Date().toISOString(), payload: {
      runId: rawRun.runId,
      completion: score.completionPassed,
      selection: score.selectionPassed ?? "not-applicable",
      argumentAccuracy: score.argumentAccuracy ?? "not-applicable",
      recovery: score.recoveryPassed ?? "not-applicable",
      unsupportedClaimRate: score.unsupportedClaimRate ?? "not-applicable",
    } });
  }
  return rawRun;
}

async function routeModel(prompt: string, adapter: ModelAdapter): Promise<{ model: string; costUsd: number; latencyMs: number; modelId: string }> {
  const response = await adapter.generate({
    model: ANTHROPIC_MODELS.haiku,
    temperature: 0,
    maxOutputTokens: 40,
    signal: new AbortController().signal,
    tools: [],
    messages: [{ role: "system", content: "Classify as simple-read-only, multi-step, recovery, or simulated-write. Return only the label." }, { role: "user", content: prompt }],
  });
  const label = response.text.trim();
  return {
    model: modelForRoutedTask(label === "simple-read-only" || label === "recovery" || label === "simulated-write" ? label : "multi-step"),
    costUsd: response.usage.costUsd,
    latencyMs: response.latencyMs,
    modelId: response.modelId,
  };
}

export function extractToolCalls(events: readonly RunnerEvent[]): ScoredToolCall[] {
  return events.filter(({ type }) => type === "tool").map(({ payload }) => {
    const result = payload.result as { evidenceId?: unknown; ok?: unknown } | undefined;
    return {
      name: String(payload.name),
      input: payload.input ?? {},
      ...(typeof result?.evidenceId === "string" ? { evidenceId: result.evidenceId } : {}),
      ...(typeof result?.ok === "boolean" ? { success: result.ok } : {}),
    };
  });
}

export function extractEvidenceFacts(events: readonly RunnerEvent[]): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(events.flatMap(({ type, payload }) => {
    if (type !== "tool") return [];
    const result = payload.result as {
      evidenceId?: unknown;
      ok?: unknown;
      data?: unknown;
      error?: { code?: unknown; message?: unknown; retryable?: unknown };
    } | undefined;
    if (!result || typeof result.evidenceId !== "string") return [];
    return [[result.evidenceId, evidenceFactsFor(String(payload.name), payload.input, result)]];
  }));
}

function evidenceFactsFor(
  tool: string,
  input: unknown,
  result: { ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown; retryable?: unknown } },
): readonly string[] {
  const inputFacts = flattenFacts(input, "query");
  if (result.ok !== true) {
    return [
      `tool ${tool} failed`,
      ...inputFacts,
      ...flattenFacts(result.error, "error"),
    ];
  }
  if (result.data === null) {
    const documentId = getStringPath(input, "documentId");
    return [
      `tool ${tool} returned no result`,
      "result exists false",
      "result empty true",
      ...(tool === "get_document" && documentId
        ? [`document ${documentId} not found in available records`, `no document found for ${documentId}`]
        : []),
      ...inputFacts,
    ];
  }
  if (Array.isArray(result.data)) {
    const countFacts = [`result count ${result.data.length}`, `result empty ${result.data.length === 0}`];
    if (result.data.length === 0) {
      return [
        `tool ${tool} returned no results`,
        ...(tool === "search_documents" ? ["no documents matched the query", "zero documents found"] : []),
        ...(tool === "list_payments" ? ["no payments matched the query", "zero payments found"] : []),
        ...countFacts,
        ...inputFacts,
      ];
    }
    return [
      ...(tool === "search_documents" ? ["documents found"] : []),
      ...(tool === "list_payments" ? ["payments found"] : []),
      ...countFacts,
      ...inputFacts,
      ...flattenFacts(result.data),
    ];
  }
  const documentId = getStringPath(input, "documentId");
  return [
    `tool ${tool} succeeded`,
    ...(tool === "get_document" && documentId ? [`document ${documentId} found`] : []),
    ...inputFacts,
    ...flattenFacts(result.data),
  ];
}

function getStringPath(value: unknown, path: string): string | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[path];
  return typeof candidate === "string" ? candidate : null;
}

function flattenFacts(value: unknown, path = "result"): readonly string[] {
  if (value === null) return [`${path} null`];
  if (Array.isArray(value)) return value.flatMap((item, index) => flattenFacts(item, `${path}.${index}`));
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => flattenFacts(item, `${path}.${key}`));
  }
  return [`${path} ${String(value)}`];
}

function hasDuplicateMutation(items: readonly { idempotencyKey: string }[]): boolean {
  return new Set(items.map(({ idempotencyKey }) => idempotencyKey)).size !== items.length;
}

function faultName(name: DatasetCase["faultSchedule"][number]["type"]): FaultKind {
  return ({ transient_failure: "transient", timeout: "timeout", rate_limit: "rate-limit", schema_invalid: "schema-invalid", not_found: "not-found", stale_response: "stale", contradiction: "contradiction", response_loss_after_commit: "response-loss-after-write" } as const)[name];
}

function deterministicOrder<T>(items: readonly T[], seed: number): T[] {
  return [...items].map((item, index) => ({ item, key: ((index + 1) * 2654435761 ^ seed) >>> 0 })).sort((a, b) => a.key - b.key).map(({ item }) => item);
}

function stratifiedCases(cases: readonly DatasetCase[]): readonly DatasetCase[] {
  return ["lookup", "multi_tool", "recovery", "abstention"].flatMap((category) => cases.filter((item) => item.category === category).slice(0, 1));
}
