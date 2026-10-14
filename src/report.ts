import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatasetCase } from "./dataset.js";
import { containsMockRuns } from "./raw-run.js";
import { computeRunStatistics, statisticsSections, type ReportSection, type RunStatistics } from "./report-statistics.js";
import { aggregateScores, scoreRun, type ConfigurationSummary, type RawRun, type RunScore } from "./scoring.js";

export interface RunManifest {
  commitSha: string;
  datasetHash: string;
  configurationHash: string;
  promptVersion: string;
  resourceVersion: string;
  models: readonly string[];
  repeatCount: number;
  seed: number;
  nodeVersion: string;
  lockfileVersion: string;
  pricingVersion: string;
  pricingEffectiveDate: string;
  startedAt: string;
  completedAt: string;
  rawResultReferences: readonly string[];
}

export interface ReportSummary {
  status: "complete" | "pending";
  reason: string | null;
  manifest: RunManifest;
  /** Row-level aggregates kept for compatibility. Their ci95 fields treat every run as independent. */
  configurations: readonly ConfigurationSummary[];
  /** Case-level statistics. Use these for decisions. */
  statistics: RunStatistics;
}

const percent = (value: number | null): string => value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
const number = (value: number | null, digits = 2): string => value === null ? "N/A" : value.toFixed(digits);
const ci = (metric: { ci95: { low: number; high: number } | null }, format: (value: number) => string = percent): string => metric.ci95 === null ? "N/A" : `${format(metric.ci95.low)} to ${format(metric.ci95.high)}`;
const markdownCell = (value: string): string => value.replaceAll("|", "\\|");
const sectionMarkdown = (section: ReportSection): string => [
  `## ${section.title}`,
  ...section.paragraphs,
  ...section.tables.map((table) => [
    `**${table.caption}**`,
    "",
    `| ${table.head.map(markdownCell).join(" | ")} |`,
    `|${table.head.map(() => "---").join("|")}|`,
    ...table.rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
  ].join("\n")),
].join("\n\n");
const sectionHtml = (section: ReportSection): string => `<h2>${escapeHtml(section.title)}</h2>${section.paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join("")}${section.tables.map((table) => `<table><caption>${escapeHtml(table.caption)}</caption><thead><tr>${table.head.map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`).join("")}</tr></thead><tbody>${table.rows.map((row) => `<tr>${row.map((cell, index) => index === 0 ? `<th scope="row">${escapeHtml(cell)}</th>` : `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`).join("")}`;
export const MOCK_REASON = "Mock data from a scripted model, generated to verify the pipeline. This is not a benchmark result.";
const ROW_LEVEL_NOTE = "Intervals in this section are row-level bootstraps that treat every run as an independent sample. They are kept for continuity and are too narrow when repeats of a case agree. Use the case-clustered intervals below for decisions.";
const escapeHtml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function experimentIsComplete(runs: readonly RawRun[], cases: readonly DatasetCase[], configurations: readonly string[], repeats: number): boolean {
  if (cases.length !== 30 || configurations.length !== 3 || repeats !== 5 || runs.length !== cases.length * configurations.length * repeats) return false;
  const keys = runs.map(({ caseId, configuration, repeat }) => `${caseId}:${configuration}:${repeat}`);
  if (new Set(keys).size !== keys.length || new Set(runs.map(({ runId }) => runId)).size !== runs.length) return false;
  if (runs.some((run) => run.outcome === "failed" || run.outcome === "bounded" || run.policyViolation || run.duplicateMutation)) return false;
  return configurations.every((configuration) => cases.every(({ id }) => {
    const seen = new Set(runs.filter((run) => run.configuration === configuration && run.caseId === id).map(({ repeat }) => repeat));
    return seen.size === repeats && [...seen].every((repeat) => repeat >= 0 && repeat < repeats);
  }));
}

export function buildReport(runs: readonly RawRun[], cases: readonly DatasetCase[], manifest: RunManifest, configurations = ["direct-sonnet", "routed", "no-resource-injection"]): { summary: ReportSummary; scores: readonly RunScore[]; markdown: string; html: string } {
  const byId = new Map(cases.map((item) => [item.id, item]));
  const scores = [...runs].sort((a, b) => a.runId.localeCompare(b.runId)).map((run) => {
    const datasetCase = byId.get(run.caseId);
    if (!datasetCase) throw new Error(`Unknown case ID: ${run.caseId}`);
    return scoreRun(run, datasetCase);
  });
  const complete = experimentIsComplete(runs, cases, configurations, manifest.repeatCount);
  const mock = containsMockRuns([...manifest.models, ...runs.flatMap(({ modelIds }) => modelIds ?? [])]);
  const summary: ReportSummary = {
    status: complete && !mock ? "complete" : "pending",
    reason: mock ? MOCK_REASON : complete ? null : "Pending a complete 30-case, three-configuration, five-repeat experiment.",
    manifest,
    configurations: aggregateScores(scores, manifest.seed),
    statistics: computeRunStatistics(scores, runs, manifest.seed),
  };
  const sections = statisticsSections(summary.statistics);
  const rows = summary.configurations.map((item) => `| ${item.configuration} | ${percent(item.completion.value)} (${item.completion.numerator}/${item.completion.denominator}) | ${percent(item.headlineToolAccuracy.value)} (${item.headlineToolAccuracy.numerator}/${item.headlineToolAccuracy.denominator}) | ${percent(item.recovery.value)} (${item.recovery.numerator}/${item.recovery.denominator}) | $${number(item.costPerSuccessfulTask.value, 4)} | ${number(item.p95LatencyMs.value, 0)} ms |`).join("\n");
  const details = summary.configurations.map((item) => `### ${item.configuration}\n\n- Completion 95% CI: ${ci(item.completion)}\n- Tool selection: ${percent(item.toolSelection.value)} (${item.toolSelection.numerator}/${item.toolSelection.denominator}), 95% CI ${ci(item.toolSelection)}\n- Argument accuracy: ${percent(item.argumentAccuracy.value)} (${item.argumentAccuracy.numerator}/${item.argumentAccuracy.denominator}), 95% CI ${ci(item.argumentAccuracy)}\n- Unsupported claims: ${percent(item.unsupportedClaimRate.value)} (${item.unsupportedClaimRate.numerator}/${item.unsupportedClaimRate.denominator}), 95% CI ${ci(item.unsupportedClaimRate)}\n- Cost per successful task 95% CI: ${ci(item.costPerSuccessfulTask, (value) => `$${value.toFixed(4)}`)}\n- p95 latency 95% CI: ${ci(item.p95LatencyMs, (value) => `${value.toFixed(0)} ms`)}\n- Case results: results.jsonl\n- Run manifest: summary.json`).join("\n\n");
  const markdown = `# AI Reliability Evaluation Lab\n\n**Status: ${summary.status.toUpperCase()}**${summary.reason ? ` - ${summary.reason}` : ""}\n\n| Configuration | Completion | Tool accuracy | Recovery | Cost/task | p95 latency |\n|---|---:|---:|---:|---:|---:|\n${rows || "| No completed runs | N/A | N/A | N/A | N/A | N/A |"}\n\n## Detailed metrics\n\n${details ? `${ROW_LEVEL_NOTE}\n\n${details}` : "No run results are available."}\n${sections.map((section) => `\n${sectionMarkdown(section)}\n`).join("")}`;
  const embedded = escapeHtml(JSON.stringify(summary));
  const htmlRows = summary.configurations.map((item) => `<tr><th scope="row">${escapeHtml(item.configuration)}</th><td>${percent(item.completion.value)} (${item.completion.numerator}/${item.completion.denominator})</td><td>${percent(item.headlineToolAccuracy.value)} (${item.headlineToolAccuracy.numerator}/${item.headlineToolAccuracy.denominator})</td><td>${percent(item.recovery.value)} (${item.recovery.numerator}/${item.recovery.denominator})</td><td>$${number(item.costPerSuccessfulTask.value, 4)}</td><td>${number(item.p95LatencyMs.value, 0)} ms</td></tr>`).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Reliability Evaluation Lab</title><style>body{font:16px system-ui;line-height:1.5;max-width:72rem;margin:auto;padding:2rem;color:#18202a}table{border-collapse:collapse;width:100%;margin:1rem 0}caption{text-align:left;font-weight:600;padding:.4rem 0}th,td{border:1px solid #98a2b3;padding:.6rem;text-align:right}th:first-child{text-align:left}.pending{padding:1rem;border:2px solid #a15c00;background:#fff8e6}code{word-break:break-all}@media(max-width:700px){body{padding:1rem;overflow-x:auto}}</style></head><body><main><h1>AI Reliability Evaluation Lab</h1><p class="${summary.status === "pending" ? "pending" : ""}" role="status"><strong>Status: ${summary.status.toUpperCase()}</strong>${summary.reason ? ` - ${escapeHtml(summary.reason)}` : ""}</p><table><caption>Headline benchmark metrics with scored denominators</caption><thead><tr><th scope="col">Configuration</th><th scope="col">Completion</th><th scope="col">Tool accuracy</th><th scope="col">Recovery</th><th scope="col">Cost/task</th><th scope="col">p95 latency</th></tr></thead><tbody>${htmlRows || '<tr><td colspan="6">No completed runs</td></tr>'}</tbody></table>${sections.map(sectionHtml).join("")}<h2>Reproducibility</h2><p>Dataset hash: <code>${escapeHtml(manifest.datasetHash)}</code>. Commit: <code>${escapeHtml(manifest.commitSha)}</code>. Detailed case results are in <a href="results.jsonl">results.jsonl</a> and the run manifest is in <a href="summary.json">summary.json</a>.</p></main><script type="application/json" id="report-data">${embedded}</script></body></html>`;
  return { summary, scores, markdown, html };
}

export async function writeReport(outputDirectory: string, runs: readonly RawRun[], cases: readonly DatasetCase[], manifest: RunManifest): Promise<ReportSummary> {
  const report = buildReport(runs, cases, manifest);
  await mkdir(outputDirectory, { recursive: true });
  const resultLines = report.scores.map((score) => JSON.stringify(score)).join("\n") + (report.scores.length > 0 ? "\n" : "");
  await Promise.all([
    writeFile(join(outputDirectory, "summary.json"), `${JSON.stringify(report.summary, null, 2)}\n`, "utf8"),
    writeFile(join(outputDirectory, "results.jsonl"), resultLines, "utf8"),
    writeFile(join(outputDirectory, "report.md"), report.markdown, "utf8"),
    writeFile(join(outputDirectory, "index.html"), report.html, "utf8"),
  ]);
  return report.summary;
}

export async function replayReport(rawResultsPath: string, outputDirectory: string, cases: readonly DatasetCase[], manifest: RunManifest): Promise<ReportSummary> {
  const text = await readFile(rawResultsPath, "utf8");
  const runs = text.split(/\r?\n/u).filter((line) => line.trim().length > 0).map((line, index) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch (error) { throw new Error(`Invalid raw result JSON on line ${index + 1}`, { cause: error }); }
    if (value === null || typeof value !== "object" || typeof (value as { runId?: unknown }).runId !== "string") throw new Error(`Invalid raw result on line ${index + 1}`);
    return value as RawRun;
  });
  return writeReport(outputDirectory, runs, cases, { ...manifest, rawResultReferences: [rawResultsPath] });
}
