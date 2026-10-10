import { rm } from "node:fs/promises";
import { loadDataset } from "../dataset.js";
import { loadExperimentConfig, runExperiment } from "../experiment.js";
import type { RawRun } from "../scoring.js";
import { createScriptedModel, PROFILE_BEHAVIOUR, type ScriptedProfile } from "./scripted-model.js";

export interface MockRunInput {
  readonly configPath: string;
  readonly outputPath: string;
  readonly profile: ScriptedProfile;
}

/**
 * Runs the full experiment loop (planner, runner, tools, fault injection, persistence) against the
 * scripted model. No credentials, no network, no spend. Any previous file at the output path is replaced.
 */
export async function runMockExperiment(input: MockRunInput): Promise<readonly RawRun[]> {
  const config = await loadExperimentConfig(input.configPath);
  const dataset = await loadDataset(`${config.dataset}/manifest.json`);
  if (dataset.version !== "v2") throw new Error("Mock runs require a v2 dataset with accepted plans");
  await rm(input.outputPath, { force: true });
  return runExperiment({
    config,
    adapter: createScriptedModel(dataset.cases, PROFILE_BEHAVIOUR[input.profile]),
    outputPath: input.outputPath,
    policyOverrides: { toolTimeoutMs: 25 },
  });
}
