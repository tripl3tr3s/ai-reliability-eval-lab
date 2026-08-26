import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDataset } from "../src/dataset.js";

describe("dataset", () => {
  it("loads the immutable 30-case distribution", async () => {
    const dataset = await loadDataset();
    expect(dataset.cases).toHaveLength(30);
    expect(dataset.cases.filter(({ category }) => category === "lookup")).toHaveLength(10);
    expect(dataset.cases.filter(({ category }) => category === "multi_tool")).toHaveLength(10);
    expect(dataset.cases.filter(({ category }) => category === "recovery")).toHaveLength(8);
    expect(dataset.cases.filter(({ category }) => category === "abstention")).toHaveLength(2);
    expect(dataset.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects content changed after manifest publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eval-dataset-"));
    const originalManifest = new URL("../datasets/v1/manifest.json", import.meta.url);
    const originalCases = new URL("../datasets/v1/cases.jsonl", import.meta.url);
    await writeFile(join(directory, "manifest.json"), await readFile(originalManifest, "utf8"));
    await writeFile(join(directory, "cases.jsonl"), `${await readFile(originalCases, "utf8")}\n`);
    await expect(loadDataset(join(directory, "manifest.json"))).rejects.toThrow("Dataset hash mismatch");
  });
});
