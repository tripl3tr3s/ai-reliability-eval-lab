import { z } from "zod";
import { ModelProviderError, NORMALIZED_STOP_REASONS, providerErrorCodeForStatus, type ModelAdapter, type ModelCapabilities, type ModelRequest, type ModelResponse } from "../contracts.js";
import type { ModelRate } from "../pricing.js";
import { decodeAssistantTurn } from "./assistant-turn.js";

const PROVIDER = "openai-compatible";

export type FetchLike = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export interface OpenAiCompatibleOptions {
  /** Base URL up to and including the version segment, for example http://localhost:11434/v1. */
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** Models this adapter may call. Requests for any other model are rejected before the network. */
  readonly models: readonly string[];
  readonly rates: Readonly<Record<string, ModelRate>>;
  readonly fetch: FetchLike;
  /** Some servers accept `max_tokens`, others require `max_completion_tokens`. */
  readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
  readonly acceptsTemperature?: boolean;
  readonly maxOutputTokensPerCall?: number;
}

const ResponseSchema = z.object({
  model: z.string().min(1),
  choices: z.array(z.object({
    finish_reason: z.string().nullable(),
    message: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        id: z.string().min(1),
        function: z.object({ name: z.string().min(1), arguments: z.string() }),
      })).nullable().optional(),
    }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
  }),
});

const STOP_REASONS: Readonly<Record<string, string>> = {
  stop: NORMALIZED_STOP_REASONS.endTurn,
  tool_calls: NORMALIZED_STOP_REASONS.toolUse,
  function_call: NORMALIZED_STOP_REASONS.toolUse,
  length: NORMALIZED_STOP_REASONS.outputLimit,
  content_filter: "refusal",
};

function toWireMessage(message: ModelRequest["messages"][number]): Record<string, unknown> {
  if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  if (message.role === "assistant") {
    const turn = decodeAssistantTurn(message.content);
    if (turn === null) return { role: "assistant", content: message.content };
    return {
      role: "assistant",
      content: turn.text.length > 0 ? turn.text : null,
      ...(turn.toolCalls.length > 0
        ? { tool_calls: turn.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) } })) }
        : {}),
    };
  }
  return { role: message.role, content: message.content };
}

/** A malformed argument string is passed through unparsed so the tool's own schema rejects it and the run is scored, not crashed. */
function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Adapter for servers that implement the OpenAI chat completions wire format.
 * Uses plain fetch, no SDK. Tool calling is mapped to and from the normalized contract.
 */
export class OpenAiCompatibleAdapter implements ModelAdapter {
  constructor(private readonly options: OpenAiCompatibleOptions) {}

  capabilities(model: string): ModelCapabilities {
    if (!this.options.models.includes(model)) throw new Error(`Unconfigured OpenAI-compatible model: ${model}`);
    const acceptsTemperature = this.options.acceptsTemperature ?? true;
    return {
      provider: PROVIDER,
      acceptsTemperature,
      ...(acceptsTemperature ? { defaultTemperature: 0 } : {}),
      maxOutputTokensPerCall: this.options.maxOutputTokensPerCall ?? 4_096,
      toolCalling: true,
      structuredOutput: "prompt",
    };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const capabilities = this.capabilities(request.model);
    if (!capabilities.acceptsTemperature && request.temperature !== undefined) throw new Error(`Model ${request.model} is configured without temperature support`);
    const rate = this.options.rates[request.model];
    if (!rate) throw new Error(`Missing pricing rate for model: ${request.model}`);
    const started = performance.now();
    const body = {
      model: request.model,
      [this.options.maxTokensField ?? "max_tokens"]: request.maxOutputTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      messages: request.messages.map(toWireMessage),
      ...(request.tools.length === 0
        ? {}
        : { tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) }),
    };
    let status: number;
    let text: string;
    try {
      const response = await this.options.fetch(`${this.options.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: request.signal,
      });
      status = response.status;
      text = await response.text();
      if (!response.ok) {
        // The body can echo request content, so only the status is reported.
        throw new ModelProviderError(`OpenAI-compatible request failed with status ${status}`, { code: providerErrorCodeForStatus(status), provider: PROVIDER, status });
      }
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      const aborted = request.signal.aborted || (error instanceof Error && error.name === "AbortError");
      throw new ModelProviderError(error instanceof Error ? error.message : String(error), { code: aborted ? "aborted" : "server", provider: PROVIDER, cause: error });
    }
    let parsed: z.infer<typeof ResponseSchema>;
    try {
      parsed = ResponseSchema.parse(JSON.parse(text));
    } catch (error) {
      throw new ModelProviderError("OpenAI-compatible response did not match the expected schema", { code: "invalid_response", provider: PROVIDER, status, cause: error });
    }
    const choice = parsed.choices[0]!;
    const finish = choice.finish_reason ?? "unknown";
    return {
      text: choice.message.content ?? "",
      toolCalls: (choice.message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) })),
      stopReason: STOP_REASONS[finish] ?? finish,
      usage: {
        inputTokens: parsed.usage.prompt_tokens,
        outputTokens: parsed.usage.completion_tokens,
        costUsd: (parsed.usage.prompt_tokens * rate.input + parsed.usage.completion_tokens * rate.output) / 1_000_000,
      },
      modelId: parsed.model,
      latencyMs: performance.now() - started,
    };
  }
}
