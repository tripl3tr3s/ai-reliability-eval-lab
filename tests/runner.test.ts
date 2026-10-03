import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ModelAdapter, ModelResponse } from '../src/contracts.js';
import { DEFAULT_AGENT_POLICY } from '../src/contracts.js';
import { runAgent } from '../src/runner.js';
import { createSyntheticTools } from '../src/tools.js';
import { ANTHROPIC_MODELS } from '../src/adapter.js';

const response = (value: Partial<ModelResponse>): ModelResponse => ({ text: '', toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 }, modelId: ANTHROPIC_MODELS.sonnet, latencyMs: 1, ...value });
describe('bounded runner', () => {
  it('executes a tool and returns evidence-linked claims', async () => { const queue = [response({ toolCalls: [{ id: '1', name: 'get_document', input: { documentId: 'INV-001' } }] }), response({ text: JSON.stringify({ outcome: 'completed', answer: 'Found', claims: [{ claim: 'Found invoice', evidenceIds: ['case:get_document:1'] }] }) })]; const adapter: ModelAdapter = { async generate() { return queue.shift()!; } }; const result = await runAgent({ caseId: 'case', seed: 1, prompt: 'find', systemPrompt: 'test', model: ANTHROPIC_MODELS.sonnet, adapter, tools: createSyntheticTools(), policy: { ...DEFAULT_AGENT_POLICY, allowedTools: ['get_document'] } }); expect(result.outcome).toBe('completed'); expect(result.events.some((event) => event.type === 'tool')).toBe(true); });
  it('omits temperature for Sonnet 5 and retains temperature zero for Haiku execution', async () => {
    const temperatures: Array<number | undefined> = [];
    const adapter: ModelAdapter = { async generate(request) { temperatures.push(request.temperature); return response({ text: JSON.stringify({ outcome: 'completed', answer: 'Done', claims: [] }), modelId: request.model }); } };
    const base = { caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', adapter, tools: [], policy: { ...DEFAULT_AGENT_POLICY, allowedTools: [] } };
    await runAgent({ ...base, model: ANTHROPIC_MODELS.sonnet });
    await runAgent({ ...base, model: ANTHROPIC_MODELS.haiku });
    expect(temperatures).toEqual([undefined, 0]);
  });
  it('allows up to 8192 output tokens for Sonnet 5 within the run token ceiling', async () => {
    const limits: number[] = [];
    const adapter: ModelAdapter = { async generate(request) { limits.push(request.maxOutputTokens); return response({ text: JSON.stringify({ outcome: 'completed', answer: 'Done', claims: [] }) }); } };
    await runAgent({ caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', model: ANTHROPIC_MODELS.sonnet, adapter, tools: [], policy: { ...DEFAULT_AGENT_POLICY, allowedTools: [] } });
    expect(limits).toEqual([8_192]);
  });
  it('returns a bounded result when Sonnet 5 reaches its per-call output limit', async () => {
    const adapter: ModelAdapter = { async generate() { return response({ stopReason: 'max_tokens', text: 'truncated' }); } };
    const result = await runAgent({ caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', model: ANTHROPIC_MODELS.sonnet, adapter, tools: [], policy: { ...DEFAULT_AGENT_POLICY, allowedTools: [] } });
    expect(result.outcome).toBe('bounded');
    expect(result.answer).toContain('output token limit');
  });
  it('allows only one final repair', async () => { let calls = 0; const adapter: ModelAdapter = { async generate() { calls += 1; return response({ text: 'invalid' }); } }; const result = await runAgent({ caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', model: 'm', adapter, tools: [], policy: { ...DEFAULT_AGENT_POLICY, allowedTools: [] } }); expect(result.outcome).toBe('error'); expect(calls).toBe(2); });
  it('accepts one JSON Markdown fence around an otherwise valid final result', async () => {
    const adapter: ModelAdapter = { async generate() { return response({ text: '```json\n{"outcome":"completed","answer":"Done","claims":[]}\n```' }); } };
    const result = await runAgent({ caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', model: 'm', adapter, tools: [], policy: { ...DEFAULT_AGENT_POLICY, allowedTools: [] } });
    expect(result.outcome).toBe('completed');
  });
  it('repairs a realistic wrong claim shape with exact schema guidance and diagnostics', async () => {
    const seen: string[] = [];
    let call = 0;
    const adapter: ModelAdapter = {
      async generate(request) {
        seen.push(request.messages.at(-1)?.content ?? '');
        call += 1;
        return call === 1
          ? response({ text: JSON.stringify({ outcome: 'completed', answer: 'Done', claims: [{ text: 'Done', evidenceIds: [] }] }) })
          : response({ text: JSON.stringify({ outcome: 'completed', answer: 'Done', claims: [{ claim: 'Done', evidenceIds: [] }] }) });
      },
    };
    const result = await runAgent({ caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', model: 'm', adapter, tools: [], policy: { ...DEFAULT_AGENT_POLICY, allowedTools: [] } });
    expect(result.outcome).toBe('completed');
    expect(seen[1]).toContain('claims');
    expect(seen[1]).toContain('claim');
    expect(seen[1]).toContain('Required');
    expect(seen[1]).toContain('no Markdown fences');
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'error',
      payload: expect.objectContaining({ phase: 'final_validation' }),
    }));
  });
  it('enforces the cost ceiling', async () => { const adapter: ModelAdapter = { async generate() { return response({ usage: { inputTokens: 1, outputTokens: 1, costUsd: 2 } }); } }; const result = await runAgent({ caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', model: 'm', adapter, tools: [], policy: { ...DEFAULT_AGENT_POLICY, maxCostUsd: 1, allowedTools: [] } }); expect(result.answer).toContain('Cost ceiling'); });
  it('replaces malformed raw tool output with a typed boundary failure', async () => { const seen: string[] = []; let call = 0; const adapter: ModelAdapter = { async generate(request) { seen.push(request.messages.at(-1)?.content ?? ''); call += 1; return call === 1 ? response({ toolCalls: [{ id: '1', name: 'get_document', input: { documentId: 'INV-001' } }] }) : response({ text: JSON.stringify({ outcome: 'abstained', answer: 'Invalid evidence', claims: [] }) }); } }; await runAgent({ caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', model: 'm', adapter, tools: createSyntheticTools(() => 'schema-invalid'), policy: { ...DEFAULT_AGENT_POLICY, allowedTools: ['get_document'] } }); expect(seen[1]).toContain('INVALID_RESPONSE'); });
  it('preserves Zod validation failures as typed invalid responses', async () => { const seen: string[] = []; let call = 0; const adapter: ModelAdapter = { async generate(request) { seen.push(request.messages.at(-1)?.content ?? ''); call += 1; return call === 1 ? response({ toolCalls: [{ id: '1', name: 'get_document', input: {} }] }) : response({ text: JSON.stringify({ outcome: 'abstained', answer: 'Bad input', claims: [] }) }); } }; await runAgent({ caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', model: 'm', adapter, tools: createSyntheticTools(), policy: { ...DEFAULT_AGENT_POLICY, allowedTools: ['get_document'] } }); expect(seen[1]).toContain('INVALID_RESPONSE'); expect(seen[1]).toContain('documentId'); });
  it('classifies and records tool deadline failures as typed timeouts', async () => { const seen: string[] = []; let call = 0; const adapter: ModelAdapter = { async generate(request) { seen.push(request.messages.at(-1)?.content ?? ''); call += 1; return call === 1 ? response({ toolCalls: [{ id: '1', name: 'get_document', input: { documentId: 'INV-001' } }] }) : response({ text: JSON.stringify({ outcome: 'abstained', answer: 'Timed out', claims: [] }) }); } }; const result = await runAgent({ caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', model: 'm', adapter, tools: createSyntheticTools(() => 'timeout'), policy: { ...DEFAULT_AGENT_POLICY, toolTimeoutMs: 1, allowedTools: ['get_document'] } }); expect(seen[1]).toContain('TIMEOUT'); expect(result.events).toContainEqual(expect.objectContaining({ type: 'tool', payload: expect.objectContaining({ name: 'get_document', result: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'TIMEOUT' }) }) }) })); });
  it('handles an already-aborted parent signal and removes its relay listener', async () => {
    const completedController = new AbortController();
    const remove = vi.spyOn(completedController.signal, 'removeEventListener');
    const adapter: ModelAdapter = { async generate() { return response({ text: JSON.stringify({ outcome: 'completed', answer: 'Done', claims: [] }) }); } };
    await runAgent({ caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', model: 'm', adapter, tools: [], policy: { ...DEFAULT_AGENT_POLICY, allowedTools: [] }, signal: completedController.signal });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));

    const abortedController = new AbortController();
    abortedController.abort(new Error('cancelled before start'));
    const generate = vi.fn(adapter.generate);
    const result = await runAgent({ caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', model: 'm', adapter: { generate }, tools: [], policy: { ...DEFAULT_AGENT_POLICY, allowedTools: [] }, signal: abortedController.signal });
    expect(generate).not.toHaveBeenCalled();
    expect(result.outcome).toBe('bounded');
  });
  it('stops later tool calls when the parent signal aborts during execution', async () => {
    const controller = new AbortController();
    const secondExecute = vi.fn(async () => ({ ok: true as const, data: null, evidenceId: 'second', provenance: 'test', freshAt: new Date(0).toISOString() }));
    const adapter: ModelAdapter = { async generate() { return response({ toolCalls: [
      { id: '1', name: 'first', input: {} },
      { id: '2', name: 'second', input: {} },
    ] }); } };
    const tools = [
      {
        name: 'first', description: 'first', inputSchema: z.object({}), sideEffect: 'read' as const,
        async execute(_input: unknown, context: { signal: AbortSignal }) {
          queueMicrotask(() => controller.abort(new Error('cancelled during tool')));
          return new Promise<never>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
        },
      },
      { name: 'second', description: 'second', inputSchema: z.object({}), sideEffect: 'simulated-write' as const, execute: secondExecute },
    ];
    await expect(runAgent({ caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', model: 'm', adapter, tools, policy: { ...DEFAULT_AGENT_POLICY, allowedTools: ['first', 'second'] }, signal: controller.signal })).rejects.toThrow('cancelled during tool');
    expect(secondExecute).not.toHaveBeenCalled();
  });
  it('keeps an internal agent deadline as a bounded outcome', async () => {
    const adapter: ModelAdapter = { async generate() { return response({ toolCalls: [{ id: '1', name: 'slow', input: {} }] }); } };
    const tools = [{
      name: 'slow', description: 'slow', inputSchema: z.object({}), sideEffect: 'read' as const,
      async execute(_input: unknown, context: { signal: AbortSignal }) {
        return new Promise<never>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
      },
    }];
    const result = await runAgent({ caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', model: 'm', adapter, tools, policy: { ...DEFAULT_AGENT_POLICY, deadlineMs: 1, toolTimeoutMs: 100, allowedTools: ['slow'] } });
    expect(result.outcome).toBe('bounded');
    expect(result.answer).toContain('Deadline exceeded');
  });
  it('keeps an agent deadline that fires during an in-flight model call as a bounded outcome', async () => {
    // Mirrors the Anthropic SDK: an aborted request rejects with "Request was aborted." instead of the signal reason.
    let call = 0;
    const adapter: ModelAdapter = {
      async generate(request) {
        call += 1;
        if (call === 1) return response({ toolCalls: [{ id: '1', name: 'get_document', input: { documentId: 'INV-001' } }] });
        return new Promise<never>((_resolve, reject) => request.signal?.addEventListener('abort', () => reject(new Error('Request was aborted.')), { once: true }));
      },
    };
    const result = await runAgent({ caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', model: 'm', adapter, tools: createSyntheticTools(), policy: { ...DEFAULT_AGENT_POLICY, deadlineMs: 50, allowedTools: ['get_document'] } });
    expect(result.outcome).toBe('bounded');
    expect(result.answer).toContain('Deadline exceeded');
    expect(result.usage.costUsd).toBeCloseTo(0.001);
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'error', payload: expect.objectContaining({ phase: 'model', message: 'Request was aborted.' }) }));
  });
  it('propagates a parent cancellation that fires during an in-flight model call', async () => {
    const controller = new AbortController();
    const adapter: ModelAdapter = {
      async generate(request) {
        queueMicrotask(() => controller.abort(new Error('cancelled during model call')));
        return new Promise<never>((_resolve, reject) => request.signal?.addEventListener('abort', () => reject(new Error('Request was aborted.')), { once: true }));
      },
    };
    await expect(runAgent({ caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', model: 'm', adapter, tools: [], policy: { ...DEFAULT_AGENT_POLICY, allowedTools: [] }, signal: controller.signal })).rejects.toThrow('cancelled during model call');
  });
  it('propagates model failures that are not caused by the agent deadline', async () => {
    const adapter: ModelAdapter = { async generate() { throw new Error('529 overloaded'); } };
    await expect(runAgent({ caseId: 'case', seed: 1, prompt: 'x', systemPrompt: 'x', model: 'm', adapter, tools: [], policy: { ...DEFAULT_AGENT_POLICY, allowedTools: [] } })).rejects.toThrow('529 overloaded');
  });
});
