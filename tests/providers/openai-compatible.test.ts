import { describe, expect, it, vi } from "vitest";
import { ANTHROPIC_MODEL_ROLES, normalizeAnthropicError } from "../../src/adapter.js";
import { ModelProviderError, providerErrorCodeForStatus, type ModelResponse } from "../../src/contracts.js";
import { decodeAssistantTurn, encodeAssistantTurn } from "../../src/providers/assistant-turn.js";
import { createProviderFromEnvironment } from "../../src/providers/factory.js";
import { OpenAiCompatibleAdapter, type FetchLike } from "../../src/providers/openai-compatible.js";
import { simulatedOpenAiCompatible } from "../helpers/wire-simulators.js";

const rates = { "local-large": { input: 0.5, output: 1.5 }, "local-small": { input: 0.1, output: 0.3 } };
const reply = (value: Partial<ModelResponse> = {}) => async (): Promise<ModelResponse> => ({ text: "ok", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, costUsd: 0 }, modelId: "local-large", latencyMs: 0, ...value });
const request = { model: "local-large", messages: [{ role: "user" as const, content: "Hi" }], tools: [], maxOutputTokens: 50, signal: new AbortController().signal };
const wireResponse = (body: unknown): FetchLike => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const adapterWith = (fetch: FetchLike) => new OpenAiCompatibleAdapter({ baseUrl: "http://localhost:1234/v1", models: ["local-large"], rates, fetch });

describe("OpenAI-compatible adapter", () => {
  it("posts to chat completions with a bearer token and omits an empty tool list", async () => {
    const provider = simulatedOpenAiCompatible(reply(), rates, { baseUrl: "http://localhost:1234/v1/", apiKey: "test-key" });
    await provider.adapter.generate(request);
    expect(provider.calls[0]).toEqual({ url: "http://localhost:1234/v1/chat/completions", headers: { "content-type": "application/json", authorization: "Bearer test-key" } });
    expect(provider.wire[0]).toEqual({ model: "local-large", max_tokens: 50, messages: [{ role: "user", content: "Hi" }] });
  });

  it("sends no authorization header without a key and supports max_completion_tokens", async () => {
    const provider = simulatedOpenAiCompatible(reply(), rates, { maxTokensField: "max_completion_tokens" });
    await provider.adapter.generate({ ...request, temperature: 0 });
    expect(provider.calls[0]!.headers).toEqual({ "content-type": "application/json" });
    expect(provider.wire[0]).toMatchObject({ max_completion_tokens: 50, temperature: 0 });
    expect(provider.wire[0]).not.toHaveProperty("max_tokens");
  });

  it("encodes tools as functions and tool calls with string arguments", async () => {
    const provider = simulatedOpenAiCompatible(reply(), rates);
    await provider.adapter.generate({
      ...request,
      tools: [{ name: "get_document", description: "Gets one", inputSchema: { type: "object" } }],
      messages: [
        { role: "user", content: "Find it" },
        { role: "assistant", content: encodeAssistantTurn({ text: "", toolCalls: [{ id: "call-1", name: "get_document", input: { documentId: "INV-001" } }] }) },
        { role: "tool", toolCallId: "call-1", content: "{\"ok\":true}" },
        { role: "assistant", content: "plain text turn" },
      ],
    });
    expect(provider.wire[0]).toMatchObject({
      tools: [{ type: "function", function: { name: "get_document", description: "Gets one", parameters: { type: "object" } } }],
      messages: [
        { role: "user", content: "Find it" },
        { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "get_document", arguments: "{\"documentId\":\"INV-001\"}" } }] },
        { role: "tool", tool_call_id: "call-1", content: "{\"ok\":true}" },
        { role: "assistant", content: "plain text turn" },
      ],
    });
  });

  it("maps finish reasons and passes unknown ones through", async () => {
    const finish = async (reason: string | null) => (await adapterWith(wireResponse({ model: "local-large", choices: [{ finish_reason: reason, message: { content: null } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })).generate(request)).stopReason;
    expect(await finish("stop")).toBe("end_turn");
    expect(await finish("tool_calls")).toBe("tool_use");
    expect(await finish("function_call")).toBe("tool_use");
    expect(await finish("length")).toBe("max_tokens");
    expect(await finish("content_filter")).toBe("refusal");
    expect(await finish("something_new")).toBe("something_new");
    expect(await finish(null)).toBe("unknown");
  });

  it("passes malformed tool arguments through so the tool schema rejects them", async () => {
    const result = await adapterWith(wireResponse({
      model: "local-large",
      choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", function: { name: "get_document", arguments: "{not json" } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })).generate(request);
    expect(result).toMatchObject({ text: "", toolCalls: [{ id: "c1", name: "get_document", input: "{not json" }] });
  });

  it("reports only the status on HTTP errors, never the response body", async () => {
    const provider = simulatedOpenAiCompatible(reply(), rates, {}, { status: 429 });
    const error = await provider.adapter.generate(request).catch((caught: unknown) => caught) as ModelProviderError;
    expect(error.message).toBe("OpenAI-compatible request failed with status 429");
    expect(error.message).not.toContain("secret");
  });

  it("classifies aborts and non-JSON bodies", async () => {
    const controller = new AbortController();
    const aborting: FetchLike = async () => { controller.abort(); throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" }); };
    await expect(adapterWith(aborting).generate({ ...request, signal: controller.signal })).rejects.toMatchObject({ code: "aborted", retryable: false });
    await expect(adapterWith(async () => { throw "plain string failure"; }).generate(request)).rejects.toMatchObject({ code: "server", message: "plain string failure" });
    await expect(adapterWith(async () => ({ ok: true, status: 200, text: async () => "<html>" })).generate(request)).rejects.toMatchObject({ code: "invalid_response", status: 200 });
  });

  it("stops reading a streamed body at the size limit instead of buffering it", async () => {
    let reads = 0;
    let cancelled = false;
    const endless: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => { throw new Error("text() must not be used when a stream is available"); },
      body: { getReader: () => ({ read: async () => { reads += 1; return { done: false, value: new Uint8Array(400) }; }, cancel: async () => { cancelled = true; } }) },
    });
    const adapter = new OpenAiCompatibleAdapter({ baseUrl: "http://localhost/v1", models: ["local-large"], rates, fetch: endless, maxResponseBytes: 1_000 });
    await expect(adapter.generate(request)).rejects.toMatchObject({ name: "ModelProviderError", code: "invalid_response", message: "OpenAI-compatible response exceeded the size limit" });
    expect(reads).toBe(3);
    expect(cancelled).toBe(true);
  });

  it("reads a streamed body within the limit and bounds unstreamed bodies too", async () => {
    const payload = JSON.stringify({ model: "local-large", choices: [{ finish_reason: "stop", message: { content: "streamed" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const bytes = new TextEncoder().encode(payload);
    const queue: (Uint8Array | undefined)[] = [bytes.slice(0, 10), undefined, bytes.slice(10)];
    const streamed: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      body: { getReader: () => ({ read: async () => queue.length === 0 ? { done: true } : { done: false, ...(queue[0] === undefined ? {} : { value: queue[0] }), ...(queue.shift(), {}) }, cancel: async () => undefined }) },
    });
    expect((await adapterWith(streamed).generate(request)).text).toBe("streamed");
    const oversized = new OpenAiCompatibleAdapter({ baseUrl: "http://localhost/v1", models: ["local-large"], rates, fetch: wireResponse({ padding: "x".repeat(2_000) }), maxResponseBytes: 1_000 });
    await expect(oversized.generate(request)).rejects.toMatchObject({ code: "invalid_response", message: "OpenAI-compatible response exceeded the size limit" });
  });

  it("rejects a temperature when configured without temperature support", async () => {
    const fetch = vi.fn();
    const adapter = new OpenAiCompatibleAdapter({ baseUrl: "http://localhost/v1", models: ["local-large"], rates, fetch, acceptsTemperature: false, maxOutputTokensPerCall: 2_000 });
    expect(adapter.capabilities("local-large")).toEqual({ provider: "openai-compatible", acceptsTemperature: false, maxOutputTokensPerCall: 2_000, toolCalling: true, structuredOutput: "prompt" });
    await expect(adapter.generate({ ...request, temperature: 0 })).rejects.toThrow(/without temperature support/u);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("provider selection from the environment", () => {
  const dependencies = { createAnthropicClient: vi.fn(() => ({ messages: { create: vi.fn() } })), fetch: vi.fn() };
  const anthropicRates = { "claude-haiku-4-5-20251001": { input: 1, output: 5 }, "claude-sonnet-5": { input: 2, output: 10 } };

  it("defaults to Anthropic with the pinned roles and requires its key", () => {
    const configured = createProviderFromEnvironment({ ANTHROPIC_API_KEY: "key" }, anthropicRates, dependencies);
    expect(configured).toMatchObject({ provider: "anthropic", models: ANTHROPIC_MODEL_ROLES });
    expect(dependencies.createAnthropicClient).toHaveBeenCalledWith("key");
    expect(() => createProviderFromEnvironment({}, anthropicRates, dependencies)).toThrow("ANTHROPIC_API_KEY is required for live execution");
    expect(() => createProviderFromEnvironment({ MODEL_PROVIDER: "other" }, anthropicRates, dependencies)).toThrow(/MODEL_PROVIDER must be one of/u);
  });

  it("configures the OpenAI-compatible adapter and fills missing roles from the executor", () => {
    const environment = { MODEL_PROVIDER: "openai-compatible", OPENAI_COMPATIBLE_BASE_URL: "http://localhost:11434/v1", OPENAI_COMPATIBLE_EXECUTOR_MODEL: "local-large" };
    const single = createProviderFromEnvironment(environment, rates, dependencies);
    expect(single).toMatchObject({ provider: "openai-compatible", models: { executor: "local-large", router: "local-large", simpleExecutor: "local-large" } });
    expect(single.adapter.capabilities!("local-large")).toMatchObject({ acceptsTemperature: true, defaultTemperature: 0 });
    const routed = createProviderFromEnvironment({ ...environment, OPENAI_COMPATIBLE_ROUTER_MODEL: "local-small", OPENAI_COMPATIBLE_TEMPERATURE: "unsupported", OPENAI_COMPATIBLE_API_KEY: "k" }, rates, dependencies);
    expect(routed.models).toEqual({ executor: "local-large", router: "local-small", simpleExecutor: "local-small" });
    expect(routed.adapter.capabilities!("local-small").acceptsTemperature).toBe(false);
  });

  it("rejects incomplete configuration and unpriced models without touching the network", () => {
    expect(() => createProviderFromEnvironment({ MODEL_PROVIDER: "openai-compatible" }, rates, dependencies)).toThrow(/Invalid OpenAI-compatible configuration: OPENAI_COMPATIBLE_BASE_URL/u);
    expect(() => createProviderFromEnvironment({ MODEL_PROVIDER: "openai-compatible", OPENAI_COMPATIBLE_BASE_URL: "http://localhost/v1", OPENAI_COMPATIBLE_EXECUTOR_MODEL: "unpriced" }, rates, dependencies)).toThrow(/Missing pricing rate for model: unpriced/u);
    expect(dependencies.fetch).not.toHaveBeenCalled();
  });
});

describe("shared provider helpers", () => {
  it("round-trips assistant turns and treats plain text as plain text", () => {
    const turn = { text: "x", toolCalls: [{ id: "1", name: "t", input: { a: 1 } }] };
    expect(decodeAssistantTurn(encodeAssistantTurn(turn))).toEqual(turn);
    expect(decodeAssistantTurn("just words")).toBeNull();
    expect(decodeAssistantTurn("{\"text\":1}")).toBeNull();
  });

  it("maps HTTP statuses and Anthropic SDK error names to provider-neutral codes", () => {
    expect([401, 403, 408, 429, 500, 529, 404, 302].map(providerErrorCodeForStatus)).toEqual(["auth", "auth", "timeout", "rate_limit", "server", "server", "invalid_request", "unknown"]);
    const named = (name: string, status?: number) => normalizeAnthropicError(Object.assign(new Error("boom"), { name, ...(status === undefined ? {} : { status }) }));
    expect(named("APIUserAbortError")).toMatchObject({ code: "aborted", message: "boom", provider: "anthropic" });
    expect(named("APIConnectionTimeoutError")).toMatchObject({ code: "timeout", retryable: true });
    expect(named("APIConnectionError")).toMatchObject({ code: "server" });
    expect(named("RateLimitError", 429)).toMatchObject({ code: "rate_limit", status: 429 });
    expect(named("Error")).toMatchObject({ code: "unknown", retryable: false });
    expect(normalizeAnthropicError("text")).toMatchObject({ code: "unknown", message: "text" });
    const original = new ModelProviderError("kept", { code: "auth", provider: "anthropic" });
    expect(normalizeAnthropicError(original)).toBe(original);
  });
});
