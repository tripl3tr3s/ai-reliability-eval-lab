import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadDataset, sha256 } from "../dataset.js";
import { loadExperimentConfig } from "../experiment.js";
import { containsMockRuns, readRawRuns } from "../raw-run.js";
import { currentScoringContract, type ScoringContract } from "../scoring-contract.js";
import { scoreRun } from "../scoring.js";
import { AuditKeySchema, AuditLabelsSchema, renderAgreement, scorerAgreement, type AgreementResult } from "./agreement.js";
import { DEFAULT_PER_STRATUM, sampleForAudit, type AuditKey } from "./sample.js";

/** The key and the template live in sibling folders, so the to-label folder can be handed over on its own. */
export const KEY_FILE = join("key", "key.json");
export const TEMPLATE_FILE = join("to-label", "labels-template.json");

export interface SampleCommandInput {
  readonly rawPath: string;
  readonly configPath: string;
  readonly outputDirectory?: string;
  readonly perStratum?: number;
  readonly seed?: number;
  readonly scoringContract?: ScoringContract;
}

const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path} as JSON`, { cause: error });
  }
}

/**
 * Draws the audit sample and writes the blinded template and the key side by side. Refuses to overwrite an
 * existing audit, so labeling work is never replaced. Defaults: audits/<first 12 hex of the raw sha256>,
 * 40 cases per stratum, and the experiment seed.
 */
export async function runScorerAuditSample(input: SampleCommandInput): Promise<{ readonly directory: string; readonly key: AuditKey }> {
  const config = await loadExperimentConfig(input.configPath);
  const dataset = await loadDataset(`${config.dataset}/manifest.json`);
  const bytes = await readFile(input.rawPath);
  const rawSha256 = sha256(bytes);
  const runs = readRawRuns(bytes.toString("utf8"));
  if (runs.length === 0) throw new Error(`${input.rawPath} has no runs to audit`);
  const byId = new Map(dataset.cases.map((item) => [item.id, item]));
  const scores = runs.map((run) => {
    const datasetCase = byId.get(run.caseId);
    if (!datasetCase) throw new Error(`Unknown case ID: ${run.caseId}`);
    return scoreRun(run, datasetCase);
  });
  const directory = input.outputDirectory ?? join("audits", rawSha256.slice(0, 12));
  for (const file of [KEY_FILE, TEMPLATE_FILE]) {
    if (await exists(join(directory, file))) throw new Error(`${join(directory, file)} already exists; choose another --output so existing labels are not replaced`);
  }
  const { key, template } = sampleForAudit({
    runs,
    scores,
    cases: dataset.cases,
    perStratum: input.perStratum ?? DEFAULT_PER_STRATUM,
    seed: input.seed ?? config.seed,
    source: {
      rawSha256,
      datasetHash: dataset.hash,
      datasetVersion: dataset.version,
      scoringContract: input.scoringContract ?? await currentScoringContract(),
      mock: containsMockRuns(runs.flatMap(({ modelIds }) => modelIds ?? [])),
    },
  });
  await mkdir(join(directory, "key"), { recursive: true });
  await mkdir(join(directory, "to-label"), { recursive: true });
  // "wx" fails if the file appeared since the check above; a half-written audit is removed.
  await writeFile(join(directory, KEY_FILE), json(key), { encoding: "utf8", flag: "wx" });
  try {
    await writeFile(join(directory, TEMPLATE_FILE), json(template), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    await unlink(join(directory, KEY_FILE));
    throw error;
  }
  return { directory, key };
}

export interface ScoreCommandInput {
  readonly keyPath: string;
  readonly labelsPath: string;
  readonly outputDirectory: string;
  readonly scoringContract?: ScoringContract;
}

/** Scores a filled template against its key and writes agreement.json and agreement.md, replacing earlier ones: they are derived files. */
export async function runScorerAuditScore(input: ScoreCommandInput): Promise<AgreementResult> {
  const key = AuditKeySchema.parse(await readJson(input.keyPath));
  const labels = AuditLabelsSchema.parse(await readJson(input.labelsPath));
  const result = scorerAgreement(key, labels, input.scoringContract ?? await currentScoringContract());
  await mkdir(input.outputDirectory, { recursive: true });
  await writeFile(join(input.outputDirectory, "agreement.json"), json(result), "utf8");
  await writeFile(join(input.outputDirectory, "agreement.md"), renderAgreement(result), "utf8");
  return result;
}
