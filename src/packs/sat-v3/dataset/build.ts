import { writeFile } from "node:fs/promises";
import { sha256 } from "../../../dataset.js";
import { buildV3Cases, serializeCases } from "./index.js";

/** Writes datasets/v3/cases.jsonl and its manifest. Run with `pnpm dataset:build:v3`. */
const text = serializeCases(buildV3Cases());
await writeFile("datasets/v3/cases.jsonl", text, "utf8");
await writeFile("datasets/v3/manifest.json", `${JSON.stringify({ version: "v3", caseFile: "cases.jsonl", caseCount: buildV3Cases().length, sha256: sha256(text) }, null, 2)}\n`, "utf8");
process.stdout.write(`Wrote ${buildV3Cases().length} cases (${sha256(text)})\n`);
