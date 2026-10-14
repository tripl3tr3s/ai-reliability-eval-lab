import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { AgentPolicy, ModelAdapter, ModelRoles, RunnerEvent, TelemetrySink, ToolDefinition } from "./contracts.js";
import { AGENT_CONFIGURATIONS, CONFIGURATION_IDS, DEFAULT_AGENT_POLICY, DEFAULT_MODEL_ROLES, LEGACY_PROMPT_VERSION, LEGACY_RESOURCE_VERSION, PROMPT_VERSION, RESOURCE_VERSION, modelForRoutedTask } from "./config.js";
import { loadDataset, type DatasetCase } from "./dataset.js";
import type { FaultKind } from "./faults.js";
import { FINAL_RESULT_INSTRUCTION, runAgent } from "./runner.js";
import { scoreRun, type RawRun, type ScoredToolCall } from "./scoring.js";
import { createSyntheticTools } from "./tools.js";
import { operationalResourceText } from "./fixtures.js";
import { capabilitiesFor, wrapAdapter } from "./providers/capabilities.js";

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
type ParsedExperimentFile = z.infer<typeof ExperimentFileSchema>;
export type ExperimentFile = Omit<ParsedExperimentFile, "configurations"> & {
  readonly configurations: readonly (typeof CONFIGURATION_IDS)[number][];
};

export async function loadExperimentConfig(path: string): Promise<ExperimentFile> {
  return ExperimentFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export type ExperimentPhase = "routing" | "model" | "tool" | "scoring" | "persistence";
export type ExperimentStatus = "completed" | "cancelled" | "failed";
export type ExperimentOutcome = RawRun["outcome"];

export interface ExperimentJob {
  readonly configuration: (typeof CONFIGURATION_IDS)[number];
  readonly datasetCase: DatasetCase;
  readonly repeat: number;
  readonly runId: string;
}

export interface ExperimentPlan {
  readonly jobs: readonly ExperimentJob[];
  readonly totalJobs: number;
  readonly selectedCaseCount: number;
  readonly estimatedCostUsd: number;
  readonly budgetCeilingUsd: number;
}

interface JobEventFields {
  readonly index: number;
  readonly totalJobs: number;
  readonly runId: string;
  readonly caseId: string;
  readonly configuration: (typeof CONFIGURATION_IDS)[number];
  readonly repeat: number;
}

export type ExperimentProgressEvent =
  | {
      readonly type: "experiment_started";
      readonly totalJobs: number;
      readonly selectedCaseCount: number;
      readonly configurations: readonly (typeof CONFIGURATION_IDS)[number][];
      readonly repeats: number;
      readonly estimatedCostUsd: number;
      readonly budgetCeilingUsd: number;
    }
  | ({ readonly type: "job_started"; readonly elapsedMs: number } & JobEventFields)
  | ({ readonly type: "phase_changed"; readonly phase: ExperimentPhase; readonly elapsedMs: number; readonly observedCostUsd: number } & JobEventFields)
  | ({
      readonly type: "job_completed";
      readonly outcome: ExperimentOutcome;
      readonly costUsd: number;
      readonly observedCostUsd: number;
      readonly durationMs: number;
      readonly elapsedMs: number;
      readonly completedJobs: number;
    } & JobEventFields)
  | {
      readonly type: "experiment_completed";
      readonly status: ExperimentStatus;
      readonly completedJobs: number;
      readonly totalJobs: number;
      readonly observedCostUsd: number;
      readonly elapsedMs: number;
      readonly outcomes: Readonly<Record<ExperimentOutcome, number>>;
    };

export interface RunExperimentInput {
  readonly config: ExperimentFile;
  readonly adapter: ModelAdapter;
  readonly outputPath: string;
  readonly telemetry?: TelemetrySink;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ExperimentProgressEvent) => void | Promise<void>;
  /** Overrides for the per-run agent policy. Used by mock runs to shorten tool timeouts. */
  readonly policyOverrides?: Partial<AgentPolicy>;
  /** Model ids per role. Defaults to the pinned benchmark models. */
  readonly models?: ModelRoles;
}

export async function planExperiment(config: ExperimentFile): Promise<ExperimentPlan> {
  const dataset = await loadDataset(`${config.dataset}/manifest.json`);
  const selectedCases = config.stratifiedSmoke ? stratifiedCases(dataset.cases) : dataset.cases;
  const jobs = config.configurations.flatMap((configuration) =>
    selectedCases.flatMap((datasetCase) =>
      Array.from({ length: config.repeats }, (_, repeat) => ({
        configuration,
        datasetCase,
        repeat,
        runId: `${datasetCase.id}:${configuration}:${repeat}`,
      })),
    ),
  );
  const budgetCeilingUsd = experimentBudgetCeiling(config);
  const estimatedCostUsd = jobs.length * config.estimatedCostPerRunUsd;
  if (estimatedCostUsd > budgetCeilingUsd) {
    throw new Error(`Estimated spend ${estimatedCostUsd.toFixed(2)} exceeds ceiling ${budgetCeilingUsd.toFixed(2)}`);
  }
  return {
    jobs: deterministicOrder(jobs, config.seed),
    totalJobs: jobs.length,
    selectedCaseCount: selectedCases.length,
    estimatedCostUsd,
    budgetCeilingUsd,
  };
}

export async function runExperiment(input: RunExperimentInput): Promise<readonly RawRun[]> {
  const started = performance.now();
  let plan: ExperimentPlan | undefined;
  let status: ExperimentStatus = "failed";
  let observedSpend = 0;
  const runs: RawRun[] = [];
  let outcomes = emptyOutcomeCounts();
  let hasPrimaryError = false;
  let primaryError: unknown;
  const emitProgress = async (event: ExperimentProgressEvent): Promise<void> => {
    await input.onProgress?.(event);
  };
  try {
    throwIfAborted(input.signal);
    plan = await planExperiment(input.config);
    throwIfAborted(input.signal);
    await emitProgress({
      type: "experiment_started",
      totalJobs: plan.totalJobs,
      selectedCaseCount: plan.selectedCaseCount,
      configurations: [...input.config.configurations],
      repeats: input.config.repeats,
      estimatedCostUsd: plan.estimatedCostUsd,
      budgetCeilingUsd: plan.budgetCeilingUsd,
    });
    await mkdir(dirname(input.outputPath), { recursive: true });
    for (const [jobOffset, job] of plan.jobs.entries()) {
      throwIfAborted(input.signal);
      if (observedSpend + input.config.estimatedCostPerRunUsd > plan.budgetCeilingUsd) {
        throw new Error(`Starting the next run could exceed ceiling ${plan.budgetCeilingUsd.toFixed(2)}`);
      }
      const index = jobOffset + 1;
      const jobStarted = performance.now();
      const eventFields = jobEventFields(job, index, plan.totalJobs);
      const budgetCeilingUsd = plan.budgetCeilingUsd;
      await emitProgress({ type: "job_started", ...eventFields, elapsedMs: jobStarted - started });
      let currentPhase: ExperimentPhase = job.configuration === "direct-sonnet" ? "model" : "routing";
      const phase = async (value: ExperimentPhase): Promise<void> => {
        currentPhase = value;
        await emitProgress({ type: "phase_changed", ...eventFields, phase: value, elapsedMs: performance.now() - started, observedCostUsd: observedSpend });
      };
      const meteredAdapter = wrapAdapter(input.adapter, async (request) => {
          const response = await input.adapter.generate(request);
          observedSpend += response.usage.costUsd;
          await emitProgress({
            type: "phase_changed",
            ...eventFields,
            phase: currentPhase,
            elapsedMs: performance.now() - started,
            observedCostUsd: observedSpend,
          });
          if (observedSpend > budgetCeilingUsd) {
            throw new Error(`Observed spend exceeds ceiling ${budgetCeilingUsd.toFixed(2)}`);
          }
          return response;
      });
      const run = await runOne(job, input.config, meteredAdapter, input.telemetry, input.signal, phase, input.policyOverrides, input.models);
      throwIfAborted(input.signal);
      await phase("persistence");
      throwIfAborted(input.signal);
      await appendFile(input.outputPath, `${JSON.stringify(run)}\n`, "utf8");
      runs.push(run);
      outcomes = { ...outcomes, [run.outcome]: outcomes[run.outcome] + 1 };
      await emitProgress({
        type: "job_completed",
        ...eventFields,
        outcome: run.outcome,
        costUsd: run.costUsd,
        observedCostUsd: observedSpend,
        durationMs: performance.now() - jobStarted,
        elapsedMs: performance.now() - started,
        completedJobs: runs.length,
      });
    }
    status = "completed";
  } catch (error) {
    status = input.signal?.aborted ? "cancelled" : "failed";
    hasPrimaryError = true;
    primaryError = error;
  }
  let cleanupError: unknown;
  try {
    if (plan) {
      await emitProgress({
        type: "experiment_completed",
        status,
        completedJobs: runs.length,
        totalJobs: plan.totalJobs,
        observedCostUsd: observedSpend,
        elapsedMs: performance.now() - started,
        outcomes: { ...outcomes },
      });
    }
  } catch (error) {
    cleanupError = error;
  }
  try {
    await input.telemetry?.flush();
  } catch (error) {
    cleanupError ??= error;
  }
  if (hasPrimaryError) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  return runs;
}

function experimentBudgetCeiling(config: ExperimentFile): number {
  const environmentCeiling = Number(process.env.MAX_EXPERIMENT_COST_USD ?? config.budgetUsd);
  const ceiling = Math.min(config.budgetUsd, environmentCeiling);
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error("Experiment budget must be positive");
  return ceiling;
}

function emptyOutcomeCounts(): Record<ExperimentOutcome, number> {
  return { completed: 0, abstained: 0, bounded: 0, failed: 0 };
}

function jobEventFields(job: ExperimentJob, index: number, totalJobs: number): JobEventFields {
  return {
    index,
    totalJobs,
    runId: job.runId,
    caseId: job.datasetCase.id,
    configuration: job.configuration,
    repeat: job.repeat,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("Experiment cancelled", "AbortError");
}

async function runOne(
  job: ExperimentJob,
  experiment: ExperimentFile,
  adapter: ModelAdapter,
  telemetry?: TelemetrySink,
  signal?: AbortSignal,
  onPhase?: (phase: ExperimentPhase) => void | Promise<void>,
  policyOverrides: Partial<AgentPolicy> = {},
  models: ModelRoles = DEFAULT_MODEL_ROLES,
): Promise<RawRun> {
  const { datasetCase, configuration, repeat, runId } = job;
  const configured = AGENT_CONFIGURATIONS[configuration];
  if (configuration !== "direct-sonnet") await onPhase?.("routing");
  const routing = configuration === "direct-sonnet"
    ? { model: models.executor, costUsd: 0, tokens: 0, latencyMs: 0, modelId: null }
    : await routeModel(datasetCase.prompt, adapter, models, signal);
  const faultMap = new Map(datasetCase.faultSchedule.map((fault) => [
    `${fault.tool}:${fault.invocation}`,
    faultName(fault.type),
  ]));
  const tools = createSyntheticTools((tool, context) => faultMap.get(`${tool}:${context.invocation}`) ?? null)
    .map((tool): ToolDefinition => ({
      ...tool,
      async execute(toolInput, context) {
        await onPhase?.("tool");
        throwIfAborted(context.signal);
        return tool.execute(toolInput, context);
      },
    }));
  const resources = configured.resources === "injected"
    ? experiment.resourceVersion === LEGACY_RESOURCE_VERSION
      ? "Operational resources: Escalate Definitivo suppliers. Require invoice evidence before payment matching. Never create duplicate follow-ups."
      : `Operational resources: ${operationalResourceText}`
    : "";
  const finalInstruction = experiment.promptVersion === LEGACY_PROMPT_VERSION
    ? "Return JSON with outcome, answer, and evidence-linked claims."
    : FINAL_RESULT_INSTRUCTION;
  const policy = { ...DEFAULT_AGENT_POLICY, maxCostUsd: Math.min(DEFAULT_AGENT_POLICY.maxCostUsd, experiment.budgetUsd), ...policyOverrides };
  const progressAdapter = wrapAdapter(adapter, async (request) => {
    await onPhase?.("model");
    return adapter.generate(request);
  });
  const result = await runAgent({
    runId,
    caseId: datasetCase.id,
    seed: experiment.seed + repeat,
    prompt: datasetCase.prompt,
    systemPrompt: `You are a bounded fiscal operations agent. ${resources} ${finalInstruction}`,
    model: routing.model,
    adapter: progressAdapter,
    tools,
    policy,
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(signal === undefined ? {} : { signal }),
  });
  const toolCalls = extractToolCalls(result.events);
  const validEvidenceIds = toolCalls.flatMap((call) => call.evidenceId ? [call.evidenceId] : []);
  const evidenceFacts = extractEvidenceFacts(result.events);
  const rawRun: RawRun = {
    runId,
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
    tokens: result.usage.tokens + routing.tokens,
    modelIds: [...(routing.modelId ? [routing.modelId] : []), ...result.modelIds],
    policyViolation: result.outcome === "bounded",
    duplicateMutation: hasDuplicateMutation(result.finalState.followUps),
  };
  await onPhase?.("scoring");
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

async function routeModel(prompt: string, adapter: ModelAdapter, models: ModelRoles, signal?: AbortSignal): Promise<{ model: string; costUsd: number; tokens: number; latencyMs: number; modelId: string }> {
  throwIfAborted(signal);
  const response = await adapter.generate({
    model: models.router,
    ...(capabilitiesFor(adapter, models.router).acceptsTemperature ? { temperature: 0 } : {}),
    maxOutputTokens: 40,
    signal: signal ?? new AbortController().signal,
    tools: [],
    messages: [{ role: "system", content: "Classify as simple-read-only, multi-step, recovery, or simulated-write. Return only the label." }, { role: "user", content: prompt }],
  });
  const label = response.text.trim();
  return {
    model: modelForRoutedTask(label === "simple-read-only" || label === "recovery" || label === "simulated-write" ? label : "multi-step", models),
    costUsd: response.usage.costUsd,
    tokens: response.usage.inputTokens + response.usage.outputTokens,
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
      idempotency?: { key?: unknown; committed?: unknown; replayed?: unknown };
    } | undefined;
    if (!result || typeof result.evidenceId !== "string") return [];
    return [[result.evidenceId, evidenceFactsFor(String(payload.name), payload.input, result)]];
  }));
}

function evidenceFactsFor(
  tool: string,
  input: unknown,
  result: {
    ok?: unknown;
    data?: unknown;
    error?: { code?: unknown; message?: unknown; retryable?: unknown };
    idempotency?: { key?: unknown; committed?: unknown; replayed?: unknown };
  },
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
      "result found false",
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
      ...(tool === "list_payments" ? paymentStatusFacts(result.data) : []),
      ...countFacts,
      ...inputFacts,
      ...flattenFacts(result.data),
    ];
  }
  const documentId = getStringPath(input, "documentId");
  const paymentId = getStringPath(input, "paymentId");
  const idempotencyKey = getStringPath(input, "idempotencyKey");
  const resultDocumentId = getStringPath(result.data, "documentId");
  const resultPaymentId = getStringPath(result.data, "paymentId");
  const supplierRfc = getStringPath(input, "supplierRfc");
  const resultSupplierRfc = getStringPath(result.data, "supplierRfc");
  const reason = getStringPath(input, "reason");
  const resultReason = getStringPath(result.data, "reason");
  const resultIdempotencyKey = typeof result.idempotency?.key === "string" ? result.idempotency.key : null;
  const committed = result.idempotency?.committed;
  const replayed = result.idempotency?.replayed;
  const validMatch = tool === "match_payment" && committed === true
    && paymentId !== null && documentId !== null && idempotencyKey !== null
    && resultPaymentId === paymentId && resultDocumentId === documentId
    && resultIdempotencyKey === idempotencyKey;
  const validFollowUp = tool === "create_follow_up" && committed === true
    && supplierRfc !== null && idempotencyKey !== null && reason !== null && reason.length > 0
    && resultSupplierRfc === supplierRfc && resultIdempotencyKey === idempotencyKey
    && resultReason === reason;
  return [
    `tool ${tool} succeeded`,
    ...(tool === "get_document" && documentId ? [`document ${documentId} found`] : []),
    ...(validMatch
      ? [`payment ${paymentId} matched to document ${documentId}`]
      : []),
    ...(validMatch ? ["match committed true"] : []),
    ...(validMatch && typeof replayed === "boolean" ? [`match replayed ${replayed}`, ...(replayed ? [] : ["match not replayed"])] : []),
    ...(validFollowUp ? ["follow-up committed true"] : []),
    ...(validFollowUp && typeof replayed === "boolean" ? [`follow-up replayed ${replayed}`] : []),
    ...inputFacts,
    ...flattenFacts(result.data),
  ];
}

function paymentStatusFacts(items: readonly unknown[]): readonly string[] {
  return items.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const payment = item as Record<string, unknown>;
    if (typeof payment.id !== "string") return [];
    if (payment.matchedDocumentId === null) {
      return [`payment ${payment.id} unmatched`, `payment ${payment.id} previously unmatched`];
    }
    return typeof payment.matchedDocumentId === "string"
      ? [`payment ${payment.id} matched to document ${payment.matchedDocumentId}`]
      : [];
  });
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
