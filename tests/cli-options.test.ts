import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArguments, validateRunArtifactPaths, validateRunArtifactTargets } from "../src/cli-options.js";

describe("CLI argument parsing", () => {
  it("parses interactive run options with validated progress mode", () => {
    expect(parseCliArguments([
      "run",
      "--interactive",
      "--config",
      "config/smoke.v2.json",
      "--output",
      "runs/custom.jsonl",
      "--events",
      "runs/custom-events.jsonl",
      "--progress",
      "plain",
    ])).toEqual({
      command: "run",
      interactive: true,
      configPath: "config/smoke.v2.json",
      outputPath: "runs/custom.jsonl",
      eventsPath: "runs/custom-events.jsonl",
      progress: "plain",
    });
  });

  it("preserves run defaults without making the command interactive", () => {
    expect(parseCliArguments(["run"])).toEqual({
      command: "run",
      interactive: false,
      progress: "auto",
    });
  });

  it("parses the existing validation and report commands", () => {
    expect(parseCliArguments(["validate-dataset", "--manifest", "datasets/v2/manifest.json"])).toEqual({
      command: "validate-dataset",
      manifestPath: "datasets/v2/manifest.json",
    });
    expect(parseCliArguments(["validate-config"])).toEqual({ command: "validate-config" });
    expect(parseCliArguments(["report", "--raw", "runs/raw.jsonl"])).toEqual({
      command: "report",
      rawPath: "runs/raw.jsonl",
    });
    expect(parseCliArguments(["report", "--raw", "runs/raw.jsonl", "--events", "runs/events.jsonl", "--output", "out", "--config", "config/smoke.v2.json"])).toEqual({
      command: "report",
      rawPath: "runs/raw.jsonl",
      eventsPath: "runs/events.jsonl",
      outputPath: "out",
      configPath: "config/smoke.v2.json",
    });
  });

  it("rejects unsupported progress values, options, and commands", () => {
    expect(() => parseCliArguments(["run", "--progress", "rainbow"])).toThrow(/progress/u);
    expect(() => parseCliArguments(["run", "--output", "runs/result\nspoofed.jsonl"])).toThrow(/control characters/u);
    expect(() => parseCliArguments(["run", "--unknown"])).toThrow(/Unknown option/u);
    expect(() => parseCliArguments(["launch"])).toThrow(/Usage/u);
  });

  it("keeps result and telemetry streams in different files", () => {
    expect(() => validateRunArtifactPaths("runs/output.jsonl", "runs/../runs/output.jsonl")).toThrow(/different files/u);
    expect(() => validateRunArtifactPaths("runs/output.jsonl", "runs/events.jsonl")).not.toThrow();
  });

  it("rejects symlink and hard-link aliases for artifact files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-paths-"));
    const actual = join(directory, "actual");
    const alias = join(directory, "alias");
    await mkdir(actual);
    await symlink(actual, alias);
    try {
      await expect(validateRunArtifactTargets(
        join(actual, "future.jsonl"),
        join(alias, "future.jsonl"),
      )).rejects.toThrow(/different files/u);

      const first = join(actual, "first.jsonl");
      const second = join(actual, "second.jsonl");
      await writeFile(first, "");
      await link(first, second);
      await expect(validateRunArtifactTargets(first, second)).rejects.toThrow(/different files/u);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
