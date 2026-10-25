import { z } from 'zod';

export const SideEffectClassSchema = z.enum(['read', 'simulated-write']);
export type SideEffectClass = z.infer<typeof SideEffectClassSchema>;

export const NormalizedMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  toolCallId: z.string().optional(),
});
export type NormalizedMessage = z.infer<typeof NormalizedMessageSchema>;

export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export const ModelToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});
export type ModelToolCall = z.infer<typeof ModelToolCallSchema>;

/** Reasoning depth for models that declare adaptive thinking. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export interface ModelResponse {
  readonly text: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly stopReason: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number };
  readonly modelId: string;
  readonly latencyMs: number;
  /**
   * Provider-native assistant blocks, returned only when the provider requires them to be replayed
   * unchanged on the next request (thinking blocks on adaptive-thinking models). Opaque to the runner.
   */
  readonly providerContent?: readonly unknown[];
  /** Provider refusal category when stopReason is the normalized refusal value. */
  readonly refusalCategory?: string | null;
}

export interface ModelRequest {
  readonly messages: readonly NormalizedMessage[];
  readonly tools: readonly ModelTool[];
  readonly model: string;
  readonly temperature?: number;
  /** Only valid for models whose capabilities declare adaptive thinking. */
  readonly effort?: Effort;
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
}

/**
 * Stop reasons every adapter must map its provider vocabulary onto. Other provider-specific
 * values may pass through unchanged, but these carry meaning for the runner.
 */
export const NORMALIZED_STOP_REASONS = { endTurn: "end_turn", toolUse: "tool_use", outputLimit: "max_tokens", refusal: "refusal" } as const;

/**
 * Why a run ended without a valid final result. Recorded on `bounded` and `failed` rows so the
 * report can separate availability limits from quality failures. Absent on runs that finished,
 * and on rows recorded before the field existed.
 *
 * Provider errors that are not deadlines are deliberately absent: they abort the experiment
 * instead of producing a row (see docs/postmortems/2026-09-01-full-benchmark-deadline-abort.md),
 * so an outage or an exhausted balance cannot be scored against whichever arm it hit.
 */
export const TERMINATION_REASONS = [
  "deadline",
  "cancelled",
  "output_limit",
  "token_ceiling",
  "cost_ceiling",
  "output_size",
  "tool_call_ceiling",
  "tool_not_allowed",
  "iteration_ceiling",
  "invalid_final_result",
  "refusal",
] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

/** What a model accepts, declared by its adapter so the runner holds no provider rules. */
export interface ModelCapabilities {
  readonly provider: string;
  /** False when the provider rejects a temperature for this model. */
  readonly acceptsTemperature: boolean;
  /** Temperature the benchmark pins for this model. Ignored when temperature is not accepted. */
  readonly defaultTemperature?: number;
  /** Output allowance for one call. The run-level token ceiling still applies. */
  readonly maxOutputTokensPerCall: number;
  readonly toolCalling: boolean;
  /** "prompt": final JSON is requested by instruction and validated by the runner. "json_schema": the provider can enforce a schema. */
  readonly structuredOutput: "prompt" | "json_schema";
  /** "adaptive": the model thinks by default, accepts an effort, and needs its assistant blocks replayed unchanged. */
  readonly thinking?: "adaptive";
}

export const PROVIDER_ERROR_CODES = ["rate_limit", "timeout", "auth", "invalid_request", "server", "aborted", "invalid_response", "unknown"] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/** Provider failure in a provider-neutral shape. The original error is kept as the cause. */
export class ModelProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly provider: string;
  readonly status: number | undefined;
  constructor(message: string, details: { code: ProviderErrorCode; provider: string; status?: number; cause?: unknown }) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "ModelProviderError";
    this.code = details.code;
    this.provider = details.provider;
    this.status = details.status;
    this.retryable = details.code === "rate_limit" || details.code === "timeout" || details.code === "server";
  }
}

export function providerErrorCodeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (status >= 400) return "invalid_request";
  return "unknown";
}

export interface ModelAdapter {
  generate(request: ModelRequest): Promise<ModelResponse>;
  /** Optional so simple test doubles stay valid. Without it the runner falls back to the provider registry. */
  capabilities?(model: string): ModelCapabilities;
}

/** Model ids for the roles the experiment needs. */
export interface ModelRoles {
  /** Executes multi-step, recovery, and write tasks, and every task in the direct arm. */
  readonly executor: string;
  /** Classifies the task in routed arms. */
  readonly router: string;
  /** Executes tasks the router labels simple and read-only. */
  readonly simpleExecutor: string;
}

export const ToolErrorSchema = z.object({
  code: z.enum(['TRANSIENT', 'TIMEOUT', 'RATE_LIMIT', 'INVALID_RESPONSE', 'NOT_FOUND', 'STALE', 'CONTRADICTION', 'POLICY']),
  message: z.string(),
  retryable: z.boolean(),
});

const EnvelopeMetadataSchema = z.object({
  evidenceId: z.string().min(1),
  provenance: z.string().min(1),
  freshAt: z.string().datetime(),
  idempotency: z.object({ key: z.string(), committed: z.boolean(), replayed: z.boolean() }).optional(),
});
export const ToolEnvelopeSchema = z.union([
  EnvelopeMetadataSchema.extend({ ok: z.literal(true), data: z.unknown() }).strict().superRefine((value, context) => {
    if (!Object.hasOwn(value, 'data')) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Successful envelopes require data' });
  }),
  EnvelopeMetadataSchema.extend({ ok: z.literal(false), error: ToolErrorSchema }).strict(),
]);
export type ToolEnvelope = z.infer<typeof ToolEnvelopeSchema>;

/** `TState` is owned by the domain pack that created the tools. The fiscal-v2 pack uses `CaseState`. */
export interface ToolContext<TState = CaseState> {
  readonly caseId: string;
  readonly seed: number;
  readonly invocation: number;
  readonly state: TState;
  readonly signal: AbortSignal;
}

export interface ToolDefinition<TInput = unknown, TState = CaseState> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly sideEffect: SideEffectClass;
  execute(input: TInput, context: ToolContext<TState>): Promise<ToolEnvelope>;
}

export interface CaseState {
  readonly followUps: Map<string, FollowUp>;
  readonly paymentMatches: Map<string, PaymentMatch>;
}

export interface FollowUp {
  readonly id: string;
  readonly supplierRfc: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface PaymentMatch {
  readonly paymentId: string;
  readonly documentId: string;
  readonly idempotencyKey: string;
}

export interface AgentPolicy {
  readonly maxIterations: number;
  readonly maxToolCalls: number;
  readonly toolTimeoutMs: number;
  readonly deadlineMs: number;
  readonly maxOutputBytes: number;
  readonly maxTokens: number;
  readonly maxCostUsd: number;
  readonly allowedTools: readonly string[];
}

export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  maxIterations: 6,
  maxToolCalls: 8,
  toolTimeoutMs: 5_000,
  deadlineMs: 60_000,
  maxOutputBytes: 64_000,
  maxTokens: 12_000,
  maxCostUsd: 1,
  allowedTools: [],
};

export interface EvidenceClaim { readonly claim: string; readonly evidenceIds: readonly string[] }
export interface AgentResult {
  readonly outcome: 'completed' | 'abstained' | 'bounded' | 'error';
  readonly answer: string;
  /** Projection of the pack's case state after the run. Its shape is defined by the domain pack. */
  readonly finalState: Readonly<Record<string, unknown>>;
  readonly claims: readonly EvidenceClaim[];
  readonly usage: { readonly tokens: number; readonly costUsd: number };
  readonly modelIds: readonly string[];
  readonly events: readonly RunnerEvent[];
  readonly latencyMs: number;
  /** Set when the run ended without a valid final result. */
  readonly terminationReason?: TerminationReason;
  /** Provider refusal category, when the provider gave one. */
  readonly refusalCategory?: string;
}

export interface RunnerEvent {
  readonly sequence: number;
  readonly type: 'model' | 'tool' | 'error' | 'complete' | 'score';
  readonly at: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface TelemetrySink { emit(event: RunnerEvent): void | Promise<void>; flush(): Promise<void> }

export interface ExperimentConfig {
  readonly dataset: string;
  readonly promptVersion: string;
  readonly resourceVersion: string | null;
  readonly models: Readonly<Record<string, string>>;
  readonly repeats: number;
  readonly seed: number;
  readonly pricingVersion: string;
  readonly concurrency: 1;
  readonly budgetUsd: number;
}
