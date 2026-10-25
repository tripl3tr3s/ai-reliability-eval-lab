import { isV3Case, type DatasetCase } from "../dataset.js";
import type { ScoringContract } from "../scoring-contract.js";
import type { RawRun, RunScore } from "../scoring.js";
import { mulberry32 } from "../stats/index.js";

/**
 * Human audit of the deterministic scorer (docs/decisions/2026-10-24-scorer-audit.md). A seeded, stratified
 * sample of runs goes to a labeler without the arm or the scorer's verdict; a separate key maps each item
 * back. The audited verdict is completion, the primary metric.
 */
export const SCORER_AUDIT_VERSION = "scorer-audit-v1";
export const DEFAULT_PER_STRATUM = 40;

export type Verdict = "pass" | "fail";

export interface AuditSource {
  readonly rawSha256: string;
  readonly datasetHash: string;
  readonly datasetVersion: string;
  readonly scoringContract: ScoringContract;
  /** True when the rows came from the scripted mock; such an audit only exercises the tooling. */
  readonly mock: boolean;
}

export interface AuditStratum {
  readonly configuration: string;
  readonly scorerVerdict: Verdict;
  /** Runs in the stratum: the weight of the stratum in pooled estimates. */
  readonly runs: number;
  readonly cases: number;
  readonly sampled: number;
}

export interface AuditKeyItem {
  readonly itemId: string;
  readonly runId: string;
  readonly caseId: string;
  readonly configuration: string;
  readonly repeat: number;
  readonly scorerVerdict: Verdict;
  /** Runs of this case in its stratum: the weight that turns the case-level sample into a run-level estimate. */
  readonly caseRunsInStratum: number;
}

export interface AuditKey {
  readonly version: typeof SCORER_AUDIT_VERSION;
  readonly seed: number;
  readonly perStratum: number;
  readonly source: AuditSource;
  readonly strata: readonly AuditStratum[];
  readonly items: readonly AuditKeyItem[];
}

export interface AuditTemplateItem {
  readonly itemId: string;
  readonly caseId: string;
  readonly category: string;
  readonly prompt: string;
  /** What a correct run looks like, taken from the dataset. */
  /**
   * What a correct run looks like, from the dataset: the reference answer only (v3). The scorer's own checks
   * (fact sets, expected state, forbidden tools) are left out so the label does not repeat them. v2 cases
   * have no reference answer; the labeler judges them from the prompt and the run.
   */
  readonly guidance: { readonly referenceAnswer: string | null };
  readonly run: {
    readonly outcome: RawRun["outcome"];
    readonly answer: string;
    readonly claims: readonly string[];
    readonly toolCalls: readonly { readonly name: string; readonly input: unknown }[];
    readonly finalState: unknown;
  };
  /** Filled in by the labeler: pass, fail, or unsure. */
  readonly label: { readonly completion: Verdict | "unsure" | null; readonly note: string };
}

export interface AuditTemplate {
  readonly version: typeof SCORER_AUDIT_VERSION;
  readonly instructions: string;
  /** The labeler's role, never a name, for example "domain-reviewer". */
  readonly labeler: string;
  readonly items: readonly AuditTemplateItem[];
}

export const LABELING_INSTRUCTIONS = "Some prompts appear more than once with different runs; judge each item on its own. For each item, read the prompt and, where there is one, the reference answer, then decide from your own reading whether the run completed the task correctly: the answer is right and makes no false or unsafe claim, the tool calls and final state do what the task needed and nothing it forbade, and a request that cannot be answered is declined. The reference answer is one correct answer, not the only one. Set label.completion to pass, fail, or unsure, and explain any fail or unsure in label.note. The configuration and the scorer's verdict are hidden on purpose; do not try to infer them. Set labeler to your role ending in -reviewer, -labeler, -annotator, -auditor or -expert (for example fiscal-reviewer), not your name.";

const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Fisher-Yates shuffle driven by the seeded generator; returns a new array. */
function shuffled<T>(items: readonly T[], random: () => number): readonly T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

function guidanceOf(datasetCase: DatasetCase): AuditTemplateItem["guidance"] {
  return { referenceAnswer: isV3Case(datasetCase) ? datasetCase.referenceAnswer : null };
}

export interface SampleInput {
  readonly runs: readonly RawRun[];
  readonly scores: readonly RunScore[];
  readonly cases: readonly DatasetCase[];
  readonly perStratum: number;
  readonly seed: number;
  readonly source: AuditSource;
}

/**
 * Stratifies runs by configuration and the scorer's completion verdict, then draws up to `perStratum` cases
 * per stratum and one run of each drawn case. Within a stratum the items are distinct cases, so the Wilson
 * interval on that stratum's disagreement rate applies. Across strata a case can recur: the other arm ran it
 * too, and a case with mixed repeats sits in both verdict strata of one arm. The labeler then sees that
 * prompt more than once with different runs. Items are shuffled across strata before numbering, so their
 * order reveals neither the arm nor the verdict.
 */
export function sampleForAudit(input: SampleInput): { readonly key: AuditKey; readonly template: AuditTemplate } {
  if (!Number.isInteger(input.perStratum) || input.perStratum < 1) throw new RangeError(`perStratum must be a positive integer, received ${input.perStratum}`);
  const random = mulberry32(input.seed);
  const runsById = new Map(input.runs.map((run) => [run.runId, run]));
  const casesById = new Map(input.cases.map((item) => [item.id, item]));
  const scores = [...input.scores].sort((left, right) => byText(left.runId, right.runId));
  const strataKeys = [...new Set(scores.map(({ configuration, completionPassed }) => `${configuration}\u0000${completionPassed ? "pass" : "fail"}`))].sort(byText);

  const drawn = strataKeys.map((stratumKey) => {
    const [configuration, verdict] = stratumKey.split("\u0000") as [string, Verdict];
    const members = scores.filter((score) => score.configuration === configuration && (score.completionPassed ? "pass" : "fail") === verdict);
    const caseIds = [...new Set(members.map(({ caseId }) => caseId))].sort(byText);
    const chosenCases = shuffled(caseIds, random).slice(0, input.perStratum);
    const picks = chosenCases.map((caseId) => {
      const candidates = members.filter((score) => score.caseId === caseId);
      return candidates[Math.floor(random() * candidates.length)]!;
    });
    const stratum: AuditStratum = { configuration, scorerVerdict: verdict, runs: members.length, cases: caseIds.length, sampled: picks.length };
    const runsOfCase = (caseId: string): number => members.filter((score) => score.caseId === caseId).length;
    return { stratum, picks: picks.map((score) => ({ score, verdict, caseRunsInStratum: runsOfCase(score.caseId) })) };
  });

  const ordered = shuffled(drawn.flatMap(({ picks }) => picks), random);
  const width = Math.max(3, String(ordered.length).length);
  const numbered = ordered.map((pick, index) => ({ ...pick, itemId: `item-${String(index + 1).padStart(width, "0")}` }));

  const key: AuditKey = {
    version: SCORER_AUDIT_VERSION,
    seed: input.seed,
    perStratum: input.perStratum,
    source: input.source,
    strata: drawn.map(({ stratum }) => stratum),
    items: numbered.map(({ itemId, score, verdict, caseRunsInStratum }) => ({ itemId, runId: score.runId, caseId: score.caseId, configuration: score.configuration, repeat: score.repeat, scorerVerdict: verdict, caseRunsInStratum })),
  };
  const template: AuditTemplate = {
    version: SCORER_AUDIT_VERSION,
    instructions: LABELING_INSTRUCTIONS,
    labeler: "",
    items: numbered.map(({ itemId, score }) => {
      const run = runsById.get(score.runId);
      const datasetCase = casesById.get(score.caseId);
      if (!run || !datasetCase) throw new Error(`Scored run ${score.runId} has no raw row or dataset case`);
      return {
        itemId,
        caseId: datasetCase.id,
        category: datasetCase.category,
        prompt: datasetCase.prompt,
        guidance: guidanceOf(datasetCase),
        run: {
          outcome: run.outcome,
          answer: run.answer,
          claims: run.claims.map(({ text }) => text),
          toolCalls: run.toolCalls.map(({ name, input: callInput }) => ({ name, input: callInput })),
          finalState: run.finalState,
        },
        label: { completion: null, note: "" },
      };
    }),
  };
  return { key, template };
}
