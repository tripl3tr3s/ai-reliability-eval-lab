import { access } from "node:fs/promises";
import { validateRunArtifactPaths } from "./cli-options.js";
import type { ExperimentFile, ExperimentPlan } from "./experiment.js";

export type GuidedConfigurationChoice = "smoke-v2" | "full-v2" | "custom";

export interface GuidedPromptPort {
  chooseConfiguration(): Promise<GuidedConfigurationChoice | symbol>;
  requestCustomConfigPath(): Promise<string | symbol>;
  showPreflight(summary: string): void;
  confirmRun(): Promise<boolean | symbol>;
}

export interface GuidedRunResolution {
  readonly configPath: string;
  readonly outputPath: string;
  readonly eventsPath: string;
  readonly config: ExperimentFile;
  readonly plan: ExperimentPlan;
}

export class GuidedRunCancelledError extends Error {
  readonly exitCode = 130;

  constructor() {
    super("Interactive setup cancelled");
    this.name = "GuidedRunCancelledError";
  }
}

export class GuidedRunDeclinedError extends Error {
  readonly exitCode = 0;

  constructor() {
    super("Run cancelled before execution");
    this.name = "GuidedRunDeclinedError";
  }
}

export async function resolveGuidedRun(input: {
  readonly isTTY: boolean;
  readonly configPath?: string;
  readonly outputPath?: string;
  readonly eventsPath?: string;
  readonly prompt: GuidedPromptPort;
  readonly loadConfig: (path: string) => Promise<ExperimentFile>;
  readonly planExperiment: (config: ExperimentFile) => Promise<ExperimentPlan>;
  readonly createArtifactPaths: () => Promise<{ readonly resultsPath: string; readonly eventsPath: string }>;
  readonly artifactExists?: (path: string) => Promise<boolean>;
}): Promise<GuidedRunResolution> {
  if (!input.isTTY) throw new Error("Interactive mode requires an interactive terminal");
  const configPath = input.configPath ?? await chooseConfigPath(input.prompt);
  const config = await input.loadConfig(configPath);
  const plan = await input.planExperiment(config);
  const generated = input.outputPath !== undefined && input.eventsPath !== undefined
    ? null
    : await input.createArtifactPaths();
  const outputPath = input.outputPath ?? generated?.resultsPath;
  const eventsPath = input.eventsPath ?? generated?.eventsPath;
  if (!outputPath || !eventsPath) throw new Error("Unable to resolve interactive artifact paths");
  validateRunArtifactPaths(outputPath, eventsPath);
  const artifactExists = input.artifactExists ?? pathExists;
  const existing = (await Promise.all([outputPath, eventsPath].map(async (path) => ({
    path,
    exists: await artifactExists(path),
  })))).find(({ exists }) => exists);
  if (existing) throw new Error(`Interactive artifact already exists: ${existing.path}`);
  input.prompt.showPreflight(formatPreflight(config, plan, outputPath, eventsPath));
  const confirmed = await input.prompt.confirmRun();
  if (typeof confirmed === "symbol") throw new GuidedRunCancelledError();
  if (!confirmed) throw new GuidedRunDeclinedError();
  return { configPath, outputPath, eventsPath, config, plan };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function chooseConfigPath(prompt: GuidedPromptPort): Promise<string> {
  const choice = await prompt.chooseConfiguration();
  if (typeof choice === "symbol") throw new GuidedRunCancelledError();
  if (choice === "smoke-v2") return "config/smoke.v2.json";
  if (choice === "full-v2") return "config/full.v2.json";
  const custom = await prompt.requestCustomConfigPath();
  if (typeof custom === "symbol") throw new GuidedRunCancelledError();
  return custom;
}

function formatPreflight(
  config: ExperimentFile,
  plan: ExperimentPlan,
  outputPath: string,
  eventsPath: string,
): string {
  return [
    `Configurations: ${config.configurations.join(", ")}`,
    `Repeats: ${config.repeats}`,
    `Jobs: ${plan.totalJobs}`,
    `Estimated spend: $${plan.estimatedCostUsd.toFixed(2)}`,
    `Budget ceiling: $${plan.budgetCeilingUsd.toFixed(2)}`,
    `Results: ${outputPath}`,
    `Events: ${eventsPath}`,
  ].join("\n");
}
