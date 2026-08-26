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

export interface ModelResponse {
  readonly text: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly stopReason: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number };
  readonly modelId: string;
  readonly latencyMs: number;
}

export interface ModelRequest {
  readonly messages: readonly NormalizedMessage[];
  readonly tools: readonly ModelTool[];
  readonly model: string;
  readonly temperature?: number;
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
}

export interface ModelAdapter {
  generate(request: ModelRequest): Promise<ModelResponse>;
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

export interface ToolContext {
  readonly caseId: string;
  readonly seed: number;
  readonly invocation: number;
  readonly state: CaseState;
  readonly signal: AbortSignal;
}

export interface ToolDefinition<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly sideEffect: SideEffectClass;
  execute(input: TInput, context: ToolContext): Promise<ToolEnvelope>;
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
  readonly finalState: { readonly followUps: readonly FollowUp[]; readonly matchedPayments: Readonly<Record<string, string>> };
  readonly claims: readonly EvidenceClaim[];
  readonly usage: { readonly tokens: number; readonly costUsd: number };
  readonly modelIds: readonly string[];
  readonly events: readonly RunnerEvent[];
  readonly latencyMs: number;
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
