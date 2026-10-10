import { AnthropicAdapter } from "../../src/adapter.js";
import type { ModelAdapter, ModelRequest, ModelResponse, NormalizedMessage } from "../../src/contracts.js";
import type { ModelRate } from "../../src/pricing.js";
import { decodeAssistantTurn, encodeAssistantTurn } from "../../src/providers/assistant-turn.js";
import { OpenAiCompatibleAdapter, type FetchLike, type OpenAiCompatibleOptions } from "../../src/providers/openai-compatible.js";

/** Provider-neutral behaviour that a simulated provider executes. It sees what the provider would have understood. */
export type Brain = (request: ModelRequest) => Promise<ModelResponse>;
export type WireFailure = { readonly status: number } | { readonly malformed: true } | { readonly network: string };

export interface SimulatedProvider {
  readonly adapter: ModelAdapter;
  /** Raw request bodies exactly as sent on the wire. */
  readonly wire: Record<string, unknown>[];
}

type AnthropicBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string };

function fromAnthropicWire(body: Record<string, unknown>, signal: AbortSignal): ModelRequest {
  const messages = (body.messages as { role: string; content: string | AnthropicBlock[] }[]).map((message): NormalizedMessage => {
    if (typeof message.content === "string") return { role: message.role as "user" | "assistant", content: message.content };
    const result = message.content.find((block) => block.type === "tool_result");
    if (result) return { role: "tool", toolCallId: result.tool_use_id!, content: result.content! };
    return {
      role: "assistant",
      content: encodeAssistantTurn({
        text: message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
        toolCalls: message.content.filter((block) => block.type === "tool_use").map((block) => ({ id: block.id!, name: block.name!, input: block.input })),
      }),
    };
  });
  return {
    model: body.model as string,
    maxOutputTokens: body.max_tokens as number,
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    messages: [...(typeof body.system === "string" ? [{ role: "system" as const, content: body.system }] : []), ...messages],
    tools: (body.tools as { name: string; description: string; input_schema: Record<string, unknown> }[]).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema })),
    signal,
  };
}

/** Anthropic adapter wired to a fake SDK client that speaks the Messages wire format. */
export function simulatedAnthropic(brain: Brain, rates: Readonly<Record<string, ModelRate>>, failure?: WireFailure): SimulatedProvider {
  const wire: Record<string, unknown>[] = [];
  const adapter = new AnthropicAdapter({
    messages: {
      async create(body, options) {
        wire.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
        if (failure && "status" in failure) throw Object.assign(new Error(`${failure.status} simulated provider failure`), { status: failure.status });
        if (failure && "network" in failure) throw Object.assign(new Error(failure.network), { name: "APIConnectionError" });
        if (failure && "malformed" in failure) return { model: body.model, content: "not an array" };
        const response = await brain(fromAnthropicWire(body, options?.signal ?? new AbortController().signal));
        return {
          model: response.modelId,
          stop_reason: response.stopReason,
          usage: { input_tokens: response.usage.inputTokens, output_tokens: response.usage.outputTokens },
          content: [
            ...(response.text.length > 0 ? [{ type: "text", text: response.text }] : []),
            ...response.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input })),
          ],
        };
      },
    },
  }, rates);
  return { adapter, wire };
}

type OpenAiMessage = { role: string; content: string | null; tool_call_id?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
const OPENAI_FINISH: Readonly<Record<string, string>> = { end_turn: "stop", tool_use: "tool_calls", max_tokens: "length" };

function fromOpenAiWire(body: Record<string, unknown>, signal: AbortSignal): ModelRequest {
  const messages = (body.messages as OpenAiMessage[]).map((message): NormalizedMessage => {
    if (message.role === "tool") return { role: "tool", toolCallId: message.tool_call_id!, content: message.content ?? "" };
    if (message.role === "assistant" && (message.tool_calls || message.content === null)) {
      return { role: "assistant", content: encodeAssistantTurn({ text: message.content ?? "", toolCalls: (message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) as unknown })) }) };
    }
    return { role: message.role as "system" | "user" | "assistant", content: message.content ?? "" };
  });
  return {
    model: body.model as string,
    maxOutputTokens: (body.max_tokens ?? body.max_completion_tokens) as number,
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    messages,
    tools: ((body.tools ?? []) as { function: { name: string; description: string; parameters: Record<string, unknown> } }[]).map(({ function: tool }) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
    signal,
  };
}

/** OpenAI-compatible adapter wired to a fake fetch that speaks the chat completions wire format. No network is involved. */
export function simulatedOpenAiCompatible(
  brain: Brain,
  rates: Readonly<Record<string, ModelRate>>,
  options: Partial<OpenAiCompatibleOptions> = {},
  failure?: WireFailure,
): SimulatedProvider & { readonly calls: { url: string; headers: Record<string, string> }[] } {
  const wire: Record<string, unknown>[] = [];
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    wire.push(body);
    calls.push({ url, headers: init.headers });
    if (failure && "status" in failure) return { ok: false, status: failure.status, text: async () => JSON.stringify({ error: { message: "secret prompt echoed by the server" } }) };
    if (failure && "network" in failure) throw new TypeError(failure.network);
    if (failure && "malformed" in failure) return { ok: true, status: 200, text: async () => "{\"choices\":[]}" };
    const response = await brain(fromOpenAiWire(body, init.signal));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        model: response.modelId,
        choices: [{
          finish_reason: OPENAI_FINISH[response.stopReason] ?? response.stopReason,
          message: {
            content: response.text.length > 0 ? response.text : null,
            ...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : {}),
          },
        }],
        usage: { prompt_tokens: response.usage.inputTokens, completion_tokens: response.usage.outputTokens },
      }),
    };
  };
  const adapter = new OpenAiCompatibleAdapter({ baseUrl: "http://simulated.invalid/v1", models: Object.keys(rates), rates, fetch, ...options });
  return { adapter, wire, calls };
}

/** Decodes an assistant message the way a provider would have seen it, for assertions. */
export const assistantTurnOf = (message: NormalizedMessage | undefined) => (message ? decodeAssistantTurn(message.content) : null);
