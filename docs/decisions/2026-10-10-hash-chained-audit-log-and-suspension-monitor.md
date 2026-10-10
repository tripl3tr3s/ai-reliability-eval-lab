# ADR: hash-chained audit log and suspension monitor

| Field | Value |
| --- | --- |
| Date | 2026-10-10 |
| Status | Accepted as a demonstration of the pattern. Implemented on `feat/go-live-gate` (`8976e03`, `533d2c5`, `0112ae3`), not yet merged. Not a production service. |
| Related | [Gate ADR](2026-10-10-three-way-gate-with-versioned-thresholds.md), [architecture](../architecture.md) |

## Context

Gate decisions and runtime safeguards need a record that shows afterwards which rule version decided what, on which data, and that the record was not edited. The repository has no database or service, by design.

## Decision

Audit log (`src/audit/log.ts`):

1. Append-only JSONL. Each entry holds a sequence number, timestamp, event type, rule or thresholds version, the sha256 of each piece of data it refers to, details, and the hash of the previous entry. Its own hash is sha256 over the canonical JSON of all other fields.
2. Canonical JSON means sorted keys at every level and no whitespace. Entries are written in canonical form.
3. Verification fails closed:
   - an empty or missing log is invalid, because a deleted log would otherwise look clean;
   - every line must be byte-identical to the canonical form of the entry it parses to, which rejects duplicate keys, reordered keys, extra whitespace, and alternate escapes;
   - bytes are decoded as strict UTF-8, with no byte order mark;
   - interior blank lines and CRLF are rejected.
4. The writer verifies the existing log before appending and refuses to extend a broken chain.
5. `pnpm audit:verify` exits 0 or 1 and prints the head hash. Passing `--head` also detects truncation.
6. The gate appends its decision with `--audit-log`.

Suspension monitor (`src/monitor/monitor.ts`):

1. A pure state machine over a rolling window: ACTIVE or SUSPENDED.
2. It suspends when the one-sided Wilson upper bound on the failure rate exceeds a configured limit, once a minimum window is reached.
3. Outcomes that arrive while suspended are not counted.
4. Re-enabling requires a non-empty owner and reason, clears the window, and is logged.
5. A status change is written to the audit sink before the state changes. If the write fails, the state does not change.

## Alternatives considered

- **Hash the parsed entry only.** This was the first implementation. Rejected after review: one valid hash could cover lines that different readers parse differently.
- **Accept an empty log as valid.** Also the first implementation. Rejected: deleting the file passed verification.
- **Sign entries or anchor the head externally.** Out of scope for a demonstration. The limitation is stated.
- **Suspend on the lower bound** (act only on proven failure). Rejected: the rule is meant to be precautionary. The minimum window limits false trips.
- **Keep the window after re-enabling.** Rejected: the monitor would suspend again on the outcomes that caused the suspension.

## Consequences

- A chain cannot reveal that its own tail was cut off. The head hash must be recorded somewhere else.
- Single writer, local file, no locking. Concurrent writers would corrupt the chain, and verification would then fail.
- The upper-bound rule is sensitive at small windows: with a window of 10 and zero failures the bound is already about 21%. Limits must be chosen with the minimum window in mind.
- Timestamps come from the clock, so the audit log is not reproducible. The gate result it refers to is.
