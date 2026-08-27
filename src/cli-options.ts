import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

export const CLI_USAGE = "Usage: reliability-lab <validate-dataset|validate-config|run|report>";

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
    };

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
      },
    });
    const parsed = z.object({
      raw: CliPathSchema.optional(),
      output: CliPathSchema.optional(),
      config: CliPathSchema.optional(),
    }).strict().parse(values);
    return {
      command,
      ...(parsed.raw === undefined ? {} : { rawPath: parsed.raw }),
      ...(parsed.output === undefined ? {} : { outputPath: parsed.output }),
      ...(parsed.config === undefined ? {} : { configPath: parsed.config }),
    };
  }
  throw new Error(CLI_USAGE);
}
