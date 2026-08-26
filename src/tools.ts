import { analyzeProximity, detectCarousels } from 'efos-risk-graph';
import { z } from 'zod';
import type { CaseState, ToolContext, ToolDefinition, ToolEnvelope } from './contracts.js';
import { ToolEnvelopeSchema } from './contracts.js';
import { buildDemoGraph, DEMO_ROOT, demoWeightOf, documents, FIXTURE_TIMESTAMP, operationalPolicies, payments, supplierStatuses } from './fixtures.js';
import type { FaultKind } from './faults.js';

const envelope = (tool: string, context: ToolContext, data: unknown, idempotency?: ToolEnvelope['idempotency'], freshAt = FIXTURE_TIMESTAMP): ToolEnvelope => ToolEnvelopeSchema.parse({ ok: true, data, evidenceId: `${context.caseId}:${tool}:${context.invocation}`, provenance: 'synthetic:v2', freshAt, ...(idempotency ? { idempotency } : {}) });
const failure = (tool: string, context: ToolContext, code: 'TRANSIENT' | 'TIMEOUT' | 'RATE_LIMIT' | 'INVALID_RESPONSE' | 'NOT_FOUND' | 'STALE' | 'CONTRADICTION', retryable: boolean): ToolEnvelope => ToolEnvelopeSchema.parse({ ok: false, error: { code, message: `${tool} injected ${code.toLowerCase()}`, retryable }, evidenceId: `${context.caseId}:${tool}:${context.invocation}`, provenance: 'synthetic:v2', freshAt: FIXTURE_TIMESTAMP });

function applyFault(tool: string, context: ToolContext, fault: FaultKind | null): ToolEnvelope | null {
  if (!fault || fault === 'response-loss-after-write' || fault === 'stale' || fault === 'contradiction' || fault === 'schema-invalid' || fault === 'timeout') return null;
  const map = { transient: ['TRANSIENT', true], 'rate-limit': ['RATE_LIMIT', true], 'not-found': ['NOT_FOUND', false] } as const;
  const pair = map[fault];
  return failure(tool, context, pair[0], pair[1]);
}

export type FaultResolver = (tool: string, context: ToolContext) => FaultKind | null;

export function createSyntheticTools(resolveFault: FaultResolver = () => null): readonly ToolDefinition[] {
  const followUpSchema = z.object({ supplierRfc: z.string().min(1), reason: z.string().min(1), idempotencyKey: z.string().min(1) });
  const paymentMatchSchema = z.object({ paymentId: z.string().min(1), documentId: z.string().min(1), idempotencyKey: z.string().min(1) });
  const define = <T>(name: string, description: string, inputSchema: z.ZodType<T>, sideEffect: 'read' | 'simulated-write', execute: (input: T, context: ToolContext) => unknown): ToolDefinition<T> => ({
    name, description, inputSchema, sideEffect,
    async execute(raw, context) {
      const input = inputSchema.parse(raw);
      const fault = resolveFault(name, context);
      const injected = applyFault(name, context, fault);
      if (injected) return injected;
      if (fault === 'timeout') await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      if (fault === 'schema-invalid') return { ok: true, data: 'malformed' } as ToolEnvelope;
      const value = execute(input, context);
      if (fault === 'response-loss-after-write') return failure(name, context, 'TRANSIENT', true);
      if (fault === 'contradiction') return envelope(name, context, { primary: value, contradictory: contradictoryValue(value), contradictionDetected: true });
      return envelope(name, context, value, undefined, fault === 'stale' ? '2020-01-01T00:00:00.000Z' : FIXTURE_TIMESTAMP);
    },
  });

  return [
    define('search_documents', 'Search synthetic fiscal documents', z.object({ query: z.string().min(1).optional(), supplierRfc: z.string().optional(), documentType: z.string().min(1).optional() }), 'read', (input) => documents.filter((item) => (!input.supplierRfc || item.supplierRfc === input.supplierRfc) && (!input.documentType || item.type === input.documentType) && (!input.query || JSON.stringify(item).toLowerCase().includes(input.query.toLowerCase())))),
    define('get_document', 'Get one document', z.object({ documentId: z.string().min(1) }), 'read', (input) => documents.find((item) => item.id === input.documentId) ?? null),
    define('list_payments', 'List payments', z.object({ documentId: z.string().min(1).optional(), supplierRfc: z.string().optional(), unmatchedOnly: z.boolean().default(false) }), 'read', (input) => payments.filter((item) => (!input.documentId || item.documentId === input.documentId) && (!input.supplierRfc || item.supplierRfc === input.supplierRfc) && (!input.unmatchedOnly || item.matchedDocumentId === null))),
    {
      name: 'match_payment', description: 'Idempotently simulate matching a payment to a document', inputSchema: paymentMatchSchema, sideEffect: 'simulated-write',
      async execute(raw, context) {
        const input = paymentMatchSchema.parse(raw);
        const existing = context.state.paymentMatches.get(input.idempotencyKey);
        if (existing) return envelope('match_payment', context, existing, { key: input.idempotencyKey, committed: true, replayed: true });
        const fault = resolveFault('match_payment', context);
        const injected = applyFault('match_payment', context, fault);
        if (injected) return injected;
        if (fault === 'timeout') { await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true })); return failure('match_payment', context, 'TIMEOUT', true); }
        if (fault === 'schema-invalid') return { ok: true, data: 'malformed' } as ToolEnvelope;
        if (!payments.some((item) => item.id === input.paymentId) || !documents.some((item) => item.id === input.documentId)) return failure('match_payment', context, 'NOT_FOUND', false);
        const match = { ...input };
        context.state.paymentMatches.set(input.idempotencyKey, match);
        if (fault === 'response-loss-after-write') return failure('match_payment', context, 'TRANSIENT', true);
        if (fault === 'contradiction') return envelope('match_payment', context, { primary: match, contradictory: match, contradictionDetected: true }, { key: input.idempotencyKey, committed: true, replayed: false });
        return envelope('match_payment', context, match, { key: input.idempotencyKey, committed: true, replayed: false }, fault === 'stale' ? '2020-01-01T00:00:00.000Z' : FIXTURE_TIMESTAMP);
      },
    },
    define('check_supplier_status', 'Check synthetic SAT status', z.object({ rfc: z.string().min(1) }), 'read', (input) => ({ rfc: input.rfc, status: supplierStatuses[input.rfc] ?? 'unlisted' })),
    define('analyze_supplier_network', 'Analyze EFOS propagation and billing carousels', z.object({ rfc: z.string().min(1), maxDepth: z.number().int().min(1).max(6).default(3) }), 'read', (input) => { const graph = buildDemoGraph(); const graphRfc = input.rfc === 'CLI010101AA1' ? input.rfc : DEMO_ROOT; return { rfc: input.rfc, assessment: input.rfc === 'RFC30' ? 'conflicting network risk evidence; insufficient evidence of fraud' : 'network risk signal detected; review required', proximity: analyzeProximity(graph, graphRfc, demoWeightOf, { maxDepth: input.maxDepth ?? 3 }), carousels: detectCarousels(graph) }; }),
    define('get_operational_policy', 'Read an operational policy', z.object({ policyId: z.enum(['supplier-risk', 'payment-reconciliation']) }), 'read', (input) => operationalPolicies[input.policyId]),
    {
      name: 'create_follow_up', description: 'Create an idempotent simulated follow-up', inputSchema: followUpSchema, sideEffect: 'simulated-write',
      async execute(raw, context) {
        const input = followUpSchema.parse(raw);
        const existing = context.state.followUps.get(input.idempotencyKey);
        if (existing) return envelope('create_follow_up', context, existing, { key: input.idempotencyKey, committed: true, replayed: true });
        const fault = resolveFault('create_follow_up', context);
        const injected = applyFault('create_follow_up', context, fault);
        if (injected) return injected;
        if (fault === 'timeout') { await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true })); return failure('create_follow_up', context, 'TIMEOUT', true); }
        if (fault === 'schema-invalid') return { ok: true, data: 'malformed' } as ToolEnvelope;
        const followUp = { id: `FU-${context.state.followUps.size + 1}`, ...input };
        context.state.followUps.set(input.idempotencyKey, followUp);
        if (fault === 'response-loss-after-write') return failure('create_follow_up', context, 'TRANSIENT', true);
        if (fault === 'contradiction') return envelope('create_follow_up', context, { primary: followUp, contradictory: followUp, contradictionDetected: true }, { key: input.idempotencyKey, committed: true, replayed: false });
        return envelope('create_follow_up', context, followUp, { key: input.idempotencyKey, committed: true, replayed: false }, fault === 'stale' ? '2020-01-01T00:00:00.000Z' : FIXTURE_TIMESTAMP);
      },
    },
  ];
}

export function createCaseState(): CaseState { return { followUps: new Map(), paymentMatches: new Map() }; }

function contradictoryValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return { ...value, status: 'conflicting synthetic status' };
  }
  return { conflictingWith: value };
}
