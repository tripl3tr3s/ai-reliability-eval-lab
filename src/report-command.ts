import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadDataset } from "./dataset.js";
import { loadExperimentConfig } from "./experiment.js";
import { loadPricingConfig } from "./pricing.js";
import { readRawRuns } from "./raw-run.js";
import { writeReport, type ReportSummary, type RunManifest } from "./report.js";

export const UNKNOWN_TIMESTAMP = "unknown";

/**
 * Run start and end taken from the telemetry events of the run itself.
 * The wall clock is never used, so replaying the same inputs yields the same report bytes.
 */
export function runTimestamps(eventsText: string | undefined): { startedAt: string; completedAt: string } {
  const times = (eventsText ?? "").split(/\r?\n/u).flatMap((line) => {
    if (line.trim().length === 0) return [];
    try {
      const at = (JSON.parse(line) as { at?: unknown }).at;
      return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? [at] : [];
    } catch {
      return [];
    }
  }).sort();
  return { startedAt: times[0] ?? UNKNOWN_TIMESTAMP, completedAt: times.at(-1) ?? UNKNOWN_TIMESTAMP };
}

export interface GenerateReportInput {
  readonly rawPath: string;
  readonly outputDirectory: string;
  readonly configPath: string;
  readonly eventsPath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly nodeVersion?: string;
}

export async function generateReport(input: GenerateReportInput): Promise<ReportSummary> {
  const config = await loadExperimentConfig(input.configPath);
  const dataset = await loadDataset(`${config.dataset}/manifest.json`);
  const runs = readRawRuns(await readFile(input.rawPath, "utf8"));
  const pricing = await loadPricingConfig(config.pricing);
  const eventsText = input.eventsPath === undefined ? undefined : await readFile(input.eventsPath, "utf8");
  const manifest: RunManifest = {
    commitSha: (input.environment ?? process.env).GITHUB_SHA ?? "local",
    datasetHash: dataset.hash,
    configurationHash: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    promptVersion: config.promptVersion,
    resourceVersion: config.resourceVersion,
    models: [...new Set(runs.flatMap(({ modelIds }) => modelIds ?? []))],
    repeatCount: config.repeats,
    seed: config.seed,
    nodeVersion: input.nodeVersion ?? process.version,
    lockfileVersion: "pnpm-lock.yaml",
    pricingVersion: pricing.version,
    pricingEffectiveDate: pricing.effectiveDate,
    ...runTimestamps(eventsText),
    rawResultReferences: [input.rawPath],
  };
  return writeReport(input.outputDirectory, runs, dataset.cases, manifest);
}
