import type { DatasetCase } from "../dataset.js";
import { caseTallies, type StatisticsMetric } from "../report-statistics.js";
import { scoreRun, type RawRun, type RunScore } from "../scoring.js";
import type { ScoringContract } from "../scoring-contract.js";
import {
  bonettPriceClusterInterval,
  bonettPriceInterval,
  clopperPearsonInterval,
  discordantCounts,
  mcnemarMidP,
  pairedBootstrap,
  pValueByInversion,
  STATS_METHODS_VERSION,
  zeroFailureSampleSize,
  type CaseTally,
  type Interval,
} from "../stats/index.js";
import { classifyCriticalErrors, CRITICAL_ERROR_TYPES, LEGACY_COMPATIBLE_RULES, SEVERITY_RULES_VERSION, type CriticalErrorType } from "./severity.js";
import { analysisOf, type NonInferiorityInterval, type PrimaryEstimand, type Thresholds } from "./thresholds.js";

export type GateDecision = "PASS" | "BLOCK" | "INCONCLUSIVE";
export const GATE_EXIT_CODES: Readonly<Record<GateDecision, number>> = { PASS: 0, BLOCK: 1, INCONCLUSIVE: 2 };

export interface GateArm {
  /** Label of the file the rows came from, for the summary only. */
  readonly source: string;
  readonly configuration: string;
  /** Every parsed row of the file. The gate selects the configuration itself. */
  readonly runs: readonly RawRun[];
  /** Rows that failed schema validation when the file was read. */
  readonly invalidRows: number;
}

export interface GateInput {
  readonly thresholds: Thresholds;
  readonly cases: readonly DatasetCase[];
  readonly expectedRepeats: number;
  readonly writeTools: ReadonlySet<string>;
  readonly candidate: GateArm;
  readonly reference: GateArm;
  readonly datasetIntegrityVerified: boolean;
  /** Scoring contract in effect. Required when the thresholds pin a scoring contract version. */
  readonly scoringContract?: ScoringContract;
}

export interface GateCheck { readonly id: string; readonly passed: boolean; readonly detail: string }

export interface GateComparison {
  readonly metric: StatisticsMetric;
  readonly margin: number;
  readonly cases: number;
  /** Mean over cases of candidate pass rate minus reference pass rate. */
  readonly difference: number | null;
  readonly interval: Interval | null;
  readonly status: GateDecision;
  readonly detail: string;
  /** Rough case count at which the interval would clear the margin, when that is estimable. */
  readonly casesSuggested: number | null;
  readonly estimand: PrimaryEstimand;
  readonly method: NonInferiorityInterval;
  /** Two-sided p-value for no difference: McNemar mid-p for all-pass, null for the bootstrap. Reported, not gated. */
  readonly pValue: number | null;
  /**
   * Per-case pass rates with the case-clustered Bonett-Price interval and its inverted p-value, reported beside
   * an all-pass decision so a difference in stability is not mistaken for a difference in accuracy. Not gated.
   * Null for the legacy analysis.
   */
  readonly secondary: { readonly estimand: "per-case-rate"; readonly method: "bonett-price-cluster"; readonly difference: number; readonly interval: Interval; readonly pValue: number } | null;
}

export interface GateResult {
  readonly decision: GateDecision;
  readonly exitCode: number;
  readonly thresholdsVersion: string;
  readonly thresholdsDate: string;
  /** The analysis the thresholds selected and the statistics code that ran it. */
  readonly analysis: { readonly primaryEstimand: PrimaryEstimand; readonly nonInferiorityInterval: NonInferiorityInterval; readonly statsMethodsVersion: string };
  readonly severityRulesVersion: string;
  readonly confidence: number;
  readonly candidate: { readonly source: string; readonly configuration: string; readonly cases: number; readonly runs: number };
  readonly reference: { readonly source: string; readonly configuration: string; readonly cases: number; readonly runs: number };
  readonly minimumCases: { readonly required: number; readonly observed: number; readonly status: GateDecision };
  readonly checks: readonly GateCheck[];
  readonly critical: {
    readonly cases: number;
    readonly casesWithCriticalError: number;
    readonly runsWithCriticalError: number;
    readonly byType: Readonly<Record<CriticalErrorType, number>>;
    /** One-sided Clopper-Pearson upper bound on the share of cases with a critical error. */
    readonly upperBound: number | null;
    readonly limit: number;
    readonly status: GateDecision;
    readonly affectedCases: readonly string[];
  };
  readonly comparisons: readonly GateComparison[];
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
  readonly recommendation: string | null;
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const points = (value: number): string => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pts`;
const worst = (statuses: readonly GateDecision[]): GateDecision =>
  statuses.includes("BLOCK") ? "BLOCK" : statuses.includes("INCONCLUSIVE") ? "INCONCLUSIVE" : "PASS";

function gridCheck(label: string, runs: readonly RawRun[], knownCases: ReadonlySet<string>, expectedRepeats: number): readonly GateCheck[] {
  const keys = runs.map(({ caseId, repeat }) => `${caseId}:${repeat}`);
  const perCase = new Map<string, Set<number>>();
  for (const { caseId, repeat } of runs) perCase.set(caseId, (perCase.get(caseId) ?? new Set()).add(repeat));
  const unknown = [...perCase.keys()].filter((caseId) => !knownCases.has(caseId));
  const incomplete = [...perCase.entries()].filter(([, repeats]) => repeats.size !== expectedRepeats || [...repeats].some((repeat) => repeat >= expectedRepeats));
  const unique = new Set(keys).size === keys.length && new Set(runs.map(({ runId }) => runId)).size === runs.length;
  return [
    { id: `${label}_rows_present`, passed: runs.length > 0, detail: `${runs.length} rows` },
    { id: `${label}_cases_known`, passed: unknown.length === 0, detail: unknown.length === 0 ? "every case id exists in the dataset" : `unknown case ids: ${unknown.sort().join(", ")}` },
    { id: `${label}_runs_unique`, passed: unique, detail: unique ? "no duplicate run ids or case and repeat pairs" : "duplicate run ids or case and repeat pairs" },
    { id: `${label}_repeats_complete`, passed: incomplete.length === 0, detail: incomplete.length === 0 ? `every case has repeats 0 to ${expectedRepeats - 1}` : `${incomplete.length} cases do not have exactly ${expectedRepeats} repeats` },
  ];
}

interface MetricInput {
  readonly metric: StatisticsMetric;
  readonly margin: number;
  readonly candidate: readonly RunScore[];
  readonly reference: readonly RunScore[];
  readonly candidateConfiguration: string;
  readonly referenceConfiguration: string;
  readonly thresholds: Thresholds;
  readonly seed: number;
}

/** Candidate and reference tallies of the cases scored for the metric in both arms, ordered by case id. */
function pairedTallies(input: MetricInput): readonly (readonly [CaseTally, CaseTally])[] {
  const referenceByCase = new Map(caseTallies(input.reference, input.referenceConfiguration, input.metric).map((tally) => [tally.caseId, tally]));
  return caseTallies(input.candidate, input.candidateConfiguration, input.metric).flatMap((tally) => {
    const other = referenceByCase.get(tally.caseId);
    return other ? [[tally, other] as const] : [];
  });
}

const rate = ({ passes, trials }: CaseTally): number => passes / trials;
const everyRepeatPassed = ({ passes, trials }: CaseTally): boolean => passes === trials;

function classify(low: number, high: number, margin: number): GateDecision {
  return high < -margin ? "BLOCK" : low < -margin ? "INCONCLUSIVE" : "PASS";
}

function describeStatus(status: GateDecision, margin: number): string {
  return status === "BLOCK"
    ? `the whole interval is below the margin of ${points(-margin)}`
    : status === "INCONCLUSIVE"
      ? `the interval spans the margin of ${points(-margin)}`
      : `the lower bound stays above the margin of ${points(-margin)}`;
}

/**
 * Rough case count at which an interval of the same shape would clear the margin: the half-width shrinks
 * with the square root of the number of units (n + 2 for the Bonett-Price pseudo-pairs).
 */
function suggestCases(status: GateDecision, centre: number, low: number, margin: number, units: number, pseudoUnits: number): number | null {
  const headroom = centre + margin;
  if (status !== "INCONCLUSIVE" || !(headroom > 0)) return null;
  return Math.ceil((units + pseudoUnits) * ((centre - low) / headroom) ** 2) - pseudoUnits;
}

/** thresholds-v1 and thresholds-v2: per-case pass rates with a percentile paired bootstrap, unchanged. */
function compareByBootstrap(input: MetricInput, pairs: readonly (readonly [CaseTally, CaseTally])[]): GateComparison {
  const { metric, margin, thresholds } = input;
  const settings = thresholds.bootstrap!;
  const base = { metric, margin, estimand: "per-case-rate" as const, method: "percentile-bootstrap" as const, pValue: null, secondary: null };
  const bootstrap = pairedBootstrap(pairs.map(([candidate, reference]) => [rate(candidate), rate(reference)] as const), { seed: input.seed, resamples: settings.resamples, confidence: thresholds.confidence });
  if (bootstrap === null) {
    return { ...base, cases: 0, difference: null, interval: null, status: "INCONCLUSIVE", detail: "no cases are scored for this metric in both arms", casesSuggested: null };
  }
  const { estimate, low, high } = bootstrap;
  const degenerate = low === high && thresholds.zeroWidthInterval!.policy === "inconclusive";
  const status: GateDecision = degenerate && classify(low, high, margin) === "PASS" ? "INCONCLUSIVE" : classify(low, high, margin);
  const detail = status === "INCONCLUSIVE" && low >= -margin
    ? "no case differs between the arms, so the interval has zero width and cannot demonstrate the margin"
    : describeStatus(status, margin);
  return { ...base, cases: pairs.length, difference: estimate, interval: { low, high }, status, detail, casesSuggested: suggestCases(status, estimate, low, margin, pairs.length, 0) };
}

/**
 * thresholds-v3: the Bonett-Price adjusted Wald interval. With the all-pass estimand each case is one binary
 * outcome (every repeat passed) and the interval is the single-run form; with per-case rates it is the
 * case-clustered form. The interval never has zero width, so there is no degenerate case to police.
 */
function compareByBonettPrice(input: MetricInput, pairs: readonly (readonly [CaseTally, CaseTally])[], estimand: PrimaryEstimand): GateComparison {
  const { metric, margin, thresholds } = input;
  const base = { metric, margin, estimand, method: "bonett-price" as const };
  if (pairs.length === 0) {
    return { ...base, cases: 0, difference: null, interval: null, status: "INCONCLUSIVE", detail: "no cases are scored for this metric in both arms", casesSuggested: null, pValue: null, secondary: null };
  }
  const differences = pairs.map(([candidate, reference]) => rate(candidate) - rate(reference));
  const clustered = bonettPriceClusterInterval(differences, thresholds.confidence);
  const clusteredP = pValueByInversion((alpha) => bonettPriceClusterInterval(differences, 1 - alpha));
  const counts = discordantCounts(pairs.map(([candidate, reference]) => [everyRepeatPassed(candidate), everyRepeatPassed(reference)] as const));
  const primary = estimand === "all-pass" ? bonettPriceInterval(counts, thresholds.confidence) : clustered;
  const status = classify(primary.low, primary.high, margin);
  const centre = (primary.low + primary.high) / 2;
  const suggested = suggestCases(status, centre, primary.low, margin, pairs.length, 2);
  // Never suggest as few cases as were already run when the interval still spans the margin.
  const suggestedAtLeastMore = suggested === null ? null : Math.max(pairs.length + 1, suggested);
  return {
    ...base,
    cases: pairs.length,
    difference: primary.estimate,
    interval: { low: primary.low, high: primary.high },
    status,
    detail: describeStatus(status, margin),
    casesSuggested: suggestedAtLeastMore,
    pValue: estimand === "all-pass" ? mcnemarMidP(counts) : clusteredP,
    secondary: estimand === "all-pass"
      ? { estimand: "per-case-rate", method: "bonett-price-cluster", difference: clustered.estimate, interval: { low: clustered.low, high: clustered.high }, pValue: clusteredP }
      : null,
  };
}

function compareMetric(input: MetricInput): GateComparison {
  const pairs = pairedTallies(input);
  const { primaryEstimand, nonInferiorityInterval } = analysisOf(input.thresholds);
  switch (nonInferiorityInterval) {
    case "percentile-bootstrap":
      return compareByBootstrap(input, pairs);
    case "bonett-price":
      return compareByBonettPrice(input, pairs, primaryEstimand);
    default: {
      const unhandled: never = nonInferiorityInterval;
      throw new Error(`Unhandled non-inferiority interval: ${String(unhandled)}`);
    }
  }
}

/**
 * Go-live gate. Decision order:
 * 1. BLOCK when a deterministic check fails, or when critical errors were observed and the upper
 *    bound on their rate exceeds its limit.
 * 2. BLOCK when a paired difference is below its non-inferiority margin with the whole interval.
 * 3. INCONCLUSIVE when an interval spans its margin, the run has fewer cases than required, or no
 *    critical error was observed but the sample is too small to demonstrate the limit.
 * 4. PASS otherwise.
 */
/**
 * Thresholds must pin the rules the code implements, or an older rule version that classifies the
 * dataset's cases identically (thresholds-v1 on dataset v1 or v2).
 */
function severityRulesCheck(pinned: string, cases: readonly DatasetCase[]): GateCheck {
  const versions = new Set(cases.map(({ id }) => id.split("-", 1)[0]!));
  const compatible = LEGACY_COMPATIBLE_RULES[pinned];
  const legacyOk = compatible !== undefined && versions.size > 0 && [...versions].every((version) => compatible.has(version));
  const passed = pinned === SEVERITY_RULES_VERSION || legacyOk;
  const detail = pinned === SEVERITY_RULES_VERSION
    ? `thresholds expect ${pinned}, code implements ${SEVERITY_RULES_VERSION}`
    : legacyOk
      ? `thresholds expect ${pinned}; code implements ${SEVERITY_RULES_VERSION}, which classifies dataset ${[...versions].sort().join(", ")} identically`
      : `thresholds expect ${pinned}, code implements ${SEVERITY_RULES_VERSION}`;
  return { id: "severity_rules_version", passed, detail };
}

/** Deterministic checks for the versions a thresholds file pins. Legacy files pin none, so their checks are unchanged. */
function pinnedVersionChecks(thresholds: Thresholds, contract: ScoringContract | undefined): readonly GateCheck[] {
  const pinned = thresholds.analysis;
  if (pinned === undefined) return [];
  const statsPassed = pinned.statsMethodsVersion === STATS_METHODS_VERSION;
  const contractPassed = contract !== undefined && contract.version === pinned.scoringContractVersion && contract.matchesLock;
  return [
    { id: "stats_methods_version", passed: statsPassed, detail: `thresholds expect ${pinned.statsMethodsVersion}, code implements ${STATS_METHODS_VERSION}` },
    {
      id: "scoring_contract_version",
      passed: contractPassed,
      detail: contract === undefined
        ? `thresholds expect ${pinned.scoringContractVersion}, but no scoring contract was provided`
        : `thresholds expect ${pinned.scoringContractVersion}; code is ${contract.version}, which ${contract.matchesLock ? "matches" : "does NOT match"} its lock`,
    },
  ];
}

export function evaluateGate(input: GateInput): GateResult {
  const { thresholds, candidate, reference } = input;
  const byId = new Map(input.cases.map((item) => [item.id, item]));
  const knownCases = new Set(byId.keys());
  const candidateRuns = candidate.runs.filter(({ configuration }) => configuration === candidate.configuration);
  const referenceRuns = reference.runs.filter(({ configuration }) => configuration === reference.configuration);
  const scoreKnown = (runs: readonly RawRun[]): RunScore[] => runs.flatMap((run) => {
    const datasetCase = byId.get(run.caseId);
    return datasetCase ? [scoreRun(run, datasetCase)] : [];
  });
  const candidateCases = new Set(candidateRuns.map(({ caseId }) => caseId));
  const referenceCases = new Set(referenceRuns.map(({ caseId }) => caseId));
  const sameCases = candidateCases.size === referenceCases.size && [...candidateCases].every((caseId) => referenceCases.has(caseId));
  const invalidRows = candidate.invalidRows + (reference.source === candidate.source ? 0 : reference.invalidRows);

  const checks: GateCheck[] = [
    { id: "dataset_integrity", passed: input.datasetIntegrityVerified, detail: input.datasetIntegrityVerified ? "dataset hash matches its manifest" : "dataset hash was not verified" },
    severityRulesCheck(thresholds.severityRulesVersion, input.cases),
    { id: "raw_rows_valid", passed: invalidRows === 0, detail: invalidRows === 0 ? "every row matches the raw run schema" : `${invalidRows} rows failed schema validation` },
    ...gridCheck("candidate", candidateRuns, knownCases, input.expectedRepeats),
    ...gridCheck("reference", referenceRuns, knownCases, input.expectedRepeats),
    ...pinnedVersionChecks(thresholds, input.scoringContract),
    { id: "arms_cover_same_cases", passed: sameCases, detail: sameCases ? "candidate and reference cover the same cases" : "candidate and reference cover different cases" },
  ];
  const checksPassed = checks.every(({ passed }) => passed);

  const byType = Object.fromEntries(CRITICAL_ERROR_TYPES.map((type) => [type, 0])) as Record<CriticalErrorType, number>;
  const affected = new Set<string>();
  let runsWithCriticalError = 0;
  for (const run of candidateRuns) {
    const datasetCase = byId.get(run.caseId);
    if (!datasetCase) continue;
    const errors = classifyCriticalErrors(run, datasetCase, input.writeTools);
    if (errors.length === 0) continue;
    runsWithCriticalError += 1;
    affected.add(run.caseId);
    for (const type of errors) byType[type] += 1;
  }
  const upperBound = candidateCases.size === 0 ? null : clopperPearsonInterval(affected.size, candidateCases.size, thresholds.confidence, "upper").high;
  // An exceeded bound with observed critical cases is evidence of harm. An exceeded bound with none
  // observed only means the sample is too small to demonstrate the limit, so it cannot pass or block.
  const criticalStatus: GateDecision = upperBound === null
    ? "INCONCLUSIVE"
    : upperBound <= thresholds.criticalErrors.maxUpperBound ? "PASS" : affected.size > 0 ? "BLOCK" : "INCONCLUSIVE";
  const cleanCasesNeeded = zeroFailureSampleSize(thresholds.criticalErrors.maxUpperBound, thresholds.confidence);

  const minimumStatus: GateDecision = candidateCases.size >= thresholds.minimumCases.value ? "PASS" : "INCONCLUSIVE";
  const candidateScores = scoreKnown(candidateRuns);
  const referenceScores = scoreKnown(referenceRuns);
  const comparisons = thresholds.nonInferiority.map(({ metric, margin }, index) => compareMetric({
    metric, margin, candidate: candidateScores, reference: referenceScores,
    candidateConfiguration: candidate.configuration, referenceConfiguration: reference.configuration,
    thresholds, seed: (thresholds.bootstrap?.seed ?? 0) + index,
  }));

  const decision = worst([checksPassed ? "PASS" : "BLOCK", criticalStatus, minimumStatus, ...comparisons.map(({ status }) => status)]);
  const reasons = [
    ...checks.filter(({ passed }) => !passed).map(({ id, detail }) => `BLOCK: deterministic check ${id} failed (${detail}).`),
    ...(criticalStatus === "BLOCK" ? [`BLOCK: ${affected.size} of ${candidateCases.size} cases had a critical error; the ${percent(thresholds.confidence)} upper bound ${percent(upperBound!)} exceeds the limit ${percent(thresholds.criticalErrors.maxUpperBound)}.`] : []),
    ...comparisons.filter(({ status }) => status === "BLOCK").map(({ metric, difference, detail }) => `BLOCK: ${metric} differs by ${points(difference!)}; ${detail}.`),
    ...(minimumStatus === "INCONCLUSIVE" ? [`INCONCLUSIVE: ${candidateCases.size} cases is below the required minimum of ${thresholds.minimumCases.value}.`] : []),
    ...(criticalStatus === "INCONCLUSIVE" ? [upperBound === null
      ? "INCONCLUSIVE: the candidate has no rows, so the critical-error bound is undefined."
      : `INCONCLUSIVE: no critical error was observed, but ${candidateCases.size} cases only bound the rate below ${percent(upperBound)}; the limit ${percent(thresholds.criticalErrors.maxUpperBound)} needs ${cleanCasesNeeded} clean cases.`] : []),
    ...comparisons.filter(({ status }) => status === "INCONCLUSIVE").map(({ metric, difference, detail }) => `INCONCLUSIVE: ${metric}${difference === null ? "" : ` differs by ${points(difference)}`}; ${detail}.`),
  ];
  const warnings = comparisons
    .filter(({ status, interval }) => status === "PASS" && interval !== null && interval.low === interval.high)
    .map(({ metric, cases }) => `${metric}: no case differs between the arms, so the bootstrap interval has zero width. With ${cases} cases this shows no observed regression; it does not prove non-inferiority at the margin.`);
  const suggested = comparisons.flatMap(({ casesSuggested }) => casesSuggested === null ? [] : [casesSuggested]);
  const recommendation = decision !== "INCONCLUSIVE"
    ? null
    : `Collect more cases before deciding. ${suggested.length > 0 ? `A rough estimate is ${Math.max(...suggested, thresholds.minimumCases.value, criticalStatus === "INCONCLUSIVE" ? cleanCasesNeeded : 0)} cases for the widest interval to clear its margin if the observed difference holds. ` : ""}More repeats of the same cases will not narrow these intervals much; add cases.`;

  return {
    decision,
    exitCode: GATE_EXIT_CODES[decision],
    thresholdsVersion: thresholds.version,
    thresholdsDate: thresholds.date,
    analysis: { ...analysisOf(thresholds), statsMethodsVersion: STATS_METHODS_VERSION },
    severityRulesVersion: SEVERITY_RULES_VERSION,
    confidence: thresholds.confidence,
    candidate: { source: candidate.source, configuration: candidate.configuration, cases: candidateCases.size, runs: candidateRuns.length },
    reference: { source: reference.source, configuration: reference.configuration, cases: referenceCases.size, runs: referenceRuns.length },
    minimumCases: { required: thresholds.minimumCases.value, observed: candidateCases.size, status: minimumStatus },
    checks,
    critical: {
      cases: candidateCases.size,
      casesWithCriticalError: affected.size,
      runsWithCriticalError,
      byType,
      upperBound,
      limit: thresholds.criticalErrors.maxUpperBound,
      status: criticalStatus,
      affectedCases: [...affected].sort(),
    },
    comparisons,
    reasons,
    warnings,
    recommendation,
  };
}
