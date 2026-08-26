import { z } from "zod";
import type { ModelAdapter, ModelRequest, ModelResponse } from "./contracts.js";
import type { ModelRate } from "./pricing.js";

export const ANTHROPIC_MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5",
} as const;

type AnthropicClient = {
  messages: {
    create(request: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
  };
};

const anthropicResponseSchema = z.object({
  model: z.string().min(1),
  stop_reason: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("tool_use"),
        id: z.string(),
        name: z.string(),
        input: z.unknown(),
      }),
    ]),
  ),
});

export class AnthropicAdapter implements ModelAdapter {
  constructor(
    private readonly client: AnthropicClient,
    private readonly rates: Readonly<Record<string, ModelRate>>,
  ) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (!Object.values(ANTHROPIC_MODELS).includes(request.model as never)) {
      throw new Error(`Unpinned Anthropic model: ${request.model}`);
    }
    if (request.model === ANTHROPIC_MODELS.sonnet && request.temperature !== undefined) {
      throw new Error("Sonnet 5 does not accept temperature");
    }
    const rate = this.rates[request.model];
    if (!rate) throw new Error(`Missing pricing rate for model: ${request.model}`);
    const started = performance.now();
    const raw = await this.client.messages.create(
      {
        model: request.model,
        max_tokens: request.maxOutputTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.messages.some(({ role }) => role === "system")
          ? { system: request.messages.filter(({ role }) => role === "system").map(({ content }) => content).join("\n") }
          : {}),
        messages: request.messages.filter(({ role }) => role !== "system").map(toAnthropicMessage),
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        })),
      },
      { signal: request.signal },
    );
    const response = anthropicResponseSchema.parse(raw);
    return {
      text: response.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
      toolCalls: response.content
        .filter(
          (block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use",
        )
        .map((block) => ({ id: block.id, name: block.name, input: block.input })),
      stopReason: response.stop_reason ?? "unknown",
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        costUsd: price(rate, response.usage.input_tokens, response.usage.output_tokens),
      },
      modelId: response.model,
      latencyMs: performance.now() - started,
    };
  }
}

function toAnthropicMessage(message: ModelRequest["messages"][number]): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }] };
  }
  if (message.role === "assistant") {
    try {
      const value = z.object({
        text: z.string(),
        toolCalls: z.array(z.object({ id: z.string(), name: z.string(), input: z.unknown() })),
      }).parse(JSON.parse(message.content));
      return {
        role: "assistant",
        content: [
          ...(value.text.length > 0 ? [{ type: "text", text: value.text }] : []),
          ...value.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input })),
        ],
      };
    } catch {
      return { role: "assistant", content: message.content };
    }
  }
  return { role: "user", content: message.content };
}

function price(rate: ModelRate, inputTokens: number, outputTokens: number): number {
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
