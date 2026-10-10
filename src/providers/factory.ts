import { z } from "zod";
import { ANTHROPIC_MODEL_ROLES, AnthropicAdapter } from "../adapter.js";
import type { ModelAdapter, ModelRoles } from "../contracts.js";
import type { ModelRate } from "../pricing.js";
import { OpenAiCompatibleAdapter, type FetchLike } from "./openai-compatible.js";

export const MODEL_PROVIDERS = ["anthropic", "openai-compatible"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

type AnthropicClient = ConstructorParameters<typeof AnthropicAdapter>[0];

export interface ProviderDependencies {
  /** Builds the Anthropic SDK client. Injected so this module needs no SDK import and tests need no network. */
  readonly createAnthropicClient: (apiKey: string) => AnthropicClient;
  readonly fetch: FetchLike;
}

const ModelId = z.string().trim().min(1).max(200);
const OpenAiCompatibleEnvironmentSchema = z.object({
  OPENAI_COMPATIBLE_BASE_URL: z.string().url("OPENAI_COMPATIBLE_BASE_URL must be a URL"),
  OPENAI_COMPATIBLE_API_KEY: z.string().min(1).optional(),
  OPENAI_COMPATIBLE_EXECUTOR_MODEL: ModelId,
  OPENAI_COMPATIBLE_ROUTER_MODEL: ModelId.optional(),
  OPENAI_COMPATIBLE_SIMPLE_MODEL: ModelId.optional(),
  OPENAI_COMPATIBLE_MAX_TOKENS_FIELD: z.enum(["max_tokens", "max_completion_tokens"]).default("max_tokens"),
  OPENAI_COMPATIBLE_TEMPERATURE: z.enum(["supported", "unsupported"]).default("supported"),
});

export interface ConfiguredProvider {
  readonly provider: ModelProvider;
  readonly adapter: ModelAdapter;
  readonly models: ModelRoles;
}

/**
 * Selects and configures the model adapter from environment variables.
 * MODEL_PROVIDER defaults to "anthropic", which keeps the published benchmark behaviour.
 */
export function createProviderFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  rates: Readonly<Record<string, ModelRate>>,
  dependencies: ProviderDependencies,
): ConfiguredProvider {
  const provider = z.enum(MODEL_PROVIDERS, { message: `MODEL_PROVIDER must be one of: ${MODEL_PROVIDERS.join(", ")}` }).parse(environment.MODEL_PROVIDER ?? "anthropic");
  if (provider === "anthropic") {
    const apiKey = z.string().min(1).safeParse(environment.ANTHROPIC_API_KEY);
    if (!apiKey.success) throw new Error("ANTHROPIC_API_KEY is required for live execution");
    return { provider, adapter: new AnthropicAdapter(dependencies.createAnthropicClient(apiKey.data), rates), models: ANTHROPIC_MODEL_ROLES };
  }
  const parsed = OpenAiCompatibleEnvironmentSchema.safeParse(environment);
  if (!parsed.success) throw new Error(`Invalid OpenAI-compatible configuration: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const values = parsed.data;
  const models: ModelRoles = {
    executor: values.OPENAI_COMPATIBLE_EXECUTOR_MODEL,
    router: values.OPENAI_COMPATIBLE_ROUTER_MODEL ?? values.OPENAI_COMPATIBLE_EXECUTOR_MODEL,
    simpleExecutor: values.OPENAI_COMPATIBLE_SIMPLE_MODEL ?? values.OPENAI_COMPATIBLE_ROUTER_MODEL ?? values.OPENAI_COMPATIBLE_EXECUTOR_MODEL,
  };
  const modelIds = [...new Set(Object.values(models))];
  const unpriced = modelIds.filter((model) => !rates[model]);
  if (unpriced.length > 0) throw new Error(`Missing pricing rate for model: ${unpriced.join(", ")}. Add it to the pricing file named by the experiment config.`);
  return {
    provider,
    models,
    adapter: new OpenAiCompatibleAdapter({
      baseUrl: values.OPENAI_COMPATIBLE_BASE_URL,
      models: modelIds,
      rates,
      fetch: dependencies.fetch,
      maxTokensField: values.OPENAI_COMPATIBLE_MAX_TOKENS_FIELD,
      acceptsTemperature: values.OPENAI_COMPATIBLE_TEMPERATURE === "supported",
      ...(values.OPENAI_COMPATIBLE_API_KEY === undefined ? {} : { apiKey: values.OPENAI_COMPATIBLE_API_KEY }),
    }),
  };
}
