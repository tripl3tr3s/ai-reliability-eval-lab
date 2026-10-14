import { z } from "zod";
import { sha256Canonical, type AuditEvent } from "../audit/log.js";
import { wilsonInterval } from "../stats/index.js";

export const MonitorConfigSchema = z.object({
  /** Version of this rule, written to every audit entry it produces. */
  ruleVersion: z.string().min(1),
  /** Number of most recent outcomes considered. */
  windowSize: z.number().int().positive(),
  /** Outcomes required in the window before the rule may suspend. */
  minimumWindow: z.number().int().positive(),
  /** Suspend when the one-sided Wilson upper bound on the failure rate exceeds this value. */
  maxFailureUpperBound: z.number().gt(0).lt(1),
  confidence: z.number().gt(0.5).lt(1),
}).strict().refine((value) => value.minimumWindow <= value.windowSize, { message: "minimumWindow cannot exceed windowSize" });
export type MonitorConfig = z.infer<typeof MonitorConfigSchema>;

export type MonitorStatus = "ACTIVE" | "SUSPENDED";
export interface Outcome { readonly id: string; readonly failed: boolean }

export interface MonitorState {
  readonly status: MonitorStatus;
  readonly window: readonly Outcome[];
}

export interface MonitorStep {
  readonly state: MonitorState;
  /** False when the outcome arrived while suspended and was not counted. */
  readonly accepted: boolean;
  /** Present only when this step changed the status. */
  readonly transition: AuditEvent | null;
}

export const initialMonitorState = (): MonitorState => ({ status: "ACTIVE", window: [] });

export function failureUpperBound(window: readonly Outcome[], confidence: number): number | null {
  if (window.length === 0) return null;
  return wilsonInterval(window.filter(({ failed }) => failed).length, window.length, confidence, "upper").high;
}

/**
 * Adds one outcome to the rolling window and suspends when the failure-rate upper bound exceeds the limit.
 * The rule is precautionary: it acts when a high failure rate cannot be ruled out, which is why a
 * minimum window is required before it may trip.
 */
export function recordOutcome(state: MonitorState, outcome: Outcome, config: MonitorConfig): MonitorStep {
  if (state.status === "SUSPENDED") return { state, accepted: false, transition: null };
  const window = [...state.window, outcome].slice(-config.windowSize);
  const upperBound = failureUpperBound(window, config.confidence)!;
  if (window.length < config.minimumWindow || upperBound <= config.maxFailureUpperBound) {
    return { state: { status: "ACTIVE", window }, accepted: true, transition: null };
  }
  return {
    state: { status: "SUSPENDED", window },
    accepted: true,
    transition: {
      eventType: "suspended",
      ruleVersion: config.ruleVersion,
      dataHashes: { window: sha256Canonical(window) },
      details: {
        triggeredBy: outcome.id,
        windowLength: window.length,
        failures: window.filter(({ failed }) => failed).length,
        failureUpperBound: upperBound,
        limit: config.maxFailureUpperBound,
        confidence: config.confidence,
      },
    },
  };
}

/**
 * Manual re-enable. Requires a named owner and a reason, and clears the window so the decision
 * to resume rests on fresh evidence instead of the outcomes that caused the suspension.
 */
export function reenable(state: MonitorState, owner: string, reason: string, config: MonitorConfig): MonitorStep {
  if (state.status !== "SUSPENDED") throw new Error("Only a suspended monitor can be re-enabled");
  const trimmedOwner = owner.trim();
  const trimmedReason = reason.trim();
  if (trimmedOwner.length === 0) throw new Error("Re-enabling requires an explicit owner");
  if (trimmedReason.length === 0) throw new Error("Re-enabling requires a reason");
  return {
    state: initialMonitorState(),
    accepted: true,
    transition: {
      eventType: "reenabled",
      ruleVersion: config.ruleVersion,
      dataHashes: { clearedWindow: sha256Canonical(state.window) },
      details: { owner: trimmedOwner, reason: trimmedReason },
    },
  };
}

export interface AuditSink { append(event: AuditEvent): Promise<unknown> }

/** Holds monitor state and writes every status change to an audit sink before exposing it. */
export class SuspensionMonitor {
  private current: MonitorState = initialMonitorState();
  private readonly config: MonitorConfig;

  constructor(config: MonitorConfig, private readonly audit: AuditSink) {
    this.config = MonitorConfigSchema.parse(config);
  }

  get status(): MonitorStatus { return this.current.status; }

  async record(outcome: Outcome): Promise<MonitorStep> {
    return this.apply(recordOutcome(this.current, outcome, this.config));
  }

  async reenable(owner: string, reason: string): Promise<MonitorStep> {
    return this.apply(reenable(this.current, owner, reason, this.config));
  }

  private async apply(step: MonitorStep): Promise<MonitorStep> {
    if (step.transition) await this.audit.append(step.transition);
    this.current = step.state;
    return step;
  }
}
