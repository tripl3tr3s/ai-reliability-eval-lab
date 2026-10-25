import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SCORING_CONTRACT_VERSION } from "./scoring.js";

/**
 * Source files that decide how a raw row is scored. Replaying the same raw JSONL through a different
 * version of any of them can change every published number, so their hash is recorded with each report
 * and gate decision, and checked against the committed lock file. src/dataset.ts is included because its
 * schema defaults (plan ordering, invocation, forbidden tools, allowed extra calls) shape every scored case.
 */
export const SCORING_CONTRACT_FILES = ["src/scoring.ts", "src/text-es.ts", "src/gate/severity.ts", "src/dataset.ts"] as const;
export const SCORING_CONTRACT_LOCK_PATH = "config/scoring-contract.json";

export interface ScoringContract {
  readonly version: string;
  /** sha256 of the contract files in this checkout, or null when the sources are not available (an installed build). */
  readonly sha256: string | null;
  readonly lockedSha256: string | null;
  /** True only when the version, the file list, and the hash all match the committed lock. */
  readonly matchesLock: boolean;
}

const LockSchema = z.object({
  version: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  rationale: z.string().min(20),
}).strict();
export type ScoringContractLock = z.infer<typeof LockSchema>;

/** Repository root, resolved from this module so it works from `src/` under tsx and from `dist/` after a build. */
const packageRoot = (): string => dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Hash over each file's repository path and its bytes with line endings normalized to LF, in a fixed order,
 * so a checkout with CRLF line endings yields the same value. Returns null if any file is missing.
 */
export async function hashScoringContract(root: string = packageRoot(), files: readonly string[] = SCORING_CONTRACT_FILES): Promise<string | null> {
  const hash = createHash("sha256");
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(root, file));
    } catch {
      return null;
    }
    const normalized = Buffer.from(bytes.toString("utf8").replace(/\r\n/gu, "\n"), "utf8");
    hash.update(`${file}\n${normalized.length}\n`, "utf8");
    hash.update(normalized);
  }
  return hash.digest("hex");
}

export async function loadScoringContractLock(path: string = join(packageRoot(), SCORING_CONTRACT_LOCK_PATH)): Promise<ScoringContractLock | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return LockSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new Error(`Invalid scoring contract lock at ${path}; restore it from version control`, { cause: error });
  }
}

const sameFiles = (files: readonly string[]): boolean =>
  files.length === SCORING_CONTRACT_FILES.length && files.every((file, index) => file === SCORING_CONTRACT_FILES[index]);

/**
 * Writes the lock for the contract files as they are now. Run it only in a reviewed change that also bumps
 * SCORING_CONTRACT_VERSION, never to make a failing test pass.
 */
export async function writeScoringContractLock(rationale: string, root: string = packageRoot()): Promise<ScoringContractLock> {
  const sha256 = await hashScoringContract(root);
  if (sha256 === null) throw new Error(`Cannot lock the scoring contract: one of ${SCORING_CONTRACT_FILES.join(", ")} is missing under ${root}`);
  const existing = await loadScoringContractLock(join(root, SCORING_CONTRACT_LOCK_PATH));
  if (existing !== null && existing.version === SCORING_CONTRACT_VERSION && existing.sha256 !== sha256) {
    throw new Error(`The scoring contract changed but SCORING_CONTRACT_VERSION is still ${SCORING_CONTRACT_VERSION}; bump it in src/scoring.ts before writing the lock`);
  }
  const lock = LockSchema.parse({ version: SCORING_CONTRACT_VERSION, files: [...SCORING_CONTRACT_FILES], sha256, rationale });
  await writeFile(join(root, SCORING_CONTRACT_LOCK_PATH), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return lock;
}

/** The scoring contract in effect for this process, for recording in summary.json, gate.json, and the audit log. */
export async function currentScoringContract(root: string = packageRoot()): Promise<ScoringContract> {
  const [sha256, lock] = await Promise.all([hashScoringContract(root), loadScoringContractLock(join(root, SCORING_CONTRACT_LOCK_PATH))]);
  return {
    version: SCORING_CONTRACT_VERSION,
    sha256,
    lockedSha256: lock?.sha256 ?? null,
    matchesLock: sha256 !== null && lock !== null && lock.version === SCORING_CONTRACT_VERSION && sameFiles(lock.files) && lock.sha256 === sha256,
  };
}
