import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const GENESIS_HASH = "0".repeat(64);
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);

const EntryBodySchema = z.object({
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  eventType: z.string().min(1),
  /** Version of the rule set or thresholds that produced the event. */
  ruleVersion: z.string().min(1),
  /** sha256 of each piece of data the event refers to, keyed by a short name. */
  dataHashes: z.record(Hash),
  details: z.record(z.unknown()),
  previousHash: Hash,
}).strict();
const EntrySchema = EntryBodySchema.extend({ hash: Hash }).strict();

export type AuditEntry = z.infer<typeof EntrySchema>;
export type AuditEvent = Pick<AuditEntry, "eventType" | "ruleVersion" | "dataHashes" | "details">;

/** JSON with object keys sorted at every level and no whitespace, so equal values always hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot represent a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot represent a value of type ${typeof value}`);
}

export const sha256Canonical = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Builds the next entry of a chain. The hash covers every other field, including the previous entry's hash. */
export function chainEntry(previous: Pick<AuditEntry, "sequence" | "hash"> | null, event: AuditEvent, timestamp: string): AuditEntry {
  const body = EntryBodySchema.parse({
    sequence: previous === null ? 0 : previous.sequence + 1,
    timestamp,
    eventType: event.eventType,
    ruleVersion: event.ruleVersion,
    dataHashes: event.dataHashes,
    details: JSON.parse(canonicalJson(event.details)) as Record<string, unknown>,
    previousHash: previous === null ? GENESIS_HASH : previous.hash,
  });
  return { ...body, hash: sha256Canonical(body) };
}

export interface AuditIssue { readonly line: number; readonly problem: string }
export interface AuditVerification {
  readonly valid: boolean;
  readonly entries: number;
  /** Hash of the last valid entry. Record it outside the log: a chain cannot reveal that its own tail was cut off. */
  readonly headHash: string;
  readonly issues: readonly AuditIssue[];
}

export interface VerifyOptions {
  /** Hash of the last entry as recorded outside the log. Detects truncation and wholesale replacement. */
  readonly expectedHeadHash?: string;
  /** Only the writer sets this, to start a new chain. A reader must treat an empty log as a failure. */
  readonly allowEmpty?: boolean;
}

/**
 * Verifies a JSONL audit log. Any modified, inserted, deleted, or reordered line breaks either an entry's
 * own hash or the link to its predecessor.
 *
 * Verification fails closed:
 * - an empty log is invalid, because a deleted log would otherwise look clean;
 * - every line must be byte-identical to the canonical serialization of the entry it parses to, so
 *   duplicate keys, reordered keys, extra whitespace, or alternative escapes cannot make two readers
 *   see different content behind one valid hash;
 * - blank lines are only accepted as the final line terminator.
 */
export function verifyAuditLog(text: string, options: VerifyOptions = {}): AuditVerification {
  const issues: AuditIssue[] = [];
  let previousHash = GENESIS_HASH;
  let expectedSequence = 0;
  let entries = 0;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    let entry: AuditEntry;
    try {
      entry = EntrySchema.parse(JSON.parse(line));
    } catch {
      issues.push({ line: lineNumber, problem: "not a valid audit entry" });
      continue;
    }
    entries += 1;
    const { hash, ...body } = entry;
    if (canonicalJson(entry) !== line) issues.push({ line: lineNumber, problem: "is not in canonical form (bytes differ from the entry they parse to)" });
    if (sha256Canonical(body) !== hash) issues.push({ line: lineNumber, problem: "content does not match its hash (entry was modified)" });
    if (entry.previousHash !== previousHash) issues.push({ line: lineNumber, problem: "does not link to the previous entry (an entry was removed, inserted, or reordered)" });
    if (entry.sequence !== expectedSequence) issues.push({ line: lineNumber, problem: `sequence ${entry.sequence} where ${expectedSequence} was expected` });
    previousHash = hash;
    expectedSequence = entry.sequence + 1;
  }
  if (entries === 0 && issues.length === 0 && !options.allowEmpty) {
    issues.push({ line: 0, problem: "the log is empty or missing, which is indistinguishable from a deleted log" });
  }
  if (options.expectedHeadHash !== undefined && options.expectedHeadHash !== previousHash) {
    issues.push({ line: 0, problem: "head hash does not match the expected value (the log was truncated or replaced)" });
  }
  return { valid: issues.length === 0, entries, headHash: previousHash, issues };
}

/** Replaces undecodable input so that verification reports it instead of throwing. Never valid JSON. */
const UNDECODABLE = "\u0000invalid-utf8";

/**
 * Decodes log bytes strictly. A lenient decoder maps every malformed byte sequence to U+FFFD, so
 * different files on disk would verify as the same text; a byte order mark would likewise be hidden.
 * Malformed input is turned into a line that can never verify.
 */
export function decodeAuditBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return UNDECODABLE;
  }
}

/**
 * Append-only audit log on disk. Entries are only ever appended; nothing here rewrites the file.
 * Assumes a single writer. This is a demonstration of the pattern, not a durable audit service.
 */
export class AuditLog {
  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {}

  async append(event: AuditEvent): Promise<AuditEntry> {
    const existing = await this.read();
    const check = verifyAuditLog(existing, { allowEmpty: true });
    if (!check.valid) throw new Error(`Refusing to append to a log that fails verification (${check.issues[0]!.problem})`);
    const lines = existing.split("\n").filter((line) => line.length > 0);
    const last = lines.length === 0 ? null : EntrySchema.parse(JSON.parse(lines.at(-1)!));
    const entry = chainEntry(last, event, this.now().toISOString());
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${canonicalJson(entry)}\n`, "utf8");
    return entry;
  }

  /** Verifies the file. A missing or empty file fails, as does any line that is not canonical. */
  async verify(expectedHeadHash?: string): Promise<AuditVerification> {
    return verifyAuditLog(await this.read(), expectedHeadHash === undefined ? {} : { expectedHeadHash });
  }

  private async read(): Promise<string> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
    return decodeAuditBytes(bytes);
  }
}
