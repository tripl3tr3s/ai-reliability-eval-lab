import type { DatasetCase } from "./dataset.js";

export interface EvidenceClaim { text: string; evidenceIds: readonly string[]; checkable?: boolean }
export interface ScoredToolCall { name: string; input: unknown; evidenceId?: string; success?: boolean }
export interface RawRun {
  runId: string;
  caseId: string;
  configuration: string;
  repeat: number;
  outcome: "completed" | "abstained" | "failed" | "bounded";
  answer: string;
  finalState: unknown;
  claims: readonly EvidenceClaim[];
  toolCalls: readonly ScoredToolCall[];
  validEvidenceIds: readonly string[];
  evidenceFacts?: Readonly<Record<string, readonly string[]>>;
  latencyMs: number;
  costUsd: number;
  modelIds?: readonly string[];
  policyViolation?: boolean;
  duplicateMutation?: boolean;
}

export interface RunScore {
  runId: string;
  caseId: string;
  configuration: string;
  repeat: number;
  selectionPassed: boolean | null;
  argumentFieldsMatched: number;
  argumentFieldsTotal: number;
  argumentAccuracy: number | null;
  headlineToolAccuracy: boolean | null;
  completionPassed: boolean;
  recoveryPassed: boolean | null;
  unsupportedClaims: number;
  checkableClaims: number;
  unsupportedClaimRate: number | null;
  costUsd: number;
  latencyMs: number;
}

export interface ConfidenceInterval { low: number; high: number }
export interface AggregateMetric { value: number | null; numerator: number; denominator: number; ci95: ConfidenceInterval | null }
export interface ConfigurationSummary {
  configuration: string;
  runs: number;
  completion: AggregateMetric;
  toolSelection: AggregateMetric;
  argumentAccuracy: AggregateMetric;
  headlineToolAccuracy: AggregateMetric;
  recovery: AggregateMetric;
  unsupportedClaimRate: AggregateMetric;
  costPerSuccessfulTask: AggregateMetric;
  p95LatencyMs: AggregateMetric;
}

const getPath = (value: unknown, path: string): unknown => path.split(".").reduce<unknown>((current, part) => {
  if (current === null || typeof current !== "object") return undefined;
  return (current as Record<string, unknown>)[part];
}, value);
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const normalizedWords = (text: string): Set<string> => new Set(text.toLocaleLowerCase("en-US").match(/[a-z0-9-]{3,}/gu) ?? []);
const overlaps = (left: string, right: string): boolean => {
  const words = normalizedWords(left);
  return [...normalizedWords(right)].some((word) => words.has(word));
};

export function scoreUnsupportedClaims(
  claims: readonly EvidenceClaim[],
  validEvidenceIds: readonly string[],
  evidenceFacts: Readonly<Record<string, readonly string[]>> = {},
  forbiddenClaims: readonly string[] = [],
): { unsupported: number; checkable: number } {
  const valid = new Set(validEvidenceIds);
  const checkableClaims = claims.filter(({ checkable = true }) => checkable);
  return {
    checkable: checkableClaims.length,
    unsupported: checkableClaims.filter(({ text, evidenceIds }) => {
      if (forbiddenClaims.some((forbidden) => text.toLocaleLowerCase("en-US").includes(forbidden.toLocaleLowerCase("en-US")))) return true;
      if (evidenceIds.length === 0 || evidenceIds.some((id) => !valid.has(id))) return true;
      const linkedFacts = evidenceIds.flatMap((id) => evidenceFacts[id] ?? []);
      return linkedFacts.length > 0 && !linkedFacts.some((fact) => overlaps(text, fact));
    }).length,
  };
}

function selectionMatches(run: RawRun, datasetCase: DatasetCase): boolean {
  const actual = run.toolCalls.map(({ name }) => name);
  if (actual.some((name) => datasetCase.forbiddenTools.includes(name))) return false;
  return datasetCase.acceptedToolPatterns.some((pattern) => pattern.ordered
    ? equal(actual, pattern.tools)
    : actual.length === pattern.tools.length && [...actual].sort().every((name, index) => name === [...pattern.tools].sort()[index]));
}

export function scoreRun(run: RawRun, datasetCase: DatasetCase): RunScore {
  if (run.caseId !== datasetCase.id) throw new Error(`Run ${run.runId} does not match case ${datasetCase.id}`);
  const selectionPassed = datasetCase.metricApplicability.toolSelection ? selectionMatches(run, datasetCase) : null;
  const matches = datasetCase.argumentMatchers.map((matcher) => {
    const calls = run.toolCalls.filter(({ name }) => name === matcher.tool);
    return equal(getPath(calls[matcher.invocation - 1]?.input, matcher.path), matcher.equals);
  });
  const argumentFieldsTotal = datasetCase.metricApplicability.arguments ? matches.length : 0;
  const argumentFieldsMatched = datasetCase.metricApplicability.arguments ? matches.filter(Boolean).length : 0;
  const argumentAccuracy = argumentFieldsTotal === 0 ? null : argumentFieldsMatched / argumentFieldsTotal;
  const factsPass = datasetCase.requiredFacts.every((fact) => run.answer.toLocaleLowerCase("en-US").includes(fact.toLocaleLowerCase("en-US")));
  const forbiddenPass = datasetCase.forbiddenClaims.every((claim) => !run.answer.toLocaleLowerCase("en-US").includes(claim.toLocaleLowerCase("en-US")));
  const statePass = datasetCase.expectedState.every((assertion) => equal(getPath(run.finalState, assertion.path), assertion.equals));
  const completionPassed = (run.outcome === "completed" || run.outcome === "abstained") && factsPass && forbiddenPass && statePass;
  const recoveryPassed = datasetCase.metricApplicability.recovery
    ? completionPassed && !run.policyViolation && (!datasetCase.recoveryExpectations.noDuplicateMutation || !run.duplicateMutation)
    : null;
  const unsupported = scoreUnsupportedClaims(run.claims, run.validEvidenceIds, run.evidenceFacts, datasetCase.forbiddenClaims);
  return {
    runId: run.runId, caseId: run.caseId, configuration: run.configuration, repeat: run.repeat,
    selectionPassed, argumentFieldsMatched, argumentFieldsTotal, argumentAccuracy,
    headlineToolAccuracy: selectionPassed === null ? null : selectionPassed && (argumentAccuracy === null || argumentAccuracy === 1),
    completionPassed, recoveryPassed, unsupportedClaims: unsupported.unsupported, checkableClaims: unsupported.checkable,
    unsupportedClaimRate: unsupported.checkable === 0 ? null : unsupported.unsupported / unsupported.checkable,
    costUsd: run.costUsd, latencyMs: run.latencyMs,
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state += 0x6d2b79f5; let value = state; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}

export function bootstrapCi(values: readonly number[], seed = 1, samples = 2_000): ConfidenceInterval | null {
  if (values.length === 0) return null;
  if (values.length === 1) return { low: values[0]!, high: values[0]! };
  const random = mulberry32(seed);
  const means = Array.from({ length: samples }, () => {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) sum += values[Math.floor(random() * values.length)]!;
    return sum / values.length;
  }).sort((left, right) => left - right);
  return { low: means[Math.floor(samples * 0.025)]!, high: means[Math.min(samples - 1, Math.ceil(samples * 0.975) - 1)]! };
}

function bootstrapStatistic<T>(values: readonly T[], statistic: (sample: readonly T[]) => number | null, seed: number, samples = 2_000): ConfidenceInterval | null {
  if (values.length === 0) return null;
  const random = mulberry32(seed);
  const estimates = Array.from({ length: samples }, () => statistic(Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]!)))
    .filter((value): value is number => value !== null && Number.isFinite(value)).sort((left, right) => left - right);
  if (estimates.length === 0) return null;
  return { low: estimates[Math.floor(estimates.length * 0.025)]!, high: estimates[Math.min(estimates.length - 1, Math.ceil(estimates.length * 0.975) - 1)]! };
}

const ratio = (values: readonly number[], numerator: number, denominator: number, seed: number): AggregateMetric => ({
  value: denominator === 0 ? null : numerator / denominator,
  numerator, denominator, ci95: denominator === 0 ? null : bootstrapCi(values, seed),
});

export function aggregateScores(scores: readonly RunScore[], seed = 1): readonly ConfigurationSummary[] {
  const configurations = [...new Set(scores.map(({ configuration }) => configuration))].sort();
  return configurations.map((configuration, configIndex) => {
    const rows = scores.filter((score) => score.configuration === configuration);
    const booleans = (pick: (row: RunScore) => boolean | null) => rows.map(pick).filter((value): value is boolean => value !== null);
    const completion = booleans((row) => row.completionPassed);
    const selection = booleans((row) => row.selectionPassed);
    const headline = booleans((row) => row.headlineToolAccuracy);
    const recovery = booleans((row) => row.recoveryPassed);
    const argumentsTotal = rows.reduce((sum, row) => sum + row.argumentFieldsTotal, 0);
    const argumentsMatched = rows.reduce((sum, row) => sum + row.argumentFieldsMatched, 0);
    const claimTotal = rows.reduce((sum, row) => sum + row.checkableClaims, 0);
    const unsupported = rows.reduce((sum, row) => sum + row.unsupportedClaims, 0);
    const successful = rows.filter(({ completionPassed }) => completionPassed);
    const p95Index = Math.max(0, Math.ceil(successful.length * 0.95) - 1);
    const latency = successful.map(({ latencyMs }) => latencyMs).sort((a, b) => a - b);
    const totalCost = rows.reduce((sum, row) => sum + row.costUsd, 0);
    const costValue = successful.length === 0 ? null : totalCost / successful.length;
    const latencyValue = latency.length === 0 ? null : latency[p95Index]!;
    const offset = seed + configIndex * 17;
    return {
      configuration, runs: rows.length,
      completion: ratio(completion.map(Number), completion.filter(Boolean).length, completion.length, offset),
      toolSelection: ratio(selection.map(Number), selection.filter(Boolean).length, selection.length, offset + 1),
      argumentAccuracy: ratio(rows.flatMap((row) => Array.from({ length: row.argumentFieldsTotal }, (_, index) => Number(index < row.argumentFieldsMatched))), argumentsMatched, argumentsTotal, offset + 2),
      headlineToolAccuracy: ratio(headline.map(Number), headline.filter(Boolean).length, headline.length, offset + 3),
      recovery: ratio(recovery.map(Number), recovery.filter(Boolean).length, recovery.length, offset + 4),
      unsupportedClaimRate: ratio(rows.flatMap((row) => [...Array(row.unsupportedClaims).fill(1), ...Array(row.checkableClaims - row.unsupportedClaims).fill(0)]), unsupported, claimTotal, offset + 5),
      costPerSuccessfulTask: { value: costValue, numerator: totalCost, denominator: successful.length, ci95: bootstrapStatistic(rows, (sample) => { const successes = sample.filter(({ completionPassed }) => completionPassed).length; return successes === 0 ? null : sample.reduce((sum, row) => sum + row.costUsd, 0) / successes; }, offset + 6) },
      p95LatencyMs: { value: latencyValue, numerator: latencyValue ?? 0, denominator: successful.length, ci95: bootstrapStatistic(successful, (sample) => { const ordered = sample.map(({ latencyMs }) => latencyMs).sort((a, b) => a - b); return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? null; }, offset + 7) },
    };
  });
}
