import type { GateResult } from "./decision.js";

export interface GateInputs {
  readonly raw: { readonly path: string; readonly sha256: string };
  readonly baseline: { readonly path: string; readonly sha256: string } | null;
  readonly dataset: { readonly version: string; readonly sha256: string };
  readonly thresholds: { readonly path: string; readonly sha256: string };
  readonly config: { readonly path: string; readonly sha256: string };
}

export interface GateReport extends GateResult {
  /** "mock" when any row came from the scripted mock model. A mock gate result says nothing about a real model. */
  readonly dataSource: "mock" | "provider";
  readonly inputs: GateInputs;
}

const percent = (value: number | null): string => value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
const points = (value: number | null): string => value === null ? "N/A" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pts`;

export function renderGateMarkdown(report: GateReport): string {
  const lines = [
    "# Go-live gate",
    "",
    `**Decision: ${report.decision}** (exit code ${report.exitCode})`,
    "",
    ...(report.dataSource === "mock" ? ["> Mock data from a scripted model. This verifies the pipeline and says nothing about a real model.", ""] : []),
    `- Candidate: ${report.candidate.configuration} from ${report.candidate.source} (${report.candidate.cases} cases, ${report.candidate.runs} runs)`,
    `- Reference: ${report.reference.configuration} from ${report.reference.source} (${report.reference.cases} cases, ${report.reference.runs} runs)`,
    `- Thresholds: ${report.thresholdsVersion} dated ${report.thresholdsDate}; severity rules ${report.severityRulesVersion}; confidence ${percent(report.confidence)}`,
    "",
    "## Reasons",
    "",
    ...(report.reasons.length > 0 ? report.reasons.map((reason) => `- ${reason}`) : ["- Every check passed and every interval cleared its margin."]),
    ...(report.recommendation ? ["", `**Recommendation:** ${report.recommendation}`] : []),
    ...(report.warnings.length > 0 ? ["", "## Warnings", "", ...report.warnings.map((warning) => `- ${warning}`)] : []),
    "",
    "## Deterministic checks (all must pass)",
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
    ...report.checks.map(({ id, passed, detail }) => `| ${id} | ${passed ? "pass" : "FAIL"} | ${detail} |`),
    "",
    "## Critical errors (unit: case)",
    "",
    `${report.critical.casesWithCriticalError} of ${report.critical.cases} cases had at least one critical error in any repeat (${report.critical.runsWithCriticalError} runs). One-sided upper bound ${percent(report.critical.upperBound)} against a limit of ${percent(report.critical.limit)}: ${report.critical.status}.`,
    "",
    "| Type | Runs |",
    "|---|---:|",
    ...Object.entries(report.critical.byType).map(([type, count]) => `| ${type} | ${count} |`),
    ...(report.critical.affectedCases.length > 0 ? ["", `Affected cases: ${report.critical.affectedCases.join(", ")}`] : []),
    "",
    "## Non-inferiority (candidate minus reference, paired by case)",
    "",
    "| Metric | Cases | Difference | Interval | Margin | Result |",
    "|---|---:|---:|---:|---:|---|",
    ...report.comparisons.map((item) => `| ${item.metric} | ${item.cases} | ${points(item.difference)} | ${item.interval === null ? "N/A" : `${points(item.interval.low)} to ${points(item.interval.high)}`} | ${points(-item.margin)} | ${item.status}: ${item.detail} |`),
    "",
    `Minimum cases: ${report.minimumCases.observed} observed, ${report.minimumCases.required} required: ${report.minimumCases.status}.`,
    "",
    "## Inputs",
    "",
    `- Raw runs: ${report.inputs.raw.path} (sha256 ${report.inputs.raw.sha256})`,
    ...(report.inputs.baseline ? [`- Baseline runs: ${report.inputs.baseline.path} (sha256 ${report.inputs.baseline.sha256})`] : []),
    `- Dataset: ${report.inputs.dataset.version} (sha256 ${report.inputs.dataset.sha256})`,
    `- Thresholds: ${report.inputs.thresholds.path} (sha256 ${report.inputs.thresholds.sha256})`,
    `- Experiment config: ${report.inputs.config.path} (sha256 ${report.inputs.config.sha256})`,
    "",
  ];
  return lines.join("\n");
}
