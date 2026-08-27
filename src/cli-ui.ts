import { access, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { progress } from "@clack/prompts";

export const PROGRESS_MODES = ["auto", "plain", "quiet"] as const;
export type ProgressMode = (typeof PROGRESS_MODES)[number];
export type ResolvedProgressMode = "interactive" | Exclude<ProgressMode, "auto">;

export const INTERACTIVE_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;
export const INTERACTIVE_SPINNER_DELAY_MS = 70;

export const EXPERIMENT_PHASES = ["routing", "model", "tool", "scoring", "persistence"] as const;
export type ExperimentPhase = (typeof EXPERIMENT_PHASES)[number];
export type RunOutcome = "completed" | "abstained" | "bounded" | "failed";
export type ExperimentStatus = "completed" | "cancelled" | "failed";

export interface OutcomeCounts {
  readonly completed: number;
  readonly abstained: number;
  readonly bounded: number;
  readonly failed: number;
}

interface JobEventFields {
  readonly index: number;
  readonly totalJobs: number;
  readonly runId: string;
  readonly caseId: string;
  readonly configuration: string;
  readonly repeat: number;
}

export type CliProgressEvent =
  | {
      readonly type: "experiment_started";
      readonly totalJobs: number;
      readonly estimatedCostUsd: number;
      readonly budgetCeilingUsd: number;
    }
  | ({ readonly type: "job_started" } & JobEventFields)
  | ({ readonly type: "phase_changed"; readonly phase: ExperimentPhase; readonly observedCostUsd: number } & JobEventFields)
  | ({
      readonly type: "job_completed";
      readonly outcome: RunOutcome;
      readonly costUsd: number;
      readonly observedCostUsd: number;
      readonly durationMs: number;
      readonly elapsedMs: number;
    } & JobEventFields)
  | {
      readonly type: "experiment_completed";
      readonly status: ExperimentStatus;
      readonly completedJobs: number;
      readonly totalJobs: number;
      readonly observedCostUsd: number;
      readonly elapsedMs: number;
      readonly outcomes: OutcomeCounts;
    };

export interface CurrentJob {
  readonly index: number;
  readonly caseId: string;
  readonly configuration: string;
  readonly repeat: number;
  readonly phase: ExperimentPhase | "starting";
}

export interface ProgressSnapshot {
  readonly startedAtMs: number;
  readonly elapsedMs: number;
  readonly estimatedCostUsd: number;
  readonly budgetCeilingUsd: number;
  readonly observedCostUsd: number;
  readonly completedJobs: number;
  readonly totalJobs: number;
  readonly currentJob: CurrentJob | null;
  readonly etaMs: number | null;
  readonly outcomes: OutcomeCounts;
  readonly status: ExperimentStatus | "running";
}

export interface ArtifactPaths {
  readonly resultsPath: string;
  readonly eventsPath: string;
}

export interface OutputStream {
  write(chunk: string): unknown;
}

export interface ProgressControl {
  start(message?: string): void;
  advance(step?: number, message?: string): void;
  message(message?: string): void;
  stop(message?: string): void;
  cancel(message?: string): void;
  error(message?: string): void;
}

export interface ProgressRenderer {
  onEvent(event: CliProgressEvent): void;
  getSnapshot(): ProgressSnapshot;
}

const EMPTY_OUTCOMES: OutcomeCounts = { completed: 0, abstained: 0, bounded: 0, failed: 0 };

export function resolveProgressMode(input: {
  readonly requested: ProgressMode;
  readonly isTTY: boolean;
  readonly isCI: boolean;
  readonly noColor: boolean;
}): ResolvedProgressMode {
  if (input.requested !== "auto") return input.requested;
  return input.isTTY && !input.isCI && !input.noColor ? "interactive" : "plain";
}

export function isCiEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return [environment.CI, environment.GITHUB_ACTIONS].some(
    (value) => value !== undefined && value !== "" && value !== "0" && value.toLocaleLowerCase("en-US") !== "false",
  );
}

export function isNoColorEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return Object.prototype.hasOwnProperty.call(environment, "NO_COLOR");
}

export function initialProgressSnapshot(nowMs = Date.now()): ProgressSnapshot {
  return {
    startedAtMs: nowMs,
    elapsedMs: 0,
    estimatedCostUsd: 0,
    budgetCeilingUsd: 0,
    observedCostUsd: 0,
    completedJobs: 0,
    totalJobs: 0,
    currentJob: null,
    etaMs: null,
    outcomes: EMPTY_OUTCOMES,
    status: "running",
  };
}

export function reduceProgressSnapshot(
  snapshot: ProgressSnapshot,
  event: CliProgressEvent,
  nowMs = Date.now(),
): ProgressSnapshot {
  switch (event.type) {
    case "experiment_started":
      return {
        ...initialProgressSnapshot(nowMs),
        estimatedCostUsd: event.estimatedCostUsd,
        budgetCeilingUsd: event.budgetCeilingUsd,
        totalJobs: event.totalJobs,
      };
    case "job_started":
      return {
        ...snapshot,
        elapsedMs: elapsedSince(snapshot.startedAtMs, nowMs),
        totalJobs: event.totalJobs,
        currentJob: currentJobFrom(event, "starting"),
      };
    case "phase_changed":
      return {
        ...snapshot,
        elapsedMs: elapsedSince(snapshot.startedAtMs, nowMs),
        observedCostUsd: event.observedCostUsd,
        totalJobs: event.totalJobs,
        currentJob: currentJobFrom(event, event.phase),
      };
    case "job_completed": {
      const completedJobs = Math.max(snapshot.completedJobs, event.index);
      return {
        ...snapshot,
        elapsedMs: event.elapsedMs,
        observedCostUsd: event.observedCostUsd,
        completedJobs,
        totalJobs: event.totalJobs,
        currentJob: snapshot.currentJob ?? currentJobFrom(event, "persistence"),
        etaMs: estimateRemainingMs(event.elapsedMs, completedJobs, event.totalJobs),
        outcomes: incrementOutcome(snapshot.outcomes, event.outcome),
      };
    }
    case "experiment_completed":
      return {
        ...snapshot,
        elapsedMs: event.elapsedMs,
        observedCostUsd: event.observedCostUsd,
        completedJobs: event.completedJobs,
        totalJobs: event.totalJobs,
        etaMs: 0,
        outcomes: event.outcomes,
        status: event.status,
      };
    default:
      return assertNever(event);
  }
}

export function formatProgressSnapshot(snapshot: ProgressSnapshot, nowMs = Date.now()): string {
  const elapsedMs = snapshot.status === "running"
    ? Math.max(snapshot.elapsedMs, elapsedSince(snapshot.startedAtMs, nowMs))
    : snapshot.elapsedMs;
  const current = snapshot.currentJob === null
    ? "waiting"
    : `${safeLabel(snapshot.currentJob.caseId)} | ${safeLabel(snapshot.currentJob.configuration)} | repeat ${snapshot.currentJob.repeat + 1} | ${snapshot.currentJob.phase}`;
  const eta = snapshot.completedJobs === 0 || snapshot.etaMs === null
    ? "estimating"
    : formatDuration(snapshot.etaMs);
  const outcomes = snapshot.outcomes;
  return `[${snapshot.completedJobs}/${snapshot.totalJobs}] ${current} | elapsed ${formatDuration(elapsedMs)} | ETA ${eta} | cost ${formatObservedCost(snapshot.observedCostUsd, snapshot.budgetCeilingUsd)} | outcomes C:${outcomes.completed} A:${outcomes.abstained} B:${outcomes.bounded} F:${outcomes.failed}`;
}

export function formatRunSummary(snapshot: ProgressSnapshot, artifacts?: ArtifactPaths): string {
  const prefix = snapshot.status === "completed" ? "Run completed" : `Partial run ${snapshot.status}`;
  const outcomes = snapshot.outcomes;
  const lines = [
    `${prefix}: ${snapshot.completedJobs}/${snapshot.totalJobs} jobs | elapsed ${formatDuration(snapshot.elapsedMs)} | cost ${formatObservedCost(snapshot.observedCostUsd, snapshot.budgetCeilingUsd)} | outcomes completed=${outcomes.completed} abstained=${outcomes.abstained} bounded=${outcomes.bounded} failed=${outcomes.failed}`,
  ];
  if (artifacts) lines.push(`Results: ${safePath(artifacts.resultsPath)}`, `Events: ${safePath(artifacts.eventsPath)}`);
  return `${lines.join("\n")}\n`;
}

export function createProgressRenderer(options: {
  readonly mode: ResolvedProgressMode;
  readonly output: OutputStream;
  readonly artifacts?: ArtifactPaths;
  readonly now?: () => number;
  readonly createControl?: (max: number, output: OutputStream) => ProgressControl;
}): ProgressRenderer {
  const now = options.now ?? Date.now;
  let snapshot = initialProgressSnapshot(now());
  let control: ProgressControl | null = null;

  const onEvent = (event: CliProgressEvent): void => {
    const before = snapshot;
    snapshot = reduceProgressSnapshot(snapshot, event, now());
    if (options.mode === "quiet") {
      if (event.type === "experiment_completed") options.output.write(formatRunSummary(snapshot, options.artifacts));
      return;
    }
    if (options.mode === "plain") {
      const line = formatPlainEvent(event);
      if (line !== null) options.output.write(`${line}\n`);
      if (event.type === "experiment_completed") options.output.write(formatRunSummary(snapshot, options.artifacts));
      return;
    }

    if (event.type === "experiment_started") {
      control = (options.createControl ?? createClackControl)(event.totalJobs, options.output);
      control.start(formatProgressSnapshot(snapshot, now()));
      return;
    }
    if (event.type === "job_completed") {
      control?.advance(Math.max(0, snapshot.completedJobs - before.completedJobs), formatProgressSnapshot(snapshot, now()));
      return;
    }
    if (event.type === "experiment_completed") {
      const message = `Run ${event.status} after ${event.completedJobs}/${event.totalJobs} jobs`;
      if (event.status === "completed") control?.stop(message);
      else if (event.status === "cancelled") control?.cancel(message);
      else control?.error(message);
      options.output.write(formatRunSummary(snapshot, options.artifacts));
      return;
    }
    control?.message(formatProgressSnapshot(snapshot, now()));
  };

  return { onEvent, getSnapshot: () => snapshot };
}

export async function createInteractiveArtifactPaths(options: {
  readonly directory?: string;
  readonly now?: () => Date;
  readonly exists?: (path: string) => Promise<boolean>;
} = {}): Promise<ArtifactPaths> {
  const directory = options.directory ?? "runs";
  const timestamp = (options.now ?? (() => new Date()))().toISOString().replace(/[.:]/gu, "-");
  const exists = options.exists ?? pathExists;
  for (let collision = 0; ; collision += 1) {
    const suffix = collision === 0 ? timestamp : `${timestamp}-${collision}`;
    const candidate = {
      resultsPath: join(directory, `results-${suffix}.jsonl`),
      eventsPath: join(directory, `events-${suffix}.jsonl`),
    };
    const [resultsExist, eventsExist] = await Promise.all([
      exists(candidate.resultsPath),
      exists(candidate.eventsPath),
    ]);
    if (!resultsExist && !eventsExist) return candidate;
  }
}

export async function reserveInteractiveArtifactPaths(artifacts: ArtifactPaths): Promise<void> {
  await Promise.all([
    mkdir(dirname(artifacts.resultsPath), { recursive: true }),
    mkdir(dirname(artifacts.eventsPath), { recursive: true }),
  ]);
  let resultsHandle: FileHandle | undefined;
  let eventsHandle: FileHandle | undefined;
  let resultsCreated = false;
  let eventsCreated = false;
  try {
    resultsHandle = await open(artifacts.resultsPath, "wx");
    resultsCreated = true;
    await resultsHandle.close();
    resultsHandle = undefined;
    eventsHandle = await open(artifacts.eventsPath, "wx");
    eventsCreated = true;
    await eventsHandle.close();
    eventsHandle = undefined;
  } catch (error) {
    await Promise.allSettled([resultsHandle?.close(), eventsHandle?.close()]);
    await Promise.allSettled([
      ...(resultsCreated ? [unlink(artifacts.resultsPath)] : []),
      ...(eventsCreated ? [unlink(artifacts.eventsPath)] : []),
    ]);
    throw new Error("Unable to reserve unique interactive artifact paths", { cause: error });
  }
}

function createClackControl(max: number, output: OutputStream): ProgressControl {
  return progress({
    max,
    output: output as Writable,
    indicator: "timer",
    style: "heavy",
    frames: [...INTERACTIVE_SPINNER_FRAMES],
    delay: INTERACTIVE_SPINNER_DELAY_MS,
  });
}

function formatPlainEvent(event: CliProgressEvent): string | null {
  switch (event.type) {
    case "experiment_started":
      return `[start] jobs=${event.totalJobs} estimate=${formatUsd(event.estimatedCostUsd, 2)} ceiling=${formatUsd(event.budgetCeilingUsd, 2)}`;
    case "job_started":
      return `[${event.index}/${event.totalJobs}] start case=${safeLabel(event.caseId)} configuration=${safeLabel(event.configuration)} repeat=${event.repeat + 1}`;
    case "phase_changed":
      return `[${event.index}/${event.totalJobs}] phase=${event.phase} case=${safeLabel(event.caseId)} configuration=${safeLabel(event.configuration)} repeat=${event.repeat + 1} total=${formatUsd(event.observedCostUsd, 4)}`;
    case "job_completed":
      return `[${event.index}/${event.totalJobs}] complete outcome=${event.outcome} duration=${formatDuration(event.durationMs)} cost=${formatUsd(event.costUsd, 4)} total=${formatUsd(event.observedCostUsd, 4)}`;
    case "experiment_completed":
      return null;
    default:
      return assertNever(event);
  }
}

function currentJobFrom(event: JobEventFields, phase: CurrentJob["phase"]): CurrentJob {
  return {
    index: event.index,
    caseId: safeLabel(event.caseId),
    configuration: safeLabel(event.configuration),
    repeat: event.repeat,
    phase,
  };
}

function incrementOutcome(outcomes: OutcomeCounts, outcome: RunOutcome): OutcomeCounts {
  return { ...outcomes, [outcome]: outcomes[outcome] + 1 };
}

function estimateRemainingMs(elapsedMs: number, completedJobs: number, totalJobs: number): number | null {
  if (completedJobs <= 0) return null;
  return Math.max(0, Math.round(elapsedMs / completedJobs * Math.max(0, totalJobs - completedJobs)));
}

function elapsedSince(startedAtMs: number, nowMs: number): number {
  return Math.max(0, nowMs - startedAtMs);
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatObservedCost(observedCostUsd: number, budgetCeilingUsd: number): string {
  return `${formatUsd(observedCostUsd, 4)}/${formatUsd(budgetCeilingUsd, 2)}`;
}

function formatUsd(value: number, digits: number): string {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  return `$${safeValue.toFixed(digits)}`;
}

function safeLabel(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint >= 127 && codePoint <= 159 ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
}

function safePath(value: string): string {
  return safeLabel(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled progress event: ${String(value)}`);
}
