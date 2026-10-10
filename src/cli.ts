#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import * as prompts from "@clack/prompts";
import { z } from "zod";
import { AnthropicAdapter } from "./adapter.js";
import { CliPathSchema, parseCliArguments, validateRunArtifactTargets, type CliArguments } from "./cli-options.js";
import {
  createInteractiveArtifactPaths,
  createProgressRenderer,
  isCiEnvironment,
  isNoColorEnvironment,
  reserveInteractiveArtifactPaths,
  resolveProgressMode,
} from "./cli-ui.js";
import { loadDataset } from "./dataset.js";
import { loadExperimentConfig, planExperiment, runExperiment } from "./experiment.js";
import {
  GuidedRunCancelledError,
  GuidedRunDeclinedError,
  resolveGuidedRun,
  type GuidedPromptPort,
} from "./guided-run.js";
import { loadPricingConfig } from "./pricing.js";
import { generateReport } from "./report-command.js";
import { createRunSignalController } from "./run-signal.js";
import { CompositeTelemetrySink, JsonlTelemetrySink, createLangfuseTelemetry } from "./telemetry.js";

const ApiKeySchema = z.string().min(1, "ANTHROPIC_API_KEY is required for live execution");

export async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseCliArguments(argv);
  if (parsed.command === "validate-dataset") {
    const bundle = await loadDataset(parsed.manifestPath ?? "datasets/v2/manifest.json");
    process.stdout.write(`Validated ${bundle.cases.length} cases (${bundle.hash})\n`);
    return;
  }
  if (parsed.command === "validate-config") {
    const path = parsed.configPath ?? "config/full.v2.json";
    const config = await loadExperimentConfig(path);
    await loadPricingConfig(config.pricing);
    process.stdout.write(`Validated ${path}\n`);
    return;
  }
  if (parsed.command === "run") {
    await runLiveExperiment(parsed);
    return;
  }
  await report(parsed);
}

async function runLiveExperiment(options: Extract<CliArguments, { command: "run" }>): Promise<void> {
  const guided = options.interactive ? await guidedOptions(options) : null;
  const configPath = guided?.configPath ?? options.configPath ?? "config/full.v2.json";
  const outputPath = guided?.outputPath ?? options.outputPath ?? "runs/results.jsonl";
  const eventsPath = guided?.eventsPath ?? options.eventsPath ?? "runs/events.jsonl";
  await validateRunArtifactTargets(outputPath, eventsPath);
  const config = guided?.config ?? await loadExperimentConfig(configPath);
  const pricing = await loadPricingConfig(config.pricing);
  const apiKeyResult = ApiKeySchema.safeParse(process.env.ANTHROPIC_API_KEY);
  if (!apiKeyResult.success) throw new Error("ANTHROPIC_API_KEY is required for live execution");
  const apiKey = apiKeyResult.data;
  if (options.interactive) {
    await reserveInteractiveArtifactPaths({ resultsPath: outputPath, eventsPath });
  }
  const telemetry = new CompositeTelemetrySink([
    new JsonlTelemetrySink(eventsPath),
    await createLangfuseTelemetry(),
  ]);
  const anthropic = new Anthropic({ apiKey });
  const resolvedMode = resolveProgressMode({
    requested: options.progress,
    isTTY: Boolean(process.stderr.isTTY),
    isCI: isCiEnvironment(process.env),
    noColor: isNoColorEnvironment(process.env),
  });
  const renderer = createProgressRenderer({
    mode: resolvedMode,
    output: process.stderr,
    artifacts: { resultsPath: outputPath, eventsPath },
  });
  const runSignal = createRunSignalController((code) => process.exit(code));
  const handleInterrupt = (): void => runSignal.handleInterrupt();
  process.on("SIGINT", handleInterrupt);
  try {
    await runExperiment({
      config,
      adapter: new AnthropicAdapter({
        messages: {
          create: (request, requestOptions) => anthropic.messages.create(request as never, requestOptions),
        },
      }, pricing.perMillionTokens),
      outputPath,
      telemetry,
      signal: runSignal.signal,
      onProgress: renderer.onEvent,
    });
  } catch (error) {
    if (runSignal.signal.aborted) {
      process.exitCode = 130;
      return;
    }
    throw error;
  } finally {
    process.off("SIGINT", handleInterrupt);
  }
}

async function guidedOptions(options: Extract<CliArguments, { command: "run" }>) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("Interactive mode requires an interactive terminal");
  }
  const prompt = createGuidedPromptPort();
  prompts.intro("AI Reliability Evaluation Lab", { output: process.stderr });
  try {
    const guided = await resolveGuidedRun({
      isTTY: true,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.outputPath === undefined ? {} : { outputPath: options.outputPath }),
      ...(options.eventsPath === undefined ? {} : { eventsPath: options.eventsPath }),
      prompt,
      loadConfig: loadExperimentConfig,
      planExperiment,
      createArtifactPaths: () => createInteractiveArtifactPaths(),
    });
    prompts.outro("Preflight approved. Starting evaluation.", { output: process.stderr });
    return guided;
  } catch (error) {
    if (error instanceof GuidedRunDeclinedError || error instanceof GuidedRunCancelledError) {
      prompts.cancel(error.message, { output: process.stderr });
    }
    throw error;
  }
}

function createGuidedPromptPort(): GuidedPromptPort {
  const io = { input: process.stdin, output: process.stderr } as const;
  return {
    chooseConfiguration: () => prompts.select({
      ...io,
      message: "Choose an experiment configuration",
      initialValue: "smoke-v2" as const,
      options: [
        { value: "smoke-v2" as const, label: "Smoke v2", hint: "24 jobs, recommended first run" },
        { value: "full-v2" as const, label: "Full v2", hint: "450 jobs" },
        { value: "custom" as const, label: "Custom configuration" },
      ],
    }),
    requestCustomConfigPath: async () => {
      const value = await prompts.text({
        ...io,
        message: "Configuration file",
        placeholder: "config/custom.json",
        validate: (candidate) => {
          const result = CliPathSchema.safeParse(candidate);
          return result.success ? undefined : result.error.issues[0]?.message ?? "Enter a configuration path";
        },
      });
      return typeof value === "symbol" ? value : CliPathSchema.parse(value);
    },
    showPreflight: (summary) => prompts.note(summary, "Run preflight", { output: process.stderr }),
    confirmRun: () => prompts.confirm({
      ...io,
      message: "Start this paid Anthropic evaluation?",
      initialValue: false,
    }),
  };
}

async function report(options: Extract<CliArguments, { command: "report" }>): Promise<void> {
  await generateReport({
    rawPath: options.rawPath ?? "runs/results.jsonl",
    outputDirectory: options.outputPath ?? "reports/generated",
    configPath: options.configPath ?? "config/full.v2.json",
    ...(options.eventsPath === undefined ? {} : { eventsPath: options.eventsPath }),
  });
}

async function runEntrypoint(): Promise<void> {
  await main(process.argv.slice(2));
}

function handleCliError(error: unknown): void {
  if (error instanceof GuidedRunDeclinedError) return;
  if (error instanceof GuidedRunCancelledError) {
    process.exitCode = error.exitCode;
    return;
  }
  const message = error instanceof z.ZodError
    ? `Invalid CLI arguments: ${error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ")}`
    : error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

const entrypoint = process.argv[1];
if (entrypoint && realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url))) {
  runEntrypoint().catch(handleCliError);
}
