import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCORING_CONTRACT_VERSION } from "../src/scoring.js";
import {
  currentScoringContract,
  hashScoringContract,
  loadScoringContractLock,
  SCORING_CONTRACT_FILES,
  SCORING_CONTRACT_LOCK_PATH,
  writeScoringContractLock,
} from "../src/scoring-contract.js";

const RATIONALE = "Synthetic contract written by the scoring contract tests.";

/** Copies the contract files into a fresh directory so a test can change bytes without touching the checkout. */
async function copyContract(transform: (file: string, text: string) => string = (_file, text) => text): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scoring-contract-"));
  for (const file of SCORING_CONTRACT_FILES) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), transform(file, await readFile(file, "utf8")));
  }
  return root;
}

describe("scoring contract lock", () => {
  it("matches the committed lock, so scorer changes need a reviewed version bump", async () => {
    const contract = await currentScoringContract();
    // If this fails, the scoring code changed. Bump SCORING_CONTRACT_VERSION in src/scoring.ts and run
    // `pnpm scoring-contract --write --rationale "<why>"` in a reviewed change of its own.
    expect(contract).toEqual({ version: SCORING_CONTRACT_VERSION, sha256: contract.lockedSha256, lockedSha256: expect.stringMatching(/^[0-9a-f]{64}$/u), matchesLock: true });
    const lock = await loadScoringContractLock(SCORING_CONTRACT_LOCK_PATH);
    expect(lock?.version).toBe(SCORING_CONTRACT_VERSION);
    expect(lock?.files).toEqual([...SCORING_CONTRACT_FILES]);
  });

  it("is stable for the same bytes and ignores CRLF line endings", async () => {
    const lf = await copyContract();
    const crlf = await copyContract((_file, text) => text.replace(/\n/gu, "\r\n"));
    const reference = await hashScoringContract();
    expect(await hashScoringContract(lf)).toBe(reference);
    expect(await hashScoringContract(crlf)).toBe(reference);
  });

  it("changes when a single byte of any contract file changes", async () => {
    const reference = await hashScoringContract();
    for (const changed of SCORING_CONTRACT_FILES) {
      const root = await copyContract((file, text) => file === changed ? `${text} ` : text);
      expect(await hashScoringContract(root)).not.toBe(reference);
    }
  });

  it("binds each file's path, so moving bytes between files changes the hash", async () => {
    expect(await hashScoringContract(".", ["src/scoring.ts", "src/text-es.ts"])).not.toBe(await hashScoringContract(".", ["src/text-es.ts", "src/scoring.ts"]));
  });

  it("reports no hash and no match when a source file is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "scoring-contract-empty-"));
    expect(await hashScoringContract(root)).toBeNull();
    expect(await currentScoringContract(root)).toEqual({ version: SCORING_CONTRACT_VERSION, sha256: null, lockedSha256: null, matchesLock: false });
    await expect(writeScoringContractLock(RATIONALE, root)).rejects.toThrow(/missing/u);
  });

  it("does not match a lock that predates a scorer edit until the lock is rewritten", async () => {
    const root = await copyContract();
    await mkdir(join(root, "config"), { recursive: true });
    const lock = await writeScoringContractLock(RATIONALE, root);
    expect(await currentScoringContract(root)).toMatchObject({ sha256: lock.sha256, matchesLock: true });

    await writeFile(join(root, "src/text-es.ts"), `${await readFile(join(root, "src/text-es.ts"), "utf8")}\n// edited\n`);
    const edited = await currentScoringContract(root);
    expect(edited.matchesLock).toBe(false);
    expect(edited.lockedSha256).toBe(lock.sha256);
    expect(edited.sha256).not.toBe(lock.sha256);
  });

  it("refuses to rewrite the lock for a changed contract without a version bump", async () => {
    const root = await copyContract();
    await mkdir(join(root, "config"), { recursive: true });
    await writeScoringContractLock(RATIONALE, root);
    await writeScoringContractLock(RATIONALE, root);
    await writeFile(join(root, "src/dataset.ts"), `${await readFile(join(root, "src/dataset.ts"), "utf8")}\n// edited\n`);
    await expect(writeScoringContractLock(RATIONALE, root)).rejects.toThrow(/bump it in src\/scoring.ts/u);
  });

  it("does not match a lock that lists different files, even with the right hash", async () => {
    const root = await copyContract();
    await mkdir(join(root, "config"), { recursive: true });
    const lock = await writeScoringContractLock(RATIONALE, root);
    await writeFile(join(root, SCORING_CONTRACT_LOCK_PATH), JSON.stringify({ ...lock, files: ["src/scoring.ts"] }));
    expect(await currentScoringContract(root)).toMatchObject({ sha256: lock.sha256, lockedSha256: lock.sha256, matchesLock: false });
  });

  it("fails with a clear error on a corrupt lock instead of treating it as missing", async () => {
    const root = await copyContract();
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, SCORING_CONTRACT_LOCK_PATH), "{ not json");
    await expect(currentScoringContract(root)).rejects.toThrow(/Invalid scoring contract lock/u);
  });

  it("rejects a lock with a short rationale or unknown keys", async () => {
    const root = await copyContract();
    await mkdir(join(root, "config"), { recursive: true });
    await expect(writeScoringContractLock("too short", root)).rejects.toThrow();
    const path = join(root, SCORING_CONTRACT_LOCK_PATH);
    await writeFile(path, JSON.stringify({ version: "v", files: ["a"], sha256: "0".repeat(64), rationale: RATIONALE, extra: true }));
    await expect(loadScoringContractLock(path)).rejects.toThrow();
  });
});
