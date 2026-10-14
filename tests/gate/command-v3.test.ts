import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ANTHROPIC_MODELS } from "../../src/adapter.js";
import { gateDefaultsFor, runGate } from "../../src/gate-command.js";
import { runMockExperiment } from "../../src/mock/run.js";
import { readRawRuns } from "../../src/raw-run.js";

const CONFIG = "config/full.v3.json";
let clean: string;
let regressed: string;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "gate-v3-"));
  clean = join(root, "clean.jsonl");
  regressed = join(root, "regressed.jsonl");
  await runMockExperiment({ configPath: CONFIG, outputPath: clean, profile: "clean" });
  await runMockExperiment({ configPath: CONFIG, outputPath: regressed, profile: "regressed" });
}, 120_000);

describe("v3 go-live gate on the scripted model", () => {
  it("defaults to thresholds-v2 and the production-mirror arms for dataset v3", async () => {
    expect(await gateDefaultsFor(CONFIG)).toEqual({ thresholdsPath: "config/thresholds.v2.json", candidate: "prod-routed-5-5", reference: "direct-sonnet-5-5" });
    expect(await gateDefaultsFor("config/full.v2.json")).toMatchObject({ thresholdsPath: "config/thresholds.v1.json", candidate: "routed" });
  });

  it("routes advanced domains to the Opus 5.5 tier in the production-mirror arm", async () => {
    const runs = readRawRuns(await readFile(clean, "utf8")).filter(({ configuration }) => configuration === "prod-routed-5-5");
    expect(runs.every(({ tier, routedDomain }) => (routedDomain === "pagos" || routedDomain === "cumplimiento") === (tier === "advanced"))).toBe(true);
    expect(runs.some(({ tier }) => tier === "advanced")).toBe(true);
  });

  it("passes the clean profile with every deterministic check green", async () => {
    const { report } = await runGate({ rawPath: clean, configPath: CONFIG, thresholdsPath: "config/thresholds.v2.json", candidate: "prod-routed-5-5" });
    expect(report.decision).toBe("PASS");
    expect(report.checks.every(({ passed }) => passed)).toBe(true);
    expect(report.dataSource).toBe("mock");
  });

  it("blocks a regression of the advanced executor on critical errors and non-inferiority", async () => {
    const { report } = await runGate({ rawPath: regressed, configPath: CONFIG, thresholdsPath: "config/thresholds.v2.json", candidate: "prod-routed-5-5" });
    expect(report.decision).toBe("BLOCK");
    expect(report.reasons.some((reason) => reason.includes("critical error"))).toBe(true);
    expect(report.reasons.some((reason) => reason.includes("completion"))).toBe(true);
  });

  it("rejects thresholds pinned to severity rules v1 for dataset v3", async () => {
    const { report } = await runGate({ rawPath: clean, configPath: CONFIG, thresholdsPath: "config/thresholds.v1.json", candidate: "prod-routed-5-5" });
    expect(report.decision).toBe("BLOCK");
    expect(report.checks.find(({ id }) => id === "severity_rules_version")?.passed).toBe(false);
  });

  it("keeps the advanced executor pinned to Opus 5.5", () => {
    expect(ANTHROPIC_MODELS.opus55).toBe("claude-opus-5-5");
  });
});
