import type { DatasetCaseV3 } from "../../../dataset.js";
import { abstention } from "./abstention.js";
import { defineCase } from "./builder.js";
import { confirmation } from "./confirmation.js";
import { lookups } from "./lookups.js";
import { multi } from "./multi.js";
import { recovery } from "./recovery.js";

/** All 90 dataset v3 cases in published order: lookups, multi-tool, recovery, abstention, confirmation. */
export function buildV3Cases(): readonly DatasetCaseV3[] {
  return [...lookups, ...multi, ...recovery, ...abstention, ...confirmation].map((spec, index) => defineCase(index + 1, spec));
}

/** The exact cases.jsonl text: one JSON object per line, trailing newline. */
export function serializeCases(cases: readonly DatasetCaseV3[]): string {
  return `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`;
}
