import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { AuditLog, canonicalJson, chainEntry, GENESIS_HASH, sha256Canonical, verifyAuditLog, type AuditEvent } from "../../src/audit/log.js";
import { runGate } from "../../src/gate-command.js";
import { runMockExperiment } from "../../src/mock/run.js";

const event = (index: number): AuditEvent => ({ eventType: "test_event", ruleVersion: "rule-v1", dataHashes: { data: sha256Canonical({ index }) }, details: { index, nested: { b: 2, a: 1 } } });
const clock = () => { let tick = 0; return () => new Date(Date.UTC(2026, 9, 10, 0, 0, tick++)); };
const temp = async () => join(await mkdtemp(join(tmpdir(), "audit-")), "audit.jsonl");
async function logWith(count: number): Promise<{ path: string; lines: string[] }> {
  const path = await temp();
  const log = new AuditLog(path, clock());
  for (let index = 0; index < count; index += 1) await log.append(event(index));
  return { path, lines: (await readFile(path, "utf8")).trimEnd().split("\n") };
}
const join_ = (lines: readonly string[]) => `${lines.join("\n")}\n`;

describe("canonical JSON", () => {
  it("sorts keys at every level and is independent of insertion order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: null }], c: "x" } })).toBe('{"a":{"c":"x","d":[2,{"y":null,"z":1}]},"b":1}');
    expect(sha256Canonical({ a: 1, b: 2 })).toBe(sha256Canonical({ b: 2, a: 1 }));
    expect(sha256Canonical({ a: 1, b: 2 })).not.toBe(sha256Canonical({ a: 1, b: 3 }));
    expect(canonicalJson({ a: undefined, b: true })).toBe('{"b":true}');
  });

  it("uses the standard sha256 of the canonical text", () => {
    // echo -n '{"a":1}' | sha256sum
    expect(sha256Canonical({ a: 1 })).toBe("015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
  });

  it("rejects values JSON cannot represent faithfully", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
  });
});

describe("hash-chained audit log", () => {
  it("links every entry to the hash of the previous one", async () => {
    const { path, lines } = await logWith(4);
    const entries = lines.map((line) => JSON.parse(line) as { sequence: number; previousHash: string; hash: string; timestamp: string; eventType: string; ruleVersion: string; dataHashes: Record<string, string> });
    expect(entries.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3]);
    expect(entries[0]!.previousHash).toBe(GENESIS_HASH);
    for (let index = 1; index < entries.length; index += 1) expect(entries[index]!.previousHash).toBe(entries[index - 1]!.hash);
    expect(entries[2]).toMatchObject({ timestamp: "2026-10-10T00:00:02.000Z", eventType: "test_event", ruleVersion: "rule-v1", dataHashes: { data: sha256Canonical({ index: 2 }) } });
    const { hash, ...body } = entries[1]!;
    expect(sha256Canonical(body)).toBe(hash);
    expect(await new AuditLog(path).verify()).toEqual({ valid: true, entries: 4, headHash: entries[3]!.hash, issues: [] });
  });

  it("detects a modified line", async () => {
    const { lines } = await logWith(4);
    const tampered = [...lines];
    expect(tampered[1]).toContain('"index":1');
    tampered[1] = tampered[1]!.replace('"index":1', '"index":7');
    const result = verifyAuditLog(join_(tampered));
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([{ line: 2, problem: expect.stringContaining("was modified") }]);
  });

  it("detects a modified line even when its hash is recomputed", async () => {
    const { lines } = await logWith(4);
    const { hash: _discarded, ...body } = JSON.parse(lines[1]!) as Record<string, unknown>;
    void _discarded;
    const forgedBody = { ...body, details: { index: 7 } };
    const forged = [...lines];
    forged[1] = canonicalJson({ ...forgedBody, hash: sha256Canonical(forgedBody) });
    const result = verifyAuditLog(join_(forged));
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([{ line: 3, problem: expect.stringContaining("does not link") }]);
  });

  it("detects a deleted line", async () => {
    const { lines } = await logWith(4);
    const result = verifyAuditLog(join_([lines[0]!, lines[2]!, lines[3]!]));
    expect(result.valid).toBe(false);
    expect(result.issues.map(({ line }) => line)).toEqual([2, 2]);
    expect(result.issues.map(({ problem }) => problem).join(" ")).toMatch(/does not link.*sequence 2 where 1 was expected/u);
  });

  it("detects reordered lines and an inserted line", async () => {
    const { lines } = await logWith(4);
    expect(verifyAuditLog(join_([lines[0]!, lines[2]!, lines[1]!, lines[3]!])).valid).toBe(false);
    const inserted = canonicalJson(chainEntry(null, event(9), "2026-10-10T00:00:09.000Z"));
    expect(verifyAuditLog(join_([lines[0]!, inserted, lines[1]!])).valid).toBe(false);
    expect(verifyAuditLog(join_([lines[0]!, "not json", lines[1]!])).issues).toEqual([{ line: 2, problem: "not a valid audit entry" }]);
  });

  it("detects truncation only with an externally recorded head hash", async () => {
    const { lines } = await logWith(4);
    const head = (JSON.parse(lines[3]!) as { hash: string }).hash;
    const truncated = join_(lines.slice(0, 3));
    expect(verifyAuditLog(truncated).valid).toBe(true);
    expect(verifyAuditLog(truncated, { expectedHeadHash: head })).toMatchObject({ valid: false, issues: [{ line: 0, problem: expect.stringContaining("truncated") }] });
    expect(verifyAuditLog(join_(lines), { expectedHeadHash: head }).valid).toBe(true);
  });

  it("fails closed on an empty or missing log, since a deleted log looks the same", async () => {
    expect(verifyAuditLog("")).toMatchObject({ valid: false, entries: 0, headHash: GENESIS_HASH, issues: [{ line: 0, problem: expect.stringContaining("empty or missing") }] });
    expect(verifyAuditLog("\n").valid).toBe(false);
    expect(await new AuditLog(await temp()).verify()).toMatchObject({ valid: false, entries: 0 });
    expect(verifyAuditLog("", { allowEmpty: true })).toEqual({ valid: true, entries: 0, headHash: GENESIS_HASH, issues: [] });
  });

  it("rejects lines whose bytes differ from the entry they parse to", async () => {
    const { lines } = await logWith(3);
    const withLine = (replacement: string) => verifyAuditLog(join_([lines[0]!, replacement, lines[2]!]));
    const canonical = { valid: false, issues: [{ line: 2, problem: expect.stringContaining("not in canonical form") }] };
    // Duplicate key: JSON.parse keeps the last value, other readers may keep the first.
    const duplicated = lines[1]!.replace('{"dataHashes"', '{"eventType":"forged_event","dataHashes"');
    expect(JSON.parse(duplicated)).toEqual(JSON.parse(lines[1]!));
    expect(withLine(duplicated)).toMatchObject(canonical);
    expect(withLine(lines[1]!.replace('"sequence":1', '"sequence": 1'))).toMatchObject(canonical);
    expect(withLine(lines[1]!.replace('"sequence":1', '"sequence":1.0'))).toMatchObject(canonical);
    expect(withLine(lines[1]!.replace("test_event", "test\\u005fevent"))).toMatchObject(canonical);
    expect(withLine(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(lines[1]!) as Record<string, unknown>).reverse())))).toMatchObject(canonical);
    expect(verifyAuditLog(`${lines[0]}\r\n${lines[1]}\r\n`).valid).toBe(false);
    expect(verifyAuditLog(`${lines[0]}\n\n${lines[1]}\n${lines[2]}\n`).issues).toEqual([{ line: 2, problem: "not a valid audit entry" }]);
  });

  it("refuses to extend a log that fails verification", async () => {
    const { path, lines } = await logWith(2);
    await writeFile(path, join_([lines[0]!.replace('"index":0', '"index":5'), lines[1]!]));
    await expect(new AuditLog(path).append(event(2))).rejects.toThrow(/fails verification/u);
    expect((await readFile(path, "utf8")).trimEnd().split("\n")).toHaveLength(2);
  });

  it("only ever appends: earlier bytes are unchanged after new entries", async () => {
    const { path } = await logWith(2);
    const before = await readFile(path, "utf8");
    await new AuditLog(path, clock()).append(event(2));
    expect((await readFile(path, "utf8")).startsWith(before)).toBe(true);
  });
});

describe("audit trail of gate decisions", () => {
  it("records the decision, thresholds version, and input hashes, and verifies from the CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-gate-"));
    const raw = join(root, "raw.jsonl");
    const auditLogPath = join(root, "audit.jsonl");
    await runMockExperiment({ configPath: "config/full.v2.json", outputPath: raw, profile: "regressed" });
    const base = { rawPath: raw, configPath: "config/full.v2.json", thresholdsPath: "config/thresholds.v1.json", auditLogPath, now: () => new Date("2026-10-10T12:00:00Z") };
    const pass = await runGate({ ...base, candidate: "routed" });
    const block = await runGate({ ...base, candidate: "no-resource-injection", reference: "routed" });
    const entries = (await readFile(auditLogPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      sequence: 0, timestamp: "2026-10-10T12:00:00.000Z", eventType: "gate_decision", ruleVersion: "thresholds-v1",
      dataHashes: { raw: pass.report.inputs.raw.sha256, dataset: pass.report.inputs.dataset.sha256, thresholds: pass.report.inputs.thresholds.sha256, config: pass.report.inputs.config.sha256 },
      details: { decision: "PASS", candidate: "routed", reference: "direct-sonnet", severityRulesVersion: "severity-rules-v1", dataSource: "mock" },
    });
    expect(entries[1]).toMatchObject({ sequence: 1, details: { decision: "BLOCK", exitCode: 1 } });
    expect((entries[1]!.details as { reasons: string[] }).reasons).toEqual(block.report.reasons);

    const cli = async (...args: string[]) => {
      try { return { code: 0, stdout: (await promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli.ts", ...args])).stdout }; }
      catch (error) { return { code: (error as { code?: number }).code ?? -1, stdout: (error as { stdout?: string }).stdout ?? "" }; }
    };
    const verified = await cli("audit-verify", "--log", auditLogPath);
    expect(verified).toMatchObject({ code: 0 });
    expect(verified.stdout).toContain("Audit log verified: 2 entries");
    await writeFile(auditLogPath, (await readFile(auditLogPath, "utf8")).replace('"decision":"BLOCK"', '"decision":"PASS"'));
    const tampered = await cli("audit-verify", "--log", auditLogPath);
    expect(tampered).toMatchObject({ code: 1 });
    expect(tampered.stdout).toContain("line 2: content does not match its hash");
    const missing = await cli("audit-verify", "--log", join(root, "does-not-exist.jsonl"));
    expect(missing).toMatchObject({ code: 1 });
    expect(missing.stdout).toContain("FAILED verification");
    expect(missing.stdout).toContain("empty or missing");
  }, 60_000);
});
