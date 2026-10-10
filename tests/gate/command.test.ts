import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { loadDataset } from "../../src/dataset.js";
import { runGate } from "../../src/gate-command.js";
import { runMockExperiment } from "../../src/mock/run.js";
import { createScriptedModel, SCRIPTED_MODEL_ID } from "../../src/mock/scripted-model.js";
import { generateReport } from "../../src/report-command.js";
import { MOCK_REASON } from "../../src/report.js";
import { scoreRun } from "../../src/scoring.js";

const CONFIG = "config/full.v2.json";
const THRESHOLDS = "config/thresholds.v1.json";
const dataset = await loadDataset("datasets/v2/manifest.json");
let root: string;
let clean: string;
let regressed: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "eval-gate-"));
  clean = join(root, "clean.jsonl");
  regressed = join(root, "regressed.jsonl");
  await runMockExperiment({ configPath: CONFIG, outputPath: clean, profile: "clean" });
  await runMockExperiment({ configPath: CONFIG, outputPath: regressed, profile: "regressed" });
}, 60_000);

const cli = async (...args: string[]): Promise<{ code: number; stdout: string }> => {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli.ts", ...args]);
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "" };
  }
};

describe("scripted mock run", () => {
  it("drives the real runner, tools, and fault schedule to a fully passing run", async () => {
    const runs = (await readFile(clean, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Parameters<typeof scoreRun>[0]);
    const byId = new Map(dataset.cases.map((item) => [item.id, item]));
    const scores = runs.map((run) => scoreRun(run, byId.get(run.caseId)!));
    expect(runs).toHaveLength(450);
    expect(scores.every(({ completionPassed, headlineToolAccuracy, recoveryPassed }) => completionPassed && headlineToolAccuracy !== false && recoveryPassed !== false)).toBe(true);
    expect(new Set(runs.flatMap(({ modelIds }) => modelIds ?? []))).toEqual(new Set([SCRIPTED_MODEL_ID]));
    expect(runs.every(({ costUsd, tokens }) => costUsd === 0 && typeof tokens === "number" && tokens > 0)).toBe(true);
  });

  it("replaces an earlier output file and rejects prompts outside the dataset", async () => {
    const path = join(root, "twice.jsonl");
    await writeFile(path, "stale\n");
    await runMockExperiment({ configPath: "config/smoke.v2.json", outputPath: path, profile: "clean" });
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(24);
    const model = createScriptedModel(dataset.cases);
    const request = { model: "any", maxOutputTokens: 10, signal: new AbortController().signal, tools: [{ name: "get_document", description: "", inputSchema: {} }] };
    await expect(model.generate({ ...request, messages: [{ role: "user", content: "Not a dataset prompt." }] })).rejects.toThrow(/not in the dataset/u);
    await expect(runMockExperiment({ configPath: "config/smoke.v1.json", outputPath: path, profile: "clean" })).rejects.toThrow(/v2 dataset/u);
  });
});

describe("gate command", () => {
  it("passes a clean mock run, labels it as mock, and writes both summaries", async () => {
    const output = join(root, "gate-clean");
    const { report, markdown } = await runGate({ rawPath: clean, configPath: CONFIG, thresholdsPath: THRESHOLDS, candidate: "routed", outputDirectory: output });
    expect(report).toMatchObject({ decision: "PASS", exitCode: 0, dataSource: "mock", reference: { configuration: "direct-sonnet" } });
    expect(report.inputs.dataset.sha256).toBe(dataset.hash);
    expect(report.inputs.raw.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.inputs.baseline).toBeNull();
    expect(JSON.parse(await readFile(join(output, "gate.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(report)));
    expect(await readFile(join(output, "gate.md"), "utf8")).toBe(markdown);
    expect(markdown).toContain("**Decision: PASS** (exit code 0)");
    expect(markdown).toContain("Mock data from a scripted model");
    expect(markdown).not.toContain("—");
  });

  it("blocks the regressed arm on both critical errors and non-inferiority", async () => {
    const { report, markdown } = await runGate({ rawPath: regressed, configPath: CONFIG, thresholdsPath: THRESHOLDS, candidate: "no-resource-injection", reference: "routed" });
    expect(report).toMatchObject({ decision: "BLOCK", exitCode: 1 });
    expect(report.critical).toMatchObject({ casesWithCriticalError: 5, status: "BLOCK", byType: { unauthorized_write: 25 } });
    expect(report.comparisons.find(({ metric }) => metric === "completion")).toMatchObject({ status: "BLOCK" });
    expect(markdown).toContain("Affected cases: v2-multi-followup-14");
    expect(markdown).toContain("## Reasons\n\n- BLOCK:");
  });

  it("compares a candidate file against a baseline file for the same configuration", async () => {
    const blocked = await runGate({ rawPath: regressed, baselinePath: clean, configPath: CONFIG, thresholdsPath: THRESHOLDS, candidate: "no-resource-injection" });
    expect(blocked.report).toMatchObject({ decision: "BLOCK", reference: { configuration: "no-resource-injection", source: clean }, candidate: { source: regressed } });
    expect(blocked.report.inputs.baseline).toMatchObject({ path: clean });
    expect(blocked.markdown).toContain("- Baseline runs:");
    const same = await runGate({ rawPath: clean, baselinePath: clean, configPath: CONFIG, thresholdsPath: THRESHOLDS, candidate: "routed" });
    expect(same.report.decision).toBe("PASS");
  });

  it("is deterministic for the same inputs", async () => {
    const input = { rawPath: regressed, configPath: CONFIG, thresholdsPath: THRESHOLDS, candidate: "no-resource-injection", reference: "direct-sonnet" };
    expect(JSON.stringify((await runGate(input)).report)).toBe(JSON.stringify((await runGate(input)).report));
  });

  it("blocks on malformed rows and refuses to compare an arm with itself", async () => {
    const broken = join(root, "broken.jsonl");
    await writeFile(broken, `${await readFile(clean, "utf8")}{"runId":"bad"}\n`);
    const { report } = await runGate({ rawPath: broken, configPath: CONFIG, thresholdsPath: THRESHOLDS, candidate: "routed" });
    expect(report.decision).toBe("BLOCK");
    expect(report.checks.find(({ id }) => id === "raw_rows_valid")).toMatchObject({ passed: false });
    await expect(runGate({ rawPath: clean, configPath: CONFIG, thresholdsPath: THRESHOLDS, candidate: "routed", reference: "routed" })).rejects.toThrow(/must differ/u);
  });

  it("keeps a mock report pending so it can never be published as a result", async () => {
    const summary = await generateReport({ rawPath: clean, configPath: CONFIG, outputDirectory: join(root, "report") });
    expect(summary).toMatchObject({ status: "pending", reason: MOCK_REASON });
    expect(await readFile(join(root, "report", "report.md"), "utf8")).toContain("**Status: PENDING** - Mock data from a scripted model");
  });
});

describe("gate exit codes as CI sees them", () => {
  it("exits 0 on a clean run, 1 on the synthetic regression, and 2 when the sample is too small", async () => {
    const pass = await cli("gate", "--raw", clean, "--output", join(root, "cli-pass"));
    expect(pass).toMatchObject({ code: 0 });
    expect(pass.stdout).toContain("Gate PASS (mock data): routed vs direct-sonnet");

    const block = await cli("gate", "--raw", regressed, "--candidate", "no-resource-injection", "--reference", "routed", "--output", join(root, "cli-block"));
    expect(block).toMatchObject({ code: 1 });
    expect(block.stdout).toContain("Gate BLOCK");
    expect(block.stdout).toContain("BLOCK: 5 of 30 cases had a critical error");
    expect(JSON.parse(await readFile(join(root, "cli-block", "gate.json"), "utf8"))).toMatchObject({ decision: "BLOCK", exitCode: 1 });

    const smoke = join(root, "smoke.jsonl");
    expect(await cli("mock-run", "--config", "config/smoke.v2.json", "--output", smoke)).toMatchObject({ code: 0 });
    const inconclusive = await cli("gate", "--raw", smoke, "--config", "config/smoke.v2.json", "--output", join(root, "cli-smoke"));
    expect(inconclusive).toMatchObject({ code: 2 });
    expect(inconclusive.stdout).toContain("Collect more cases");
  }, 60_000);

  it("fails closed with exit 1 when the thresholds file is invalid", async () => {
    const bad = join(root, "thresholds.json");
    await writeFile(bad, JSON.stringify({ version: "thresholds-v1" }));
    expect(await cli("gate", "--raw", clean, "--thresholds", bad)).toMatchObject({ code: 1 });
  }, 30_000);
});
