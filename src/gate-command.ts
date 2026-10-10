import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AuditLog } from "./audit/log.js";
import { loadDataset, sha256 } from "./dataset.js";
import { loadExperimentConfig } from "./experiment.js";
import { evaluateGate } from "./gate/decision.js";
import { renderGateMarkdown, type GateReport } from "./gate/render.js";
import { loadThresholds } from "./gate/thresholds.js";
import { containsMockRuns, parseRawRuns } from "./raw-run.js";
import { createSyntheticTools } from "./tools.js";

export interface GateCommandInput {
  readonly rawPath: string;
  readonly configPath: string;
  readonly thresholdsPath: string;
  /** Configuration under evaluation. */
  readonly candidate: string;
  /** Configuration to compare against. Defaults to the candidate's name when a baseline file is given. */
  readonly reference?: string;
  /** Raw JSONL of an earlier accepted run. When set, the reference arm is read from this file. */
  readonly baselinePath?: string;
  readonly outputDirectory?: string;
  /** Append-only audit log that receives one entry per gate decision. */
  readonly auditLogPath?: string;
  readonly now?: () => Date;
}

export const DEFAULT_GATE_CANDIDATE = "routed";
export const DEFAULT_GATE_REFERENCE = "direct-sonnet";

/** Reads raw JSONL, applies the versioned thresholds, and optionally writes gate.json and gate.md. */
export async function runGate(input: GateCommandInput): Promise<{ report: GateReport; markdown: string }> {
  const { thresholds, text: thresholdsText } = await loadThresholds(input.thresholdsPath);
  const configText = await readFile(input.configPath, "utf8");
  const config = await loadExperimentConfig(input.configPath);
  const dataset = await loadDataset(`${config.dataset}/manifest.json`);
  const rawText = await readFile(input.rawPath, "utf8");
  const raw = parseRawRuns(rawText);
  const baselineText = input.baselinePath === undefined ? null : await readFile(input.baselinePath, "utf8");
  const baseline = baselineText === null ? null : parseRawRuns(baselineText);
  const referenceConfiguration = input.reference ?? (baseline ? input.candidate : DEFAULT_GATE_REFERENCE);
  if (!baseline && referenceConfiguration === input.candidate) throw new Error("Candidate and reference must differ unless a baseline file is given");

  const result = evaluateGate({
    thresholds,
    cases: dataset.cases,
    expectedRepeats: config.repeats,
    writeTools: new Set(createSyntheticTools().filter(({ sideEffect }) => sideEffect === "simulated-write").map(({ name }) => name)),
    candidate: { source: input.rawPath, configuration: input.candidate, runs: raw.runs, invalidRows: raw.issues.length },
    reference: baseline
      ? { source: input.baselinePath!, configuration: referenceConfiguration, runs: baseline.runs, invalidRows: baseline.issues.length }
      : { source: input.rawPath, configuration: referenceConfiguration, runs: raw.runs, invalidRows: raw.issues.length },
    datasetIntegrityVerified: true,
  });
  const modelIds = [...raw.runs, ...(baseline?.runs ?? [])].flatMap((run) => run.modelIds ?? []);
  const report: GateReport = {
    ...result,
    dataSource: containsMockRuns(modelIds) ? "mock" : "provider",
    inputs: {
      raw: { path: input.rawPath, sha256: sha256(rawText) },
      baseline: baselineText === null ? null : { path: input.baselinePath!, sha256: sha256(baselineText) },
      dataset: { version: dataset.version, sha256: dataset.hash },
      thresholds: { path: input.thresholdsPath, sha256: sha256(thresholdsText) },
      config: { path: input.configPath, sha256: sha256(configText) },
    },
  };
  const markdown = renderGateMarkdown(report);
  if (input.outputDirectory !== undefined) {
    await mkdir(input.outputDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(input.outputDirectory, "gate.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
      writeFile(join(input.outputDirectory, "gate.md"), markdown, "utf8"),
    ]);
  }
  if (input.auditLogPath !== undefined) {
    await new AuditLog(input.auditLogPath, input.now).append({
      eventType: "gate_decision",
      ruleVersion: report.thresholdsVersion,
      dataHashes: {
        raw: report.inputs.raw.sha256,
        dataset: report.inputs.dataset.sha256,
        thresholds: report.inputs.thresholds.sha256,
        config: report.inputs.config.sha256,
        ...(report.inputs.baseline ? { baseline: report.inputs.baseline.sha256 } : {}),
      },
      details: {
        decision: report.decision,
        exitCode: report.exitCode,
        candidate: report.candidate.configuration,
        reference: report.reference.configuration,
        severityRulesVersion: report.severityRulesVersion,
        dataSource: report.dataSource,
        reasons: report.reasons,
      },
    });
  }
  return { report, markdown };
}
