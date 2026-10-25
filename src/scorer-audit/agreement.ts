import { z } from "zod";
import type { ScoringContract } from "../scoring-contract.js";
import { wilsonInterval, type Interval } from "../stats/index.js";
import { SCORER_AUDIT_VERSION, type AuditKey, type Verdict } from "./sample.js";

const VerdictSchema = z.enum(["pass", "fail"]);
const ScoringContractSchema = z.object({
  version: z.string(),
  sha256: z.string().nullable(),
  lockedSha256: z.string().nullable(),
  matchesLock: z.boolean(),
});

export const AuditKeySchema = z.object({
  version: z.literal(SCORER_AUDIT_VERSION),
  seed: z.number().int().min(0).max(2 ** 32 - 1),
  perStratum: z.number().int().positive(),
  source: z.object({
    rawSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    datasetHash: z.string().min(1),
    datasetVersion: z.string().min(1),
    scoringContract: ScoringContractSchema,
    mock: z.boolean(),
  }),
  strata: z.array(z.object({
    configuration: z.string().min(1),
    scorerVerdict: VerdictSchema,
    runs: z.number().int().nonnegative(),
    cases: z.number().int().nonnegative(),
    sampled: z.number().int().nonnegative(),
  })),
  items: z.array(z.object({
    itemId: z.string().min(1),
    runId: z.string().min(1),
    caseId: z.string().min(1),
    configuration: z.string().min(1),
    repeat: z.number().int().nonnegative(),
    scorerVerdict: VerdictSchema,
    caseRunsInStratum: z.number().int().positive(),
  })),
}).superRefine((key, context) => {
  const issue = (message: string): void => { context.addIssue({ code: "custom", message }); };
  const ids = key.items.map(({ itemId }) => itemId);
  if (new Set(ids).size !== ids.length) issue("item ids in the key must be unique");
  const strataKeys = key.strata.map(({ configuration, scorerVerdict }) => `${configuration}:${scorerVerdict}`);
  if (new Set(strataKeys).size !== strataKeys.length) issue("strata in the key must be unique");
  for (const stratum of key.strata) {
    const members = key.items.filter((item) => item.configuration === stratum.configuration && item.scorerVerdict === stratum.scorerVerdict);
    const name = `${stratum.configuration} ${stratum.scorerVerdict}`;
    if (members.length !== stratum.sampled) issue(`stratum ${name} lists ${stratum.sampled} sampled items but the key has ${members.length}`);
    if (!(stratum.sampled <= Math.min(key.perStratum, stratum.cases) && stratum.cases <= stratum.runs)) issue(`stratum ${name} has inconsistent counts`);
    if (new Set(members.map(({ caseId }) => caseId)).size !== members.length) issue(`stratum ${name} samples a case more than once`);
  }
  if (key.items.some((item) => !strataKeys.includes(`${item.configuration}:${item.scorerVerdict}`))) issue("every key item must belong to a listed stratum");
});

/** A labeler is named by role (lowercase words joined by hyphens), never by name. */
export const LABELER_ROLE = /^([a-z][a-z0-9]*-){1,4}(reviewer|labeler|annotator|auditor|expert)$/u;

/** The filled template. Fields the labeler does not edit pass through unchecked. */
export const AuditLabelsSchema = z.object({
  version: z.literal(SCORER_AUDIT_VERSION),
  labeler: z.string().regex(LABELER_ROLE, "labeler must be a role ending in -reviewer, -labeler, -annotator, -auditor or -expert, such as fiscal-reviewer, not a name"),
  items: z.array(z.object({
    itemId: z.string().min(1),
    caseId: z.string().min(1),
    label: z.object({ completion: z.enum(["pass", "fail", "unsure"]).nullable(), note: z.string().max(2_000).default("") }),
  }).passthrough()).min(1, "the labels file has no items"),
}).passthrough();
export type AuditLabels = z.infer<typeof AuditLabelsSchema>;

export interface DisagreementRate {
  /** Items with a pass or fail label. */
  readonly labeled: number;
  /** Labels that disagree with the scorer. */
  readonly disagreements: number;
  readonly rate: number | null;
  readonly wilson95: Interval | null;
}

export interface StratumAgreement extends DisagreementRate {
  readonly configuration: string;
  readonly scorerVerdict: Verdict;
  readonly runs: number;
  readonly unsure: number;
  readonly unlabeled: number;
}

export interface ArmAgreement {
  readonly configuration: string;
  /** Scorer said pass, the labeler said fail. */
  readonly falsePass: DisagreementRate;
  /** Scorer said fail, the labeler said pass. */
  readonly falseFail: DisagreementRate;
}

export interface AgreementResult {
  readonly version: typeof SCORER_AUDIT_VERSION;
  readonly labeler: string;
  readonly source: AuditKey["source"];
  readonly items: number;
  readonly labeled: number;
  readonly unsure: number;
  readonly unlabeled: number;
  readonly strata: readonly StratumAgreement[];
  readonly arms: readonly ArmAgreement[];
  /**
   * Run-level agreement: within a stratum each labeled case counts with its runs in that stratum (a ratio
   * estimator, since cases were drawn uniformly), then strata are weighted by their runs. Strata without a
   * label are left out and the remaining weights renormalised; a warning names them. A point estimate.
   */
  readonly weightedAgreement: number | null;
  /** Whether the scorer in this checkout is the one the key was sampled with. */
  readonly scorerUnchanged: boolean;
  readonly warnings: readonly string[];
}

function rateOf(labeled: number, disagreements: number): DisagreementRate {
  return {
    labeled,
    disagreements,
    rate: labeled === 0 ? null : disagreements / labeled,
    wilson95: labeled === 0 ? null : wilsonInterval(disagreements, labeled, 0.95),
  };
}

/**
 * Joins the labels to the key. Every labeled item must exist in the key and appear once. Unsure and unlabeled
 * items are counted and left out of every rate.
 */
export function scorerAgreement(key: AuditKey, labels: AuditLabels, current: ScoringContract): AgreementResult {
  const keyById = new Map(key.items.map((item) => [item.itemId, item]));
  const seen = new Set<string>();
  for (const { itemId, caseId } of labels.items) {
    const keyed = keyById.get(itemId);
    if (!keyed) throw new Error(`Label for ${itemId} has no entry in the key; the labels and key are from different audits`);
    if (keyed.caseId !== caseId) throw new Error(`${itemId} is case ${caseId} in the labels but ${keyed.caseId} in the key; the labels and key are from different audits`);
    if (seen.has(itemId)) throw new Error(`${itemId} is labeled more than once`);
    seen.add(itemId);
  }
  const labelById = new Map(labels.items.map(({ itemId, label }) => [itemId, label.completion]));
  const joined = key.items.map((item) => ({ ...item, label: labelById.get(item.itemId) ?? null }));

  const strata = key.strata.map((stratum): StratumAgreement => {
    const members = joined.filter((item) => item.configuration === stratum.configuration && item.scorerVerdict === stratum.scorerVerdict);
    const decided = members.filter((item) => item.label === "pass" || item.label === "fail");
    return {
      configuration: stratum.configuration,
      scorerVerdict: stratum.scorerVerdict,
      runs: stratum.runs,
      unsure: members.filter((item) => item.label === "unsure").length,
      unlabeled: members.filter((item) => item.label === null).length,
      ...rateOf(decided.length, decided.filter((item) => item.label !== item.scorerVerdict).length),
    };
  });
  const configurations = [...new Set(key.strata.map(({ configuration }) => configuration))];
  const stratumRate = (configuration: string, verdict: Verdict): DisagreementRate => {
    const stratum = strata.find((item) => item.configuration === configuration && item.scorerVerdict === verdict);
    return stratum ? rateOf(stratum.labeled, stratum.disagreements) : rateOf(0, 0);
  };
  const runLevelAgreement = (configuration: string, verdict: Verdict): number => {
    const decided = joined.filter((item) => item.configuration === configuration && item.scorerVerdict === verdict && (item.label === "pass" || item.label === "fail"));
    const weight = decided.reduce((sum, { caseRunsInStratum }) => sum + caseRunsInStratum, 0);
    return decided.reduce((sum, item) => sum + item.caseRunsInStratum * Number(item.label === item.scorerVerdict), 0) / weight;
  };
  const weighted = strata.filter(({ labeled }) => labeled > 0);
  const weightTotal = weighted.reduce((sum, { runs }) => sum + runs, 0);
  const emptyStrata = strata.filter(({ labeled }) => labeled === 0).map(({ configuration, scorerVerdict }) => `${configuration} ${scorerVerdict}`);
  const scorerUnchanged = current.sha256 !== null && current.sha256 === key.source.scoringContract.sha256 && current.version === key.source.scoringContract.version;
  const unlabeled = joined.filter(({ label }) => label === null).length;
  return {
    version: SCORER_AUDIT_VERSION,
    labeler: labels.labeler,
    source: key.source,
    items: key.items.length,
    labeled: joined.filter(({ label }) => label === "pass" || label === "fail").length,
    unsure: joined.filter(({ label }) => label === "unsure").length,
    unlabeled,
    strata,
    arms: configurations.map((configuration) => ({ configuration, falsePass: stratumRate(configuration, "pass"), falseFail: stratumRate(configuration, "fail") })),
    weightedAgreement: weightTotal === 0 ? null : weighted.reduce((sum, { configuration, scorerVerdict, runs }) => sum + (runs / weightTotal) * runLevelAgreement(configuration, scorerVerdict), 0),
    scorerUnchanged,
    warnings: [
      ...(key.source.mock ? ["The audited runs came from the scripted mock; this audit only exercises the tooling."] : []),
      ...(scorerUnchanged ? [] : [`The scorer in this checkout (${current.version}, ${current.sha256 ?? "no hash"}) differs from the one the sample was drawn with (${key.source.scoringContract.version}, ${key.source.scoringContract.sha256 ?? "no hash"}). The scorer verdicts in the key are the ones audited.`]),
      ...(unlabeled > 0 ? [`${unlabeled} items have no label.`] : []),
      ...(emptyStrata.length > 0 ? [`No labels in stratum ${emptyStrata.join(", ")}; the weighted agreement leaves it out.`] : []),
    ],
  };
}

const percent = (value: number | null): string => value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
const interval = (value: Interval | null): string => value === null ? "N/A" : `${percent(value.low)} to ${percent(value.high)}`;
const rateCell = (rate: DisagreementRate): string => rate.labeled === 0 ? "N/A" : `${rate.disagreements}/${rate.labeled}, ${percent(rate.rate)} (${interval(rate.wilson95)})`;

export function renderAgreement(result: AgreementResult): string {
  return [
    "# Scorer audit",
    "",
    `Labeler: ${result.labeler}. Items: ${result.items} (${result.labeled} labeled, ${result.unsure} unsure, ${result.unlabeled} unlabeled). Scoring contract: ${result.source.scoringContract.version}, sha256 ${result.source.scoringContract.sha256 ?? "not available"}. Raw rows sha256 ${result.source.rawSha256}. Dataset ${result.source.datasetVersion} (${result.source.datasetHash}).`,
    ...result.warnings.map((warning) => `\nWarning: ${warning}`),
    "",
    "A false pass is a run the scorer passed and the labeler failed; a false fail is the reverse. Each rate is over one run per sampled case, so it describes cases in that stratum, with a Wilson 95% interval. Unsure items are left out.",
    "",
    "| Configuration | False pass | False fail |",
    "|---|---|---|",
    ...result.arms.map((arm) => `| ${arm.configuration} | ${rateCell(arm.falsePass)} | ${rateCell(arm.falseFail)} |`),
    "",
    `Run-level agreement (each labeled case weighted by its runs, strata by their runs; no interval): ${percent(result.weightedAgreement)}.`,
    "",
  ].join("\n");
}
