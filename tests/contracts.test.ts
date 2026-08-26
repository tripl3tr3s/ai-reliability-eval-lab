import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_POLICY, ToolEnvelopeSchema } from '../src/contracts.js';

describe('contracts', () => {
  it('uses the required default ceilings', () => { expect(DEFAULT_AGENT_POLICY.maxIterations).toBe(6); expect(DEFAULT_AGENT_POLICY.maxToolCalls).toBe(8); });
  it('rejects ambiguous envelopes', () => { expect(() => ToolEnvelopeSchema.parse({ ok: true, error: { code: 'TRANSIENT', message: 'x', retryable: true }, evidenceId: 'e', provenance: 'p', freshAt: new Date().toISOString() })).toThrow(); });
});
