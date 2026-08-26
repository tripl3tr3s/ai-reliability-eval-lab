import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AgentPolicy, AgentResult, ModelAdapter, NormalizedMessage, RunnerEvent, TelemetrySink, ToolDefinition, ToolEnvelope } from './contracts.js';
import { ToolEnvelopeSchema } from './contracts.js';
import { createCaseState } from './tools.js';
import { ANTHROPIC_MODELS } from './adapter.js';

const FinalSchema = z.object({ outcome: z.enum(['completed', 'abstained']), answer: z.string(), claims: z.array(z.object({ claim: z.string(), evidenceIds: z.array(z.string()) })) });

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

function boundedError(message: string, state: ReturnType<typeof createCaseState>, events: readonly RunnerEvent[], tokens: number, costUsd: number, modelIds: readonly string[]): AgentResult {
  return { outcome: 'bounded', answer: message, finalState: { followUps: [...state.followUps.values()], paymentMatches: [...state.paymentMatches.values()] }, claims: [], usage: { tokens, costUsd }, modelIds, events };
}

export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  const started = Date.now();
  const state = createCaseState();
  const events: RunnerEvent[] = [];
  const messages: NormalizedMessage[] = [{ role: 'system', content: input.systemPrompt }, { role: 'user', content: input.prompt }];
  const invocations = new Map<string, number>();
  let toolCalls = 0;
  let tokens = 0;
  let costUsd = 0;
  let repairs = 0;
  const modelIds: string[] = [];
  const emit = async (type: RunnerEvent['type'], payload: Record<string, unknown>) => { const event = { sequence: events.length + 1, type, at: new Date(started + events.length).toISOString(), payload: { runId: input.runId ?? `${input.caseId}:${input.seed}`, ...payload } } as const; events.push(event); await input.telemetry?.emit(event); };
  const abort = new AbortController();
  input.signal?.addEventListener('abort', () => abort.abort(input.signal?.reason), { once: true });
  const deadline = setTimeout(() => abort.abort(new Error('Agent deadline exceeded')), input.policy.deadlineMs);
  try {
    for (let iteration = 1; iteration <= input.policy.maxIterations; iteration += 1) {
      if (abort.signal.aborted || Date.now() - started >= input.policy.deadlineMs) return boundedError('Deadline exceeded', state, events, tokens, costUsd, modelIds);
      const perCallOutputLimit = input.model === ANTHROPIC_MODELS.sonnet ? 8_192 : 4_096;
      const response = await input.adapter.generate({ messages, tools: input.tools.filter((tool) => input.policy.allowedTools.includes(tool.name)).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: zodToJsonSchema(tool.inputSchema, { $refStrategy: 'none' }) as Record<string, unknown> })), model: input.model, ...(input.model === ANTHROPIC_MODELS.haiku ? { temperature: 0 } : {}), maxOutputTokens: Math.max(1, Math.min(perCallOutputLimit, input.policy.maxTokens - tokens)), signal: abort.signal });
      tokens += response.usage.inputTokens + response.usage.outputTokens;
      costUsd += response.usage.costUsd;
      modelIds.push(response.modelId);
      await emit('model', { iteration, modelId: response.modelId, stopReason: response.stopReason, tokens, costUsd });
      if (response.stopReason === 'max_tokens') return boundedError('Model output token limit reached', state, events, tokens, costUsd, modelIds);
      if (tokens > input.policy.maxTokens) return boundedError('Token ceiling exceeded', state, events, tokens, costUsd, modelIds);
      if (costUsd > input.policy.maxCostUsd) return boundedError('Cost ceiling exceeded', state, events, tokens, costUsd, modelIds);
      if (Buffer.byteLength(response.text) > input.policy.maxOutputBytes) return boundedError('Output size exceeded', state, events, tokens, costUsd, modelIds);
      messages.push({ role: 'assistant', content: JSON.stringify({ text: response.text, toolCalls: response.toolCalls }) });
      if (response.toolCalls.length > 0) {
        for (const call of response.toolCalls) {
          toolCalls += 1;
          if (toolCalls > input.policy.maxToolCalls) return boundedError('Tool call ceiling exceeded', state, events, tokens, costUsd, modelIds);
          const tool = input.tools.find((candidate) => candidate.name === call.name);
          if (!tool || !input.policy.allowedTools.includes(call.name)) return boundedError(`Tool not allowed: ${call.name}`, state, events, tokens, costUsd, modelIds);
          const invocation = (invocations.get(call.name) ?? 0) + 1;
          invocations.set(call.name, invocation);
          const toolAbort = new AbortController();
          abort.signal.addEventListener('abort', () => toolAbort.abort(abort.signal.reason), { once: true });
          const timer = setTimeout(() => toolAbort.abort(new Error('Tool timeout')), input.policy.toolTimeoutMs);
          try {
            const rawResult = await Promise.race([tool.execute(call.input, { caseId: input.caseId, seed: input.seed, invocation, state, signal: toolAbort.signal }), new Promise<never>((_, reject) => toolAbort.signal.addEventListener('abort', () => reject(toolAbort.signal.reason), { once: true }))]);
            const parsedResult = ToolEnvelopeSchema.safeParse(rawResult);
            const result = parsedResult.success ? parsedResult.data : runnerFailure(input.caseId, call.name, invocation, 'INVALID_RESPONSE', 'Tool returned an invalid envelope', false);
            await emit('tool', { name: call.name, invocation, input: call.input, result });
            messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
          } catch (error) {
            const timedOut = toolAbort.signal.aborted;
            const result = runnerFailure(input.caseId, call.name, invocation, timedOut ? 'TIMEOUT' : 'INVALID_RESPONSE', error instanceof Error ? error.message : String(error), timedOut);
            await emit('error', { name: call.name, message: error instanceof Error ? error.message : String(error) });
            messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
          } finally { clearTimeout(timer); }
        }
        continue;
      }
      const parsed = FinalSchema.safeParse(safeJson(response.text));
      if (!parsed.success && repairs === 0) { repairs += 1; messages.push({ role: 'user', content: 'Return one valid JSON final result with outcome, answer, and claims.' }); continue; }
      if (!parsed.success) return { ...boundedError('Invalid final result after repair', state, events, tokens, costUsd, modelIds), outcome: 'error' };
      await emit('complete', { outcome: parsed.data.outcome });
      return { ...parsed.data, finalState: { followUps: [...state.followUps.values()], paymentMatches: [...state.paymentMatches.values()] }, usage: { tokens, costUsd }, modelIds, events };
    }
    return boundedError('Iteration ceiling exceeded', state, events, tokens, costUsd, modelIds);
  } finally { clearTimeout(deadline); }
}

function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }

function runnerFailure(caseId: string, tool: string, invocation: number, code: 'TIMEOUT' | 'INVALID_RESPONSE', message: string, retryable: boolean): ToolEnvelope {
  return ToolEnvelopeSchema.parse({ ok: false, error: { code, message, retryable }, evidenceId: `${caseId}:${tool}:${invocation}`, provenance: 'runner:boundary', freshAt: new Date(0).toISOString() });
}
