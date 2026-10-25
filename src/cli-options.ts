import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

export const CLI_USAGE = "Usage: reliability-lab <validate-dataset|validate-config|run|report|gate|mock-run|audit-verify|suspension-demo|scoring-contract|report-check|scorer-audit-sample|scorer-audit-score>";

const ProgressModeSchema = z.enum(["auto", "plain", "quiet"]);
export type ProgressMode = z.infer<typeof ProgressModeSchema>;

export const CliPathSchema = z.string().trim().min(1).max(4_096).refine(
  (value) => !hasControlCharacters(value),
  "Paths cannot contain control characters",
);

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint >= 127 && codePoint <= 159;
  });
}

export function validateRunArtifactPaths(resultsPath: string, eventsPath: string): void {
  if (resolve(resultsPath) === resolve(eventsPath)) {
    throw new Error("Result and telemetry paths must be different files");
  }
}

export async function validateRunArtifactTargets(resultsPath: string, eventsPath: string): Promise<void> {
  validateRunArtifactPaths(resultsPath, eventsPath);
  const [resultsStat, eventsStat] = await Promise.all([statIfExists(resultsPath), statIfExists(eventsPath)]);
  if (resultsStat && eventsStat && resultsStat.dev === eventsStat.dev && resultsStat.ino === eventsStat.ino) {
    throw new Error("Result and telemetry paths must be different files");
  }
  const [canonicalResults, canonicalEvents] = await Promise.all([
    canonicalTarget(resultsPath),
    canonicalTarget(eventsPath),
  ]);
  if (canonicalResults === canonicalEvents) {
    throw new Error("Result and telemetry paths must be different files");
  }
}

async function statIfExists(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function canonicalTarget(path: string): Promise<string> {
  let candidate = resolve(path);
  let suffix: string[] = [];
  for (;;) {
    try {
      return join(await realpath(candidate), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return join(candidate, ...suffix);
      suffix = [basename(candidate), ...suffix];
      candidate = parent;
    }
  }
}

export type CliArguments =
  | { readonly command: "validate-dataset"; readonly manifestPath?: string }
  | { readonly command: "validate-config"; readonly configPath?: string }
  | {
      readonly command: "run";
      readonly configPath?: string;
      readonly outputPath?: string;
      readonly eventsPath?: string;
      readonly interactive: boolean;
      readonly progress: ProgressMode;
    }
  | {
      readonly command: "report";
      readonly rawPath?: string;
      readonly outputPath?: string;
      readonly configPath?: string;
      readonly eventsPath?: string;
    }
  | {
      readonly command: "gate";
      readonly rawPath?: string;
      readonly configPath?: string;
      readonly thresholdsPath?: string;
      readonly candidate?: string;
      readonly reference?: string;
      readonly baselinePath?: string;
      readonly outputPath?: string;
      readonly auditLogPath?: string;
    }
  | { readonly command: "audit-verify"; readonly logPath: string; readonly expectedHeadHash?: string }
  | { readonly command: "suspension-demo"; readonly logPath?: string }
  | { readonly command: "scoring-contract"; readonly write: false }
  | { readonly command: "scoring-contract"; readonly write: true; readonly rationale: string }
  | { readonly command: "report-check"; readonly summaryPath: string }
  | {
      readonly command: "scorer-audit-sample";
      readonly rawPath: string;
      readonly configPath?: string;
      readonly outputPath?: string;
      readonly perStratum?: number;
      readonly seed?: number;
    }
  | { readonly command: "scorer-audit-score"; readonly keyPath: string; readonly labelsPath: string; readonly outputPath: string }
  | {
      readonly command: "mock-run";
      readonly configPath?: string;
      readonly outputPath?: string;
      readonly profile: "clean" | "regressed";
    };

const ConfigurationNameSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u, "Configuration names use lowercase letters, digits, and hyphens");

const RunValuesSchema = z.object({
  config: CliPathSchema.optional(),
  output: CliPathSchema.optional(),
  events: CliPathSchema.optional(),
  interactive: z.boolean(),
  progress: ProgressModeSchema,
}).strict();

export function parseCliArguments(argv: readonly string[]): CliArguments {
  const [command, ...arguments_] = argv;
  if (command === "run") {
    const parsed = parseArgs({
      args: arguments_,
      allowPositionals: false,
      strict: true,
      options: {
        config: { type: "string" },
        output: { type: "string" },
        events: { type: "string" },
        interactive: { type: "boolean", default: false },
        progress: { type: "string", default: "auto" },
      },
    });
    const values = RunValuesSchema.parse(parsed.values);
    return {
      command,
      interactive: values.interactive,
      progress: values.progress,
      ...(values.config === undefined ? {} : { configPath: values.config }),
      ...(values.output === undefined ? {} : { outputPath: values.output }),
      ...(values.events === undefined ? {} : { eventsPath: values.events }),
    };
  }
  if (command === "validate-dataset") {
    const { values } = parseArgs({
      args: arguments_,
      allowPositionals: false,
      strict: true,
      options: { manifest: { type: "string" } },
    });
    const parsed = z.object({ manifest: CliPathSchema.optional() }).strict().parse(values);
    return { command, ...(parsed.manifest === undefined ? {} : { manifestPath: parsed.manifest }) };
  }
  if (command === "validate-config") {
    const { values } = parseArgs({
      args: arguments_,
      allowPositionals: false,
      strict: true,
      options: { config: { type: "string" } },
    });
    const parsed = z.object({ config: CliPathSchema.optional() }).strict().parse(values);
    return { command, ...(parsed.config === undefined ? {} : { configPath: parsed.config }) };
  }
  if (command === "report") {
    const { values } = parseArgs({
      args: arguments_,
      allowPositionals: false,
      strict: true,
      options: {
        raw: { type: "string" },
        output: { type: "string" },
        config: { type: "string" },
        events: { type: "string" },
      },
    });
    const parsed = z.object({
      raw: CliPathSchema.optional(),
      output: CliPathSchema.optional(),
      config: CliPathSchema.optional(),
      events: CliPathSchema.optional(),
    }).strict().parse(values);
    return {
      command,
      ...(parsed.raw === undefined ? {} : { rawPath: parsed.raw }),
      ...(parsed.output === undefined ? {} : { outputPath: parsed.output }),
      ...(parsed.config === undefined ? {} : { configPath: parsed.config }),
      ...(parsed.events === undefined ? {} : { eventsPath: parsed.events }),
    };
  }
  if (command === "gate") {
    const { values } = parseArgs({
      args: arguments_,
      allowPositionals: false,
      strict: true,
      options: {
        raw: { type: "string" },
        config: { type: "string" },
        thresholds: { type: "string" },
        candidate: { type: "string" },
        reference: { type: "string" },
        baseline: { type: "string" },
        output: { type: "string" },
        "audit-log": { type: "string" },
      },
    });
    const parsed = z.object({
      raw: CliPathSchema.optional(),
      config: CliPathSchema.optional(),
      thresholds: CliPathSchema.optional(),
      candidate: ConfigurationNameSchema.optional(),
      reference: ConfigurationNameSchema.optional(),
      baseline: CliPathSchema.optional(),
      output: CliPathSchema.optional(),
      "audit-log": CliPathSchema.optional(),
    }).strict().parse(values);
    return {
      command,
      ...(parsed.raw === undefined ? {} : { rawPath: parsed.raw }),
      ...(parsed.config === undefined ? {} : { configPath: parsed.config }),
      ...(parsed.thresholds === undefined ? {} : { thresholdsPath: parsed.thresholds }),
      ...(parsed.candidate === undefined ? {} : { candidate: parsed.candidate }),
      ...(parsed.reference === undefined ? {} : { reference: parsed.reference }),
      ...(parsed.baseline === undefined ? {} : { baselinePath: parsed.baseline }),
      ...(parsed.output === undefined ? {} : { outputPath: parsed.output }),
      ...(parsed["audit-log"] === undefined ? {} : { auditLogPath: parsed["audit-log"] }),
    };
  }
  if (command === "audit-verify") {
    const { values } = parseArgs({ args: arguments_, allowPositionals: false, strict: true, options: { log: { type: "string" }, head: { type: "string" } } });
    const parsed = z.object({ log: CliPathSchema, head: z.string().regex(/^[a-f0-9]{64}$/u, "Head must be a sha256 hex digest").optional() }).strict().parse(values);
    return { command, logPath: parsed.log, ...(parsed.head === undefined ? {} : { expectedHeadHash: parsed.head }) };
  }
  if (command === "suspension-demo") {
    const { values } = parseArgs({ args: arguments_, allowPositionals: false, strict: true, options: { log: { type: "string" } } });
    const parsed = z.object({ log: CliPathSchema.optional() }).strict().parse(values);
    return { command, ...(parsed.log === undefined ? {} : { logPath: parsed.log }) };
  }
  if (command === "scoring-contract") {
    const { values } = parseArgs({ args: arguments_, allowPositionals: false, strict: true, options: { write: { type: "boolean", default: false }, rationale: { type: "string" } } });
    const parsed = z.object({ write: z.boolean(), rationale: z.string().trim().min(20).max(1_000).optional() }).strict().parse(values);
    if (!parsed.write) {
      if (parsed.rationale !== undefined) throw new Error("--rationale is only used with --write");
      return { command, write: false };
    }
    if (parsed.rationale === undefined) throw new Error("--write needs --rationale explaining why the scoring contract changed");
    return { command, write: true, rationale: parsed.rationale };
  }
  if (command === "report-check") {
    const { values } = parseArgs({ args: arguments_, allowPositionals: false, strict: true, options: { summary: { type: "string" } } });
    const parsed = z.object({ summary: CliPathSchema }).strict().parse(values);
    return { command, summaryPath: parsed.summary };
  }
  if (command === "scorer-audit-sample") {
    const { values } = parseArgs({
      args: arguments_,
      allowPositionals: false,
      strict: true,
      options: { raw: { type: "string" }, config: { type: "string" }, output: { type: "string" }, "per-stratum": { type: "string" }, seed: { type: "string" } },
    });
    const parsed = z.object({
      raw: CliPathSchema,
      config: CliPathSchema.optional(),
      output: CliPathSchema.optional(),
      "per-stratum": z.coerce.number().int().min(1).max(500).optional(),
      seed: z.coerce.number().int().min(0).max(2 ** 32 - 1).optional(),
    }).strict().parse(values);
    return {
      command,
      rawPath: parsed.raw,
      ...(parsed.config === undefined ? {} : { configPath: parsed.config }),
      ...(parsed.output === undefined ? {} : { outputPath: parsed.output }),
      ...(parsed["per-stratum"] === undefined ? {} : { perStratum: parsed["per-stratum"] }),
      ...(parsed.seed === undefined ? {} : { seed: parsed.seed }),
    };
  }
  if (command === "scorer-audit-score") {
    const { values } = parseArgs({ args: arguments_, allowPositionals: false, strict: true, options: { key: { type: "string" }, labels: { type: "string" }, output: { type: "string" } } });
    const parsed = z.object({ key: CliPathSchema, labels: CliPathSchema, output: CliPathSchema }).strict().parse(values);
    return { command, keyPath: parsed.key, labelsPath: parsed.labels, outputPath: parsed.output };
  }
  if (command === "mock-run") {
    const { values } = parseArgs({
      args: arguments_,
      allowPositionals: false,
      strict: true,
      options: {
        config: { type: "string" },
        output: { type: "string" },
        profile: { type: "string", default: "clean" },
      },
    });
    const parsed = z.object({
      config: CliPathSchema.optional(),
      output: CliPathSchema.optional(),
      profile: z.enum(["clean", "regressed"]),
    }).strict().parse(values);
    return {
      command,
      profile: parsed.profile,
      ...(parsed.config === undefined ? {} : { configPath: parsed.config }),
      ...(parsed.output === undefined ? {} : { outputPath: parsed.output }),
    };
  }
  throw new Error(CLI_USAGE);
}
