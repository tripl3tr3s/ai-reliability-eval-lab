import { z } from "zod";
import { ModelProviderError, providerErrorCodeForStatus, type ModelAdapter, type ModelCapabilities, type ModelRequest, type ModelResponse, type ModelRoles } from "./contracts.js";
import { decodeAssistantTurn } from "./providers/assistant-turn.js";
import type { ModelRate } from "./pricing.js";

export const ANTHROPIC_MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5",
} as const;

/** Provider rules for the pinned models. Sonnet 5 rejects temperature (adaptive thinking) and gets a larger per-call output allowance. */
export const ANTHROPIC_MODEL_CAPABILITIES: Readonly<Record<string, ModelCapabilities>> = Object.freeze({
  [ANTHROPIC_MODELS.haiku]: { provider: "anthropic", acceptsTemperature: true, defaultTemperature: 0, maxOutputTokensPerCall: 4_096, toolCalling: true, structuredOutput: "prompt" },
  [ANTHROPIC_MODELS.sonnet]: { provider: "anthropic", acceptsTemperature: false, maxOutputTokensPerCall: 8_192, toolCalling: true, structuredOutput: "prompt" },
});

export const ANTHROPIC_MODEL_ROLES: ModelRoles = Object.freeze({
  executor: ANTHROPIC_MODELS.sonnet,
  router: ANTHROPIC_MODELS.haiku,
  simpleExecutor: ANTHROPIC_MODELS.haiku,
});

type AnthropicClient = {
  messages: {
    create(request: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
  };
};

type AnthropicAdapterLogger = {
  warn(event: Readonly<Record<string, unknown>>): void;
};

const knownContentTypes = new Set(["text", "tool_use", "thinking", "redacted_thinking"]);

const TextBlockSchema = z.object({ type: z.literal("text"), text: z.string() });

const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
}).refine((block) => Object.hasOwn(block, "input"), {
  message: "Tool-use block must include input",
});

const ThinkingBlockSchema = z.object({ type: z.literal("thinking") }).passthrough();

const RedactedThinkingBlockSchema = z
  .object({ type: z.literal("redacted_thinking") })
  .passthrough();

const UnknownBlockSchema = z
  .object({ type: z.string() })
  .passthrough()
  .refine(({ type }) => !knownContentTypes.has(type), {
    message: "Known content block does not match its expected schema",
  });

const ContentBlockSchema = z.union([
  TextBlockSchema,
  ToolUseBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  UnknownBlockSchema,
]);

const anthropicResponseSchema = z.object({
  model: z.string().min(1),
  stop_reason: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
  content: z.array(ContentBlockSchema),
});

const stderrLogger: AnthropicAdapterLogger = {
  warn: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
};

export class AnthropicAdapter implements ModelAdapter {
  constructor(
    private readonly client: AnthropicClient,
    private readonly rates: Readonly<Record<string, ModelRate>>,
    private readonly logger: AnthropicAdapterLogger = stderrLogger,
  ) {}

  capabilities(model: string): ModelCapabilities {
    const capabilities = ANTHROPIC_MODEL_CAPABILITIES[model];
    if (!capabilities) throw new Error(`Unpinned Anthropic model: ${model}`);
    return capabilities;
  }

  private async create(body: Record<string, unknown>, options: { signal: AbortSignal }): Promise<unknown> {
    try {
      return await this.client.messages.create(body, options);
    } catch (error) {
      throw normalizeAnthropicError(error);
    }
  }

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
    const raw = await this.create(
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
    const validated = anthropicResponseSchema.safeParse(raw);
    if (!validated.success) throw new ModelProviderError(validated.error.message, { code: "invalid_response", provider: "anthropic", cause: validated.error });
    const response = validated.data;
    for (const block of response.content) {
      if (!knownContentTypes.has(block.type)) {
        try {
          this.logger.warn({
            event: "anthropic_unexpected_content_block",
            blockType: block.type,
            model: response.model,
          });
        } catch {
          // Logging must not invalidate an otherwise scoreable provider response.
        }
      }
    }
    return {
      text: response.content
        .filter((block): block is z.infer<typeof TextBlockSchema> => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
      toolCalls: response.content
        .filter(
          (block): block is z.infer<typeof ToolUseBlockSchema> => block.type === "tool_use",
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

/** Maps an Anthropic SDK failure onto the provider-neutral error. The message is kept unchanged. */
export function normalizeAnthropicError(error: unknown): ModelProviderError {
  if (error instanceof ModelProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  const status = typeof (error as { status?: unknown } | null)?.status === "number" ? (error as { status: number }).status : undefined;
  const code = name === "APIUserAbortError" || name === "AbortError"
    ? "aborted"
    : name === "APIConnectionTimeoutError"
      ? "timeout"
      : status !== undefined ? providerErrorCodeForStatus(status) : name === "APIConnectionError" ? "server" : "unknown";
  return new ModelProviderError(message, { code, provider: "anthropic", cause: error, ...(status === undefined ? {} : { status }) });
}

function toAnthropicMessage(message: ModelRequest["messages"][number]): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }] };
  }
  if (message.role === "assistant") {
    const turn = decodeAssistantTurn(message.content);
    if (turn === null) return { role: "assistant", content: message.content };
    return {
      role: "assistant",
      content: [
        ...(turn.text.length > 0 ? [{ type: "text", text: turn.text }] : []),
        ...turn.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input })),
      ],
    };
  }
  return { role: "user", content: message.content };
}

function price(rate: ModelRate, inputTokens: number, outputTokens: number): number {
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
