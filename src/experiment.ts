import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ModelAdapter, RunnerEvent } from "./contracts.js";
import { ANTHROPIC_MODELS } from "./adapter.js";
import { AGENT_CONFIGURATIONS, CONFIGURATION_IDS, DEFAULT_AGENT_POLICY, modelForRoutedTask } from "./config.js";
import { loadDataset, type DatasetCase } from "./dataset.js";
import type { FaultKind } from "./faults.js";
import { runAgent } from "./runner.js";
import { scoreRun, type RawRun, type ScoredToolCall } from "./scoring.js";
import { createSyntheticTools } from "./tools.js";
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
  promptVersion: z.string().min(1),
  resourceVersion: z.string().min(1),
  stratifiedSmoke: z.boolean().optional(),
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
    ? "Operational resources: Escalate Definitivo suppliers. Require invoice evidence before payment matching. Never create duplicate follow-ups."
    : "";
  const policy = { ...DEFAULT_AGENT_POLICY, maxCostUsd: Math.min(DEFAULT_AGENT_POLICY.maxCostUsd, experiment.budgetUsd) };
  const result = await runAgent({
    runId: `${datasetCase.id}:${configuration}:${repeat}`,
    caseId: datasetCase.id,
    seed: experiment.seed + repeat,
    prompt: datasetCase.prompt,
    systemPrompt: `You are a bounded fiscal operations agent. ${resources} Return JSON with outcome, answer, and evidence-linked claims.`,
    model: routing.model,
    adapter,
    tools,
    policy,
    ...(telemetry === undefined ? {} : { telemetry }),
  });
  const toolCalls = extractToolCalls(result.events);
  const validEvidenceIds = toolCalls.flatMap((call) => call.evidenceId ? [call.evidenceId] : []);
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
    latencyMs: routing.latencyMs + latencyFromEvents(result.events),
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

function extractToolCalls(events: readonly RunnerEvent[]): ScoredToolCall[] {
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

function latencyFromEvents(events: readonly RunnerEvent[]): number {
  if (events.length < 2) return 0;
  return Math.max(0, Date.parse(events.at(-1)?.at ?? "") - Date.parse(events[0]?.at ?? ""));
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
