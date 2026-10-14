import { describe, expect, it, vi } from "vitest";
import { ANTHROPIC_MODEL_CAPABILITIES, ANTHROPIC_MODELS, AnthropicAdapter } from "../src/adapter.js";
import { NORMALIZED_STOP_REASONS } from "../src/contracts.js";
import { decodeAssistantTurn, encodeAssistantTurn } from "../src/providers/assistant-turn.js";
import { costForUsage } from "../src/pricing.js";
import { runAgent } from "../src/runner.js";
import { DEFAULT_AGENT_POLICY } from "../src/config.js";
import { createSyntheticTools } from "../src/tools.js";

const rates = {
  [ANTHROPIC_MODELS.haiku55]: { input: 0.1, output: 0.5, longPrompt: { thresholdTokens: 100_000, input: 0.5, output: 2.5 } },
  [ANTHROPIC_MODELS.sonnet55]: { input: 2, output: 10 },
  [ANTHROPIC_MODELS.opus55]: { input: 4, output: 20 },
};

const signal = () => new AbortController().signal;

const reply = (model: string, content: readonly unknown[], stopReason = "end_turn") => ({
  model,
  stop_reason: stopReason,
  usage: { input_tokens: 10, output_tokens: 5 },
  content,
});

describe("5.5 model pins", () => {
  it("pins exact 5.5 ids without date suffixes", () => {
    expect(ANTHROPIC_MODELS.haiku55).toBe("claude-haiku-5-5");
    expect(ANTHROPIC_MODELS.sonnet55).toBe("claude-sonnet-5-5");
    expect(ANTHROPIC_MODELS.opus55).toBe("claude-opus-5-5");
  });

  it.each([ANTHROPIC_MODELS.haiku55, ANTHROPIC_MODELS.sonnet55, ANTHROPIC_MODELS.opus55])("declares %s as adaptive thinking without temperature", (model) => {
    const capabilities = ANTHROPIC_MODEL_CAPABILITIES[model]!;
    expect(capabilities.acceptsTemperature).toBe(false);
    expect(capabilities.thinking).toBe("adaptive");
    expect(capabilities.defaultTemperature).toBeUndefined();
  });

  it("leaves the legacy pins without a thinking declaration so their requests are unchanged", () => {
    expect(ANTHROPIC_MODEL_CAPABILITIES[ANTHROPIC_MODELS.sonnet]!.thinking).toBeUndefined();
    expect(ANTHROPIC_MODEL_CAPABILITIES[ANTHROPIC_MODELS.haiku]!.thinking).toBeUndefined();
  });
});

describe("5.5 request body", () => {
  it.each([
    [ANTHROPIC_MODELS.haiku55, "low"],
    [ANTHROPIC_MODELS.sonnet55, "medium"],
    [ANTHROPIC_MODELS.opus55, "high"],
  ] as const)("sends adaptive thinking and effort for %s", async (model, effort) => {
    const create = vi.fn().mockResolvedValue(reply(model, [{ type: "text", text: "ok" }]));
    const adapter = new AnthropicAdapter({ messages: { create } }, rates);
    await adapter.generate({ model, effort, messages: [{ role: "user", content: "hola" }], tools: [], maxOutputTokens: 1024, signal: signal() });
    const body = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort });
    expect(body).not.toHaveProperty("temperature");
  });

  it("omits output_config when no effort is requested", async () => {
    const create = vi.fn().mockResolvedValue(reply(ANTHROPIC_MODELS.sonnet55, [{ type: "text", text: "ok" }]));
    const adapter = new AnthropicAdapter({ messages: { create } }, rates);
    await adapter.generate({ model: ANTHROPIC_MODELS.sonnet55, messages: [], tools: [], maxOutputTokens: 1024, signal: signal() });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("output_config");
  });

  it.each([ANTHROPIC_MODELS.haiku55, ANTHROPIC_MODELS.sonnet55, ANTHROPIC_MODELS.opus55])("rejects a temperature for %s before calling the provider", async (model) => {
    const create = vi.fn();
    const adapter = new AnthropicAdapter({ messages: { create } }, rates);
    await expect(adapter.generate({ model, messages: [], tools: [], temperature: 0, maxOutputTokens: 10, signal: signal() })).rejects.toThrow(`${model} does not accept temperature`);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an effort for a model that does not declare adaptive thinking", async () => {
    const create = vi.fn();
    const adapter = new AnthropicAdapter({ messages: { create } }, { [ANTHROPIC_MODELS.haiku]: { input: 1, output: 5 } });
    await expect(adapter.generate({ model: ANTHROPIC_MODELS.haiku, effort: "low", messages: [], tools: [], maxOutputTokens: 10, signal: signal() })).rejects.toThrow("does not accept effort");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("thinking replay", () => {
  const thinkingTurn = [
    { type: "thinking", thinking: "", signature: "sig-1" },
    { type: "text", text: "Consulto la factura." },
    { type: "tool_use", id: "call-1", name: "get_document", input: { documentId: "INV-001" } },
  ];

  it("returns the raw assistant blocks for adaptive-thinking models", async () => {
    const create = vi.fn().mockResolvedValue(reply(ANTHROPIC_MODELS.sonnet55, thinkingTurn, "tool_use"));
    const adapter = new AnthropicAdapter({ messages: { create } }, rates);
    const response = await adapter.generate({ model: ANTHROPIC_MODELS.sonnet55, messages: [], tools: [], maxOutputTokens: 1024, signal: signal() });
    expect(response.providerContent).toEqual(thinkingTurn);
  });

  it("does not return raw blocks for legacy models", async () => {
    const create = vi.fn().mockResolvedValue(reply(ANTHROPIC_MODELS.sonnet, thinkingTurn, "tool_use"));
    const adapter = new AnthropicAdapter({ messages: { create } }, { [ANTHROPIC_MODELS.sonnet]: { input: 2, output: 10 } });
    const response = await adapter.generate({ model: ANTHROPIC_MODELS.sonnet, messages: [], tools: [], maxOutputTokens: 1024, signal: signal() });
    expect(response.providerContent).toBeUndefined();
  });

  it("round-trips provider content through the assistant-turn codec and leaves plain turns unchanged", () => {
    const plain = { text: "a", toolCalls: [] };
    expect(encodeAssistantTurn(plain)).toBe(JSON.stringify({ text: "a", toolCalls: [] }));
    const withContent = { text: "a", toolCalls: [], providerContent: thinkingTurn };
    expect(decodeAssistantTurn(encodeAssistantTurn(withContent))).toEqual(withContent);
  });

  it("replays thinking blocks verbatim on the next request", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(reply(ANTHROPIC_MODELS.sonnet55, thinkingTurn, "tool_use"))
      .mockResolvedValueOnce(reply(ANTHROPIC_MODELS.sonnet55, [{ type: "text", text: JSON.stringify({ outcome: "completed", answer: "1160", claims: [] }) }]));
    const adapter = new AnthropicAdapter({ messages: { create } }, rates);
    const result = await runAgent({
      caseId: "replay", seed: 1, prompt: "Consulta INV-001", systemPrompt: "s", model: ANTHROPIC_MODELS.sonnet55,
      adapter, tools: createSyntheticTools(), policy: DEFAULT_AGENT_POLICY,
    });
    expect(result.outcome).toBe("completed");
    const second = create.mock.calls[1]?.[0] as { messages: readonly { role: string; content: unknown }[] };
    const assistant = second.messages.find(({ role }) => role === "assistant");
    expect(assistant?.content).toEqual(thinkingTurn);
  });
});

describe("review follow-ups", () => {
  it("replays raw blocks with fields the parser does not model, and redacted thinking", async () => {
    const turn = [
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "Consulto.", citations: null },
      { type: "tool_use", id: "call-1", name: "get_document", input: { documentId: "INV-001" }, caller: { type: "direct" } },
    ];
    const create = vi.fn()
      .mockResolvedValueOnce(reply(ANTHROPIC_MODELS.opus55, turn, "tool_use"))
      .mockResolvedValueOnce(reply(ANTHROPIC_MODELS.opus55, [{ type: "text", text: JSON.stringify({ outcome: "completed", answer: "1160", claims: [] }) }]));
    const adapter = new AnthropicAdapter({ messages: { create } }, rates);
    await runAgent({ caseId: "raw", seed: 1, prompt: "x", systemPrompt: "s", model: ANTHROPIC_MODELS.opus55, adapter, tools: createSyntheticTools(), policy: DEFAULT_AGENT_POLICY });
    const second = create.mock.calls[1]?.[0] as { messages: readonly { role: string; content: unknown }[] };
    expect(second.messages.find(({ role }) => role === "assistant")?.content).toEqual(turn);
  });

  it("does not return provider content for an empty turn", async () => {
    const create = vi.fn().mockResolvedValue(reply(ANTHROPIC_MODELS.sonnet55, []));
    const adapter = new AnthropicAdapter({ messages: { create } }, rates);
    const response = await adapter.generate({ model: ANTHROPIC_MODELS.sonnet55, messages: [], tools: [], maxOutputTokens: 1024, signal: signal() });
    expect(response.providerContent).toBeUndefined();
  });

  it("forwards effort from the runner only to adaptive-thinking models", async () => {
    const final = [{ type: "text", text: JSON.stringify({ outcome: "abstained", answer: "x", claims: [] }) }];
    for (const [model, expected] of [[ANTHROPIC_MODELS.sonnet55, { effort: "medium" }], [ANTHROPIC_MODELS.sonnet, undefined]] as const) {
      const create = vi.fn().mockResolvedValue(reply(model, final));
      const adapter = new AnthropicAdapter({ messages: { create } }, { ...rates, [ANTHROPIC_MODELS.sonnet]: { input: 2, output: 10 } });
      await runAgent({ caseId: "e", seed: 1, prompt: "x", systemPrompt: "s", model, effort: "medium", adapter, tools: createSyntheticTools(), policy: DEFAULT_AGENT_POLICY });
      const body = create.mock.calls[0]?.[0] as Record<string, unknown>;
      if (expected) expect(body.output_config).toEqual(expected);
      else expect(body).not.toHaveProperty("output_config");
    }
  });

  it("prices a long Haiku 5.5 prompt on the long-prompt card inside generate", async () => {
    const create = vi.fn().mockResolvedValue({ ...reply(ANTHROPIC_MODELS.haiku55, [{ type: "text", text: "ok" }]), usage: { input_tokens: 150_000, output_tokens: 10 } });
    const adapter = new AnthropicAdapter({ messages: { create } }, rates);
    const response = await adapter.generate({ model: ANTHROPIC_MODELS.haiku55, messages: [], tools: [], maxOutputTokens: 1024, signal: signal() });
    expect(response.usage.costUsd).toBeCloseTo((150_000 * 0.5 + 10 * 2.5) / 1_000_000, 12);
  });
});

describe("refusals", () => {
  it("normalizes a refusal stop reason with its category", async () => {
    const create = vi.fn().mockResolvedValue({ ...reply(ANTHROPIC_MODELS.opus55, [], "refusal"), stop_details: { type: "refusal", category: "cyber", explanation: "x" } });
    const adapter = new AnthropicAdapter({ messages: { create } }, rates);
    const response = await adapter.generate({ model: ANTHROPIC_MODELS.opus55, messages: [], tools: [], maxOutputTokens: 1024, signal: signal() });
    expect(response.stopReason).toBe(NORMALIZED_STOP_REASONS.refusal);
    expect(response.refusalCategory).toBe("cyber");
    expect(response.usage.costUsd).toBeGreaterThan(0);
  });

  it("ends the run as an error outcome without throwing, keeping usage", async () => {
    const create = vi.fn().mockResolvedValue({ ...reply(ANTHROPIC_MODELS.opus55, [], "refusal"), stop_details: { type: "refusal", category: null, explanation: null } });
    const adapter = new AnthropicAdapter({ messages: { create } }, rates);
    const result = await runAgent({
      caseId: "refusal", seed: 1, prompt: "x", systemPrompt: "s", model: ANTHROPIC_MODELS.opus55,
      adapter, tools: createSyntheticTools(), policy: DEFAULT_AGENT_POLICY,
    });
    expect(result.outcome).toBe("error");
    expect(result.answer).toBe("Model refusal");
    expect(result.usage.tokens).toBe(15);
    expect(result.events.some(({ type, payload }) => type === "error" && payload.phase === "refusal")).toBe(true);
  });
});

describe("long-prompt rate card", () => {
  const rate = rates[ANTHROPIC_MODELS.haiku55];

  it("uses the standard rate at or below the threshold", () => {
    expect(costForUsage(rate, 100_000, 1_000)).toBeCloseTo((100_000 * 0.1 + 1_000 * 0.5) / 1_000_000, 12);
  });

  it("uses the long-prompt rate above the threshold for the whole request", () => {
    expect(costForUsage(rate, 100_001, 1_000)).toBeCloseTo((100_001 * 0.5 + 1_000 * 2.5) / 1_000_000, 12);
  });

  it("prices flat rates unchanged", () => {
    expect(costForUsage({ input: 2, output: 10 }, 12, 4)).toBe((12 * 2 + 4 * 10) / 1_000_000);
  });
});
