import { rm } from "node:fs/promises";
import { loadDataset } from "../dataset.js";
import { loadExperimentConfig, runExperiment } from "../experiment.js";
import type { RawRun } from "../scoring.js";
import { AGENT_CONFIGURATIONS, resolveSlot, DEFAULT_MODEL_ROLES } from "../config.js";
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
  if (dataset.version === "v1") throw new Error("Mock runs require a dataset with accepted plans (v2 or v3)");
  await rm(input.outputPath, { force: true });
  return runExperiment({
    config,
    adapter: createScriptedModel(dataset.cases, PROFILE_BEHAVIOUR[input.profile], { regressModels: advancedExecutors(config.configurations) }),
    outputPath: input.outputPath,
    policyOverrides: { toolTimeoutMs: 25 },
  });
}

/** Advanced-tier executor models of the configured arms; the regressed profile degrades them on v3. */
function advancedExecutors(configurations: readonly (keyof typeof AGENT_CONFIGURATIONS)[]): ReadonlySet<string> {
  return new Set(configurations.flatMap((id) => {
    const slot = AGENT_CONFIGURATIONS[id].advancedExecutor;
    return slot ? [resolveSlot(slot, DEFAULT_MODEL_ROLES).model] : [];
  }));
}
