import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AgentPolicy, AgentResult, ModelAdapter, NormalizedMessage, RunnerEvent, TelemetrySink, ToolDefinition, ToolEnvelope } from './contracts.js';
import { ToolEnvelopeSchema } from './contracts.js';
import { createCaseState } from './tools.js';
import { ANTHROPIC_MODELS } from './adapter.js';

const FinalSchema = z.object({ outcome: z.enum(['completed', 'abstained']), answer: z.string(), claims: z.array(z.object({ claim: z.string(), evidenceIds: z.array(z.string()) })) });

export const FINAL_RESULT_INSTRUCTION = 'Return exactly one JSON object with this shape: {"outcome":"completed"|"abstained","answer":"string","claims":[{"claim":"string","evidenceIds":["string"]}]}. Use no Markdown fences or surrounding prose. Every factual claim must cite evidence IDs from tool results. Use an empty claims array when there are no factual claims.';

export interface RunAgentInput {
  readonly runId?: string;
  readonly caseId: string;
  readonly seed: number;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly model: string;
  readonly adapter: ModelAdapter;
  readonly tools: readonly ToolDefinition[];
  readonly policy: AgentPolicy;
  readonly telemetry?: TelemetrySink;
  readonly signal?: AbortSignal;
}

function finalState(state: ReturnType<typeof createCaseState>): AgentResult['finalState'] {
  return {
    followUps: [...state.followUps.values()],
    matchedPayments: Object.fromEntries(
      [...state.paymentMatches.values()].map(({ paymentId, documentId }) => [paymentId, documentId]),
    ),
  };
}

function boundedError(message: string, state: ReturnType<typeof createCaseState>, events: readonly RunnerEvent[], tokens: number, costUsd: number, modelIds: readonly string[], started: number): AgentResult {
  return { outcome: 'bounded', answer: message, finalState: finalState(state), claims: [], usage: { tokens, costUsd }, modelIds, events, latencyMs: performance.now() - started };
}

export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  const started = performance.now();
  const state = createCaseState();
  const events: RunnerEvent[] = [];
  const messages: NormalizedMessage[] = [{ role: 'system', content: input.systemPrompt }, { role: 'user', content: input.prompt }];
  const invocations = new Map<string, number>();
  let toolCalls = 0;
  let tokens = 0;
  let costUsd = 0;
  let repairs = 0;
  const modelIds: string[] = [];
  const emit = async (type: RunnerEvent['type'], payload: Record<string, unknown>) => { const event = { sequence: events.length + 1, type, at: new Date().toISOString(), payload: { runId: input.runId ?? `${input.caseId}:${input.seed}`, ...payload } } as const; events.push(event); await input.telemetry?.emit(event); };
  const abort = new AbortController();
  const relayParentAbort = (): void => abort.abort(input.signal?.reason);
  if (input.signal?.aborted) relayParentAbort();
  else input.signal?.addEventListener('abort', relayParentAbort, { once: true });
  const deadline = setTimeout(() => abort.abort(new Error('Agent deadline exceeded')), input.policy.deadlineMs);
  try {
    for (let iteration = 1; iteration <= input.policy.maxIterations; iteration += 1) {
      if (abort.signal.aborted || performance.now() - started >= input.policy.deadlineMs) return boundedError('Deadline exceeded', state, events, tokens, costUsd, modelIds, started);
      const perCallOutputLimit = input.model === ANTHROPIC_MODELS.sonnet ? 8_192 : 4_096;
      const response = await input.adapter.generate({ messages, tools: input.tools.filter((tool) => input.policy.allowedTools.includes(tool.name)).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: zodToJsonSchema(tool.inputSchema, { $refStrategy: 'none' }) as Record<string, unknown> })), model: input.model, ...(input.model === ANTHROPIC_MODELS.haiku ? { temperature: 0 } : {}), maxOutputTokens: Math.max(1, Math.min(perCallOutputLimit, input.policy.maxTokens - tokens)), signal: abort.signal });
      tokens += response.usage.inputTokens + response.usage.outputTokens;
      costUsd += response.usage.costUsd;
      modelIds.push(response.modelId);
      await emit('model', { iteration, modelId: response.modelId, stopReason: response.stopReason, tokens, costUsd });
      if (response.stopReason === 'max_tokens') return boundedError('Model output token limit reached', state, events, tokens, costUsd, modelIds, started);
      if (tokens > input.policy.maxTokens) return boundedError('Token ceiling exceeded', state, events, tokens, costUsd, modelIds, started);
      if (costUsd > input.policy.maxCostUsd) return boundedError('Cost ceiling exceeded', state, events, tokens, costUsd, modelIds, started);
      if (Buffer.byteLength(response.text) > input.policy.maxOutputBytes) return boundedError('Output size exceeded', state, events, tokens, costUsd, modelIds, started);
      messages.push({ role: 'assistant', content: JSON.stringify({ text: response.text, toolCalls: response.toolCalls }) });
      if (response.toolCalls.length > 0) {
        for (const call of response.toolCalls) {
          if (input.signal?.aborted) throw abortFailure(input.signal);
          if (abort.signal.aborted) return boundedError('Deadline exceeded', state, events, tokens, costUsd, modelIds, started);
          toolCalls += 1;
          if (toolCalls > input.policy.maxToolCalls) return boundedError('Tool call ceiling exceeded', state, events, tokens, costUsd, modelIds, started);
          const tool = input.tools.find((candidate) => candidate.name === call.name);
          if (!tool || !input.policy.allowedTools.includes(call.name)) return boundedError(`Tool not allowed: ${call.name}`, state, events, tokens, costUsd, modelIds, started);
          const invocation = (invocations.get(call.name) ?? 0) + 1;
          invocations.set(call.name, invocation);
          const toolAbort = new AbortController();
          const relayToolAbort = (): void => toolAbort.abort(abort.signal.reason);
          if (abort.signal.aborted) relayToolAbort();
          else abort.signal.addEventListener('abort', relayToolAbort, { once: true });
          const timer = setTimeout(() => toolAbort.abort(new Error('Tool timeout')), input.policy.toolTimeoutMs);
          try {
            const rawResult = await Promise.race([tool.execute(call.input, { caseId: input.caseId, seed: input.seed, invocation, state, signal: toolAbort.signal }), new Promise<never>((_, reject) => toolAbort.signal.addEventListener('abort', () => reject(toolAbort.signal.reason), { once: true }))]);
            const parsedResult = ToolEnvelopeSchema.safeParse(rawResult);
            const result = parsedResult.success ? parsedResult.data : runnerFailure(input.caseId, call.name, invocation, 'INVALID_RESPONSE', 'Tool returned an invalid envelope', false);
            await emit('tool', { name: call.name, invocation, input: call.input, result });
            messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
          } catch (error) {
            if (input.signal?.aborted) throw abortFailure(input.signal);
            const timedOut = toolAbort.signal.aborted;
            const result = runnerFailure(input.caseId, call.name, invocation, timedOut ? 'TIMEOUT' : 'INVALID_RESPONSE', error instanceof Error ? error.message : String(error), timedOut);
            await emit('error', { name: call.name, message: error instanceof Error ? error.message : String(error) });
            await emit('tool', { name: call.name, invocation, input: call.input, result });
            messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
          } finally { clearTimeout(timer); abort.signal.removeEventListener('abort', relayToolAbort); }
        }
        continue;
      }
      const parsed = FinalSchema.safeParse(safeJson(response.text));
      if (!parsed.success) {
        const issues = parsed.error.issues.map(({ path, message }) => ({ path: path.join('.'), message }));
        await emit('error', { phase: 'final_validation', issues, responseBytes: Buffer.byteLength(response.text) });
        if (repairs === 0) {
          repairs += 1;
          messages.push({ role: 'user', content: `The previous final result was invalid. Required correction: ${JSON.stringify(issues)}. ${FINAL_RESULT_INSTRUCTION}` });
          continue;
        }
        return { ...boundedError('Invalid final result after repair', state, events, tokens, costUsd, modelIds, started), outcome: 'error' };
      }
      await emit('complete', { outcome: parsed.data.outcome });
      return { ...parsed.data, finalState: finalState(state), usage: { tokens, costUsd }, modelIds, events, latencyMs: performance.now() - started };
    }
    return boundedError('Iteration ceiling exceeded', state, events, tokens, costUsd, modelIds, started);
  } finally { clearTimeout(deadline); input.signal?.removeEventListener('abort', relayParentAbort); }
}

function safeJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(trimmed);
  try { return JSON.parse(fenced?.[1] ?? trimmed); } catch { return null; }
}

function abortFailure(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Agent cancelled", "AbortError");
}

function runnerFailure(caseId: string, tool: string, invocation: number, code: 'TIMEOUT' | 'INVALID_RESPONSE', message: string, retryable: boolean): ToolEnvelope {
  return ToolEnvelopeSchema.parse({ ok: false, error: { code, message, retryable }, evidenceId: `${caseId}:${tool}:${invocation}`, provenance: 'runner:boundary', freshAt: new Date(0).toISOString() });
}
