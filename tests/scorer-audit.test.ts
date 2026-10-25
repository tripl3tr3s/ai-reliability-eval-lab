import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDataset } from "../src/dataset.js";
import { scoreRun, SCORING_CONTRACT_VERSION, type RawRun } from "../src/scoring.js";
import { AuditKeySchema, AuditLabelsSchema, renderAgreement, scorerAgreement, type AuditLabels } from "../src/scorer-audit/agreement.js";
import { KEY_FILE, runScorerAuditSample, runScorerAuditScore, TEMPLATE_FILE } from "../src/scorer-audit/command.js";
import { sampleForAudit, SCORER_AUDIT_VERSION, type AuditKey, type AuditSource } from "../src/scorer-audit/sample.js";
import { wilsonInterval } from "../src/stats/index.js";
import { syntheticGrid, toJsonl } from "./helpers/synthetic.js";

const dataset = await loadDataset("datasets/v2/manifest.json");
const byId = new Map(dataset.cases.map((item) => [item.id, item]));
const scoreAll = (runs: readonly RawRun[]) => runs.map((run) => scoreRun(run, byId.get(run.caseId)!));
const contract = { version: SCORING_CONTRACT_VERSION, sha256: "a".repeat(64), lockedSha256: "a".repeat(64), matchesLock: true };
const source: AuditSource = { rawSha256: "b".repeat(64), datasetHash: dataset.hash, datasetVersion: dataset.version, scoringContract: contract, mock: false };
const ARMS = ["candidate-arm", "reference-arm"] as const;

// candidate-arm fails every repeat of the first 12 cases; reference-arm passes everything.
const runs = syntheticGrid(dataset.cases, ({ caseIndex, configuration }) => configuration === "reference-arm" || caseIndex >= 12, 5, ARMS);
const sample = (perStratum: number, seed: number) => sampleForAudit({ runs, scores: scoreAll(runs), cases: dataset.cases, perStratum, seed, source });

describe("audit sample", () => {
  const { key, template } = sample(8, 11);

  it("stratifies by configuration and scorer verdict and caps each stratum", () => {
    expect(key.strata).toEqual([
      { configuration: "candidate-arm", scorerVerdict: "fail", runs: 60, cases: 12, sampled: 8 },
      { configuration: "candidate-arm", scorerVerdict: "pass", runs: 90, cases: 18, sampled: 8 },
      { configuration: "reference-arm", scorerVerdict: "pass", runs: 150, cases: 30, sampled: 8 },
    ]);
    expect(key.items).toHaveLength(24);
    expect(sample(100, 11).key.strata.map(({ sampled }) => sampled)).toEqual([12, 18, 30]);
  });

  it("draws at most one run per case in each stratum, from that stratum", () => {
    for (const stratum of key.strata) {
      const members = key.items.filter((item) => item.configuration === stratum.configuration && item.scorerVerdict === stratum.scorerVerdict);
      expect(new Set(members.map(({ caseId }) => caseId)).size).toBe(members.length);
      if (stratum.scorerVerdict === "fail") expect(members.every(({ caseId }) => dataset.cases.findIndex(({ id }) => id === caseId) < 12)).toBe(true);
    }
  });

  it("is reproducible from the seed and changes with it", () => {
    expect(sample(8, 11)).toEqual({ key, template });
    expect(sample(8, 12).key.items.map(({ runId }) => runId)).not.toEqual(key.items.map(({ runId }) => runId));
  });

  it("hides the arm, the run id and the scorer verdict from the labeler", () => {
    const text = JSON.stringify(template);
    for (const hidden of [...ARMS, "scorerVerdict", "runId", "completionPassed"]) expect(text).not.toContain(hidden);
    expect(template.items.map(({ itemId }) => itemId)).toEqual(key.items.map(({ itemId }) => itemId));
    expect(new Set(key.items.map(({ itemId }) => itemId)).size).toBe(24);
    // Items are shuffled across strata, so the first eight are not one stratum.
    expect(new Set(key.items.slice(0, 8).map(({ configuration, scorerVerdict }) => `${configuration}:${scorerVerdict}`)).size).toBeGreaterThan(1);
  });

  it("gives the labeler the task and the run, without the scorer's checklist", () => {
    const item = template.items[0]!;
    const keyed = key.items[0]!;
    const datasetCase = byId.get(keyed.caseId)!;
    const run = runs.find(({ runId }) => runId === keyed.runId)!;
    expect(item).toMatchObject({ caseId: datasetCase.id, category: datasetCase.category, prompt: datasetCase.prompt, label: { completion: null, note: "" } });
    expect(item.run).toMatchObject({ outcome: run.outcome, answer: run.answer, finalState: run.finalState });
    // v2 has no reference answer, and the scorer's own checks are never shown.
    expect(item.guidance).toEqual({ referenceAnswer: null });
    const text = JSON.stringify(template);
    for (const scorerCheck of ["requiredAssertions", "acceptableFactSets", "expectedState", "forbiddenTools", "forbiddenClaims", "acceptedPlans"]) expect(text).not.toContain(scorerCheck);
    expect(template).toMatchObject({ version: SCORER_AUDIT_VERSION, labeler: "" });
  });

  it("rejects a non-positive stratum size", () => {
    expect(() => sample(0, 1)).toThrow(RangeError);
  });
});

describe("scorer agreement", () => {
  const { key, template } = sample(10, 5);
  const truth = (item: AuditKey["items"][number]) => item.scorerVerdict;
  // The labeler fails 2 of the candidate's passed items and passes 1 of its failed items, is unsure about one
  // reference item, and leaves one reference item unlabeled.
  const candidatePass = key.items.filter((item) => item.configuration === "candidate-arm" && item.scorerVerdict === "pass");
  const candidateFail = key.items.filter((item) => item.configuration === "candidate-arm" && item.scorerVerdict === "fail");
  const reference = key.items.filter((item) => item.configuration === "reference-arm");
  const flipped = new Set([candidatePass[0]!.itemId, candidatePass[1]!.itemId, candidateFail[0]!.itemId]);
  const unsure = reference[0]!.itemId;
  const unlabeled = reference[1]!.itemId;
  const labelFor = (item: AuditKey["items"][number]) => item.itemId === unsure ? "unsure" as const
    : flipped.has(item.itemId) ? (truth(item) === "pass" ? "fail" as const : "pass" as const) : truth(item);
  const labels: AuditLabels = AuditLabelsSchema.parse({
    ...template,
    labeler: "domain-reviewer",
    items: template.items.filter(({ itemId }) => itemId !== unlabeled).map((item) => ({ ...item, label: { completion: labelFor(key.items.find(({ itemId }) => itemId === item.itemId)!), note: "" } })),
  });
  const result = scorerAgreement(key, labels, contract);

  it("reports false pass and false fail per arm with Wilson intervals", () => {
    const candidate = result.arms.find(({ configuration }) => configuration === "candidate-arm")!;
    expect(candidate.falsePass).toEqual({ labeled: 10, disagreements: 2, rate: 0.2, wilson95: wilsonInterval(2, 10, 0.95) });
    expect(candidate.falseFail).toEqual({ labeled: 10, disagreements: 1, rate: 0.1, wilson95: wilsonInterval(1, 10, 0.95) });
    const referenceArm = result.arms.find(({ configuration }) => configuration === "reference-arm")!;
    expect(referenceArm.falsePass).toMatchObject({ labeled: 8, disagreements: 0, rate: 0 });
    // The reference arm has no failed runs, so it has no false-fail stratum.
    expect(referenceArm.falseFail).toEqual({ labeled: 0, disagreements: 0, rate: null, wilson95: null });
  });

  it("counts unsure and unlabeled items and leaves them out of every rate", () => {
    expect(result).toMatchObject({ items: 30, labeled: 28, unsure: 1, unlabeled: 1, labeler: "domain-reviewer", scorerUnchanged: true });
    expect(result.strata.find(({ configuration }) => configuration === "reference-arm")).toMatchObject({ unsure: 1, unlabeled: 1, labeled: 8 });
    expect(result.warnings).toEqual(["1 items have no label."]);
  });

  it("weights stratum agreement by runs per stratum", () => {
    // Every case has all 5 repeats in its stratum here, so the case weights are equal.
    // Strata: candidate fail (60 runs, 0.9), candidate pass (90 runs, 0.8), reference pass (150 runs, 1.0).
    expect(key.items.every(({ caseRunsInStratum }) => caseRunsInStratum === 5)).toBe(true);
    expect(result.weightedAgreement).toBeCloseTo((60 * 0.9 + 90 * 0.8 + 150 * 1) / 300, 14);
    expect(renderAgreement(result)).toContain("| candidate-arm | 2/10, 20.0% (");
  });

  it("warns when the scorer changed since sampling, and for mock rows", () => {
    const changed = scorerAgreement({ ...key, source: { ...key.source, mock: true } }, labels, { ...contract, sha256: "c".repeat(64) });
    expect(changed.scorerUnchanged).toBe(false);
    expect(changed.warnings.join(" ")).toMatch(/scripted mock.*differs from the one the sample was drawn with/su);
  });

  it("rejects labels from another audit, duplicates, and a labeler named by name", () => {
    expect(() => scorerAgreement(key, { ...labels, items: [...labels.items, { itemId: "item-999", caseId: "x", label: { completion: "pass", note: "" } }] }, contract)).toThrow(/different audits/u);
    expect(() => scorerAgreement(key, { ...labels, items: [...labels.items, labels.items[0]!] }, contract)).toThrow(/more than once/u);
    const swapped = { ...labels, items: labels.items.map((item, index) => (index === 0 ? { ...item, caseId: "v2-other-case" } : item)) };
    expect(() => scorerAgreement(key, swapped, contract)).toThrow(/different audits/u);
    expect(AuditLabelsSchema.safeParse({ ...labels, labeler: "Jane Doe" }).success).toBe(false);
    expect(AuditLabelsSchema.safeParse({ ...labels, labeler: "maria-lopez" }).success).toBe(false);
    expect(AuditLabelsSchema.safeParse({ ...labels, items: [] }).success).toBe(false);
    expect(AuditLabelsSchema.safeParse({ ...labels, labeler: "senior-fiscal-reviewer" }).success).toBe(true);
    expect(AuditLabelsSchema.safeParse({ ...labels, labeler: "" }).success).toBe(false);
  });
});

describe("scorer audit commands", () => {
  it("writes the key and template, refuses to overwrite them, and scores a filled template", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-audit-"));
    const raw = join(root, "raw.jsonl");
    await writeFile(raw, toJsonl(runs));
    const output = join(root, "audit");
    const { directory, key } = await runScorerAuditSample({ rawPath: raw, configPath: "config/full.v2.json", outputDirectory: output, perStratum: 4, seed: 3, scoringContract: contract });
    expect(directory).toBe(output);
    expect(key.source).toMatchObject({ datasetVersion: "v2", mock: false, scoringContract: contract });
    expect(key.source.rawSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(runScorerAuditSample({ rawPath: raw, configPath: "config/full.v2.json", outputDirectory: output, scoringContract: contract })).rejects.toThrow(/already exists/u);

    const template = JSON.parse(await readFile(join(output, TEMPLATE_FILE), "utf8")) as { labeler: string; items: { itemId: string; label: { completion: string | null } }[] };
    const filled = { ...template, labeler: "fiscal-reviewer", items: template.items.map((item) => ({ ...item, label: { completion: "pass", note: "" } })) };
    await writeFile(join(root, "labels.json"), JSON.stringify(filled));
    const result = await runScorerAuditScore({ keyPath: join(output, KEY_FILE), labelsPath: join(root, "labels.json"), outputDirectory: join(root, "scored"), scoringContract: contract });
    expect(result.labeled).toBe(12);
    // Every label says pass, so only the candidate's failed stratum disagrees.
    expect(result.arms.find(({ configuration }) => configuration === "candidate-arm")!.falseFail).toMatchObject({ labeled: 4, disagreements: 4 });
    expect(JSON.parse(await readFile(join(root, "scored", "agreement.json"), "utf8"))).toMatchObject({ version: SCORER_AUDIT_VERSION, labeler: "fiscal-reviewer" });
    expect(await readFile(join(root, "scored", "agreement.md"), "utf8")).toContain("# Scorer audit");
  });

  it("rejects an empty raw file and unreadable labels", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-audit-"));
    await writeFile(join(root, "empty.jsonl"), "");
    await expect(runScorerAuditSample({ rawPath: join(root, "empty.jsonl"), configPath: "config/full.v2.json", outputDirectory: join(root, "a"), scoringContract: contract })).rejects.toThrow(/no runs/u);
    await writeFile(join(root, "broken.json"), "{");
    await expect(runScorerAuditScore({ keyPath: join(root, "broken.json"), labelsPath: join(root, "broken.json"), outputDirectory: join(root, "s") })).rejects.toThrow(/Could not read/u);
  });
});

describe("audit edge cases", () => {
  it("hides the real v3 arm names, routing tier and model ids", () => {
    const v3Arms = ["prod-routed-5-5", "direct-sonnet-5-5"] as const;
    const tagged = syntheticGrid(dataset.cases, ({ caseIndex }) => caseIndex % 4 !== 0, 5, v3Arms)
      .map((run): RawRun => ({ ...run, tier: "advanced", routedDomain: "pagos", modelIds: ["claude-opus-5-5"], costUsd: 0.123456 }));
    const { template } = sampleForAudit({ runs: tagged, scores: scoreAll(tagged), cases: dataset.cases, perStratum: 50, seed: 2, source });
    const text = JSON.stringify(template);
    for (const hidden of [...v3Arms, "advanced", "pagos", "claude-opus-5-5", "0.123456", "tier", "routedDomain", "modelIds", "costUsd", "latencyMs"]) expect(text).not.toContain(hidden);
  });

  it("lets a case with mixed repeats recur across strata, once per stratum, and weights it by its runs", () => {
    // The candidate fails repeats 0 and 1 of case 0, so case 0 sits in both of its verdict strata.
    const mixed = syntheticGrid(dataset.cases, ({ caseIndex, configuration, repeat }) => !(configuration === "candidate-arm" && caseIndex === 0 && repeat < 2), 5, ARMS);
    const { key, template } = sampleForAudit({ runs: mixed, scores: scoreAll(mixed), cases: dataset.cases, perStratum: 100, seed: 4, source });
    const case0 = key.items.filter(({ caseId, configuration }) => caseId === dataset.cases[0]!.id && configuration === "candidate-arm");
    expect(case0.map(({ scorerVerdict, caseRunsInStratum }) => [scorerVerdict, caseRunsInStratum]).sort()).toEqual([["fail", 2], ["pass", 3]]);
    expect(template.items.filter(({ caseId }) => caseId === dataset.cases[0]!.id)).toHaveLength(3);
    // Fail the 3-run copy of case 0 in the pass stratum: run-level agreement there is (90 - 3) / 90 of the runs.
    const passCopy = case0.find(({ scorerVerdict }) => scorerVerdict === "pass")!;
    const labels = AuditLabelsSchema.parse({
      ...template,
      labeler: "fiscal-reviewer",
      items: template.items.map((item) => {
        const keyed = key.items.find(({ itemId }) => itemId === item.itemId)!;
        return { ...item, label: { completion: keyed.itemId === passCopy.itemId ? "fail" : keyed.scorerVerdict, note: "" } };
      }),
    });
    const result = scorerAgreement(key, labels, contract);
    const passStratum = key.strata.find(({ configuration, scorerVerdict }) => configuration === "candidate-arm" && scorerVerdict === "pass")!;
    expect(passStratum).toMatchObject({ runs: 148, cases: 30 });
    const total = key.strata.reduce((sum, { runs }) => sum + runs, 0);
    expect(result.weightedAgreement).toBeCloseTo(1 - (148 / total) * (3 / 148), 14);
    // The case-level rate counts the case once.
    expect(result.arms.find(({ configuration }) => configuration === "candidate-arm")!.falsePass).toMatchObject({ labeled: 30, disagreements: 1 });
  });

  it("rejects a key whose items and strata disagree", () => {
    const { key } = sample(5, 9);
    const parse = (value: unknown) => AuditKeySchema.safeParse(value);
    expect(parse(key).success).toBe(true);
    expect(parse({ ...key, items: key.items.slice(1) }).success).toBe(false);
    expect(parse({ ...key, items: [...key.items.slice(1), { ...key.items[1]!, itemId: key.items[0]!.itemId }] }).success).toBe(false);
    expect(parse({ ...key, items: key.items.map((item, index) => (index === 0 ? { ...item, configuration: "unknown-arm" } : item)) }).success).toBe(false);
    expect(parse({ ...key, strata: key.strata.map((stratum, index) => (index === 0 ? { ...stratum, cases: 1 } : stratum)) }).success).toBe(false);
    expect(parse({ ...key, seed: -1 }).success).toBe(false);
  });

  it("warns about a stratum without labels", () => {
    const { key, template } = sample(5, 9);
    const failIds = new Set(key.items.filter(({ scorerVerdict }) => scorerVerdict === "fail").map(({ itemId }) => itemId));
    const labels = AuditLabelsSchema.parse({
      ...template,
      labeler: "fiscal-reviewer",
      items: template.items.filter(({ itemId }) => !failIds.has(itemId)).map((item) => ({ ...item, label: { completion: "pass", note: "" } })),
    });
    const result = scorerAgreement(key, labels, contract);
    expect(result.warnings).toContain("No labels in stratum candidate-arm fail; the weighted agreement leaves it out.");
    expect(result.weightedAgreement).toBe(1);
  });
});

