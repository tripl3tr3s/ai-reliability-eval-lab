import type { DatasetCase } from "../dataset.js";
import { fiscalV2Pack } from "./fiscal-v2/index.js";
import { satV3Pack } from "./sat-v3/index.js";
import type { DomainPack } from "./types.js";

/** Domain pack that serves a dataset version: fiscal-v2 for v1 and v2, sat-v3 for v3. */
export function packForDatasetVersion(version: string): DomainPack<unknown> {
  if (version === "v1" || version === "v2") return fiscalV2Pack as DomainPack<unknown>;
  if (version === "v3") return satV3Pack as DomainPack<unknown>;
  throw new Error(`No domain pack serves dataset version ${version}`);
}

/** Domain pack that serves one case, read from the version prefix of its id. */
export function packForCase(datasetCase: DatasetCase): DomainPack<unknown> {
  return packForDatasetVersion(datasetCase.id.split("-", 1)[0]!);
}

/** Names of the pack's tools that simulate a write. */
export function writeToolNames(pack: DomainPack<unknown>): ReadonlySet<string> {
  return new Set(pack.createTools().filter(({ sideEffect }) => sideEffect === "simulated-write").map(({ name }) => name));
}
