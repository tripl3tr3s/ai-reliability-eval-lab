#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicAdapter } from "./adapter.js";
import { loadDataset } from "./dataset.js";
import { loadExperimentConfig, runExperiment } from "./experiment.js";
import { writeReport, type RunManifest } from "./report.js";
import type { RawRun } from "./scoring.js";
import { CompositeTelemetrySink, JsonlTelemetrySink, createLangfuseTelemetry } from "./telemetry.js";
import { loadPricingConfig } from "./pricing.js";

const [command, ...arguments_] = process.argv.slice(2);

function option(name: string, fallback?: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index < 0 ? fallback : arguments_[index + 1];
}

async function main(): Promise<void> {
  if (command === "validate-dataset") {
    const bundle = await loadDataset(option("--manifest", "datasets/v2/manifest.json"));
    process.stdout.write(`Validated ${bundle.cases.length} cases (${bundle.hash})\n`);
    return;
  }
  if (command === "validate-config") {
    const path = option("--config", "config/full.v2.json");
    if (!path) throw new Error("Missing config path");
    const config = await loadExperimentConfig(path);
    await loadPricingConfig(config.pricing);
    process.stdout.write(`Validated ${path}\n`);
    return;
  }
  if (command === "run") {
    const path = option("--config", "config/full.v2.json");
    const outputPath = option("--output", "runs/results.jsonl");
    if (!path || !outputPath) throw new Error("Missing run path");
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required for live execution");
    const config = await loadExperimentConfig(path);
    const pricing = await loadPricingConfig(config.pricing);
    const telemetry = new CompositeTelemetrySink([
      new JsonlTelemetrySink("runs/events.jsonl"),
      await createLangfuseTelemetry(),
    ]);
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    await runExperiment({
      config,
      adapter: new AnthropicAdapter({
        messages: {
          create: (request, options) => anthropic.messages.create(request as never, options),
        },
      }, pricing.perMillionTokens),
      outputPath,
      telemetry,
    });
    return;
  }
  if (command === "report") {
    const rawPath = option("--raw", "runs/results.jsonl");
    const outputDirectory = option("--output", "reports/generated");
    const configPath = option("--config", "config/full.v2.json");
    if (!rawPath || !outputDirectory || !configPath) throw new Error("Missing report path");
    const config = await loadExperimentConfig(configPath);
    const dataset = await loadDataset(`${config.dataset}/manifest.json`);
    const rawText = await readFile(rawPath, "utf8");
    const runs = rawText.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as RawRun);
    const pricing = await loadPricingConfig(config.pricing);
    const manifest: RunManifest = {
      commitSha: process.env.GITHUB_SHA ?? "local",
      datasetHash: dataset.hash,
      configurationHash: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
      promptVersion: config.promptVersion,
      resourceVersion: config.resourceVersion,
      models: [...new Set(runs.flatMap(({ modelIds }) => modelIds ?? []))],
      repeatCount: config.repeats,
      seed: config.seed,
      nodeVersion: process.version,
      lockfileVersion: "pnpm-lock.yaml",
      pricingVersion: pricing.version,
      pricingEffectiveDate: pricing.effectiveDate,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      rawResultReferences: [rawPath],
    };
    await writeReport(outputDirectory, runs, dataset.cases, manifest);
    return;
  }
  throw new Error("Usage: reliability-lab <validate-dataset|validate-config|run|report>");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
