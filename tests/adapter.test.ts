import { describe, expect, it, vi } from "vitest";
import { ANTHROPIC_MODELS, AnthropicAdapter } from "../src/adapter.js";

const rates = {
  [ANTHROPIC_MODELS.haiku]: { input: 1, output: 5 },
  [ANTHROPIC_MODELS.sonnet]: { input: 2, output: 10 },
};

describe("AnthropicAdapter", () => {
  it("pins the current Sonnet model and retains the dated Haiku model", () => {
    expect(ANTHROPIC_MODELS).toEqual({
      haiku: "claude-haiku-4-5-20251001",
      sonnet: "claude-sonnet-5",
    });
  });

  it("normalizes provider output and records the returned model", async () => {
    const create = vi.fn().mockResolvedValue({
      model: ANTHROPIC_MODELS.sonnet,
      stop_reason: "tool_use",
      usage: { input_tokens: 12, output_tokens: 4 },
      content: [{ type: "tool_use", id: "call-1", name: "get_document", input: { id: "x" } }],
    });
    const adapter = new AnthropicAdapter({ messages: { create } }, rates);
    const result = await adapter.generate({
      model: ANTHROPIC_MODELS.sonnet,
      messages: [{ role: "user", content: "Find it" }],
      tools: [{ name: "get_document", description: "Gets one", inputSchema: { type: "object" } }],
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    });
    expect(result.modelId).toBe(ANTHROPIC_MODELS.sonnet);
    expect(result.toolCalls).toEqual([
      { id: "call-1", name: "get_document", input: { id: "x" } },
    ]);
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("temperature");
    expect(result.usage.costUsd).toBe((12 * 2 + 4 * 10) / 1_000_000);
  });

  it("passes an explicitly configured temperature to Haiku", async () => {
    const create = vi.fn().mockResolvedValue({
      model: ANTHROPIC_MODELS.haiku,
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "text", text: "simple-read-only" }],
    });
    const adapter = new AnthropicAdapter({ messages: { create } }, rates);
    const result = await adapter.generate({
      model: ANTHROPIC_MODELS.haiku,
      messages: [{ role: "user", content: "Classify" }],
      tools: [],
      temperature: 0,
      maxOutputTokens: 40,
      signal: new AbortController().signal,
    });
    expect(create.mock.calls[0]?.[0]).toHaveProperty("temperature", 0);
    expect(result.usage.costUsd).toBe(6 / 1_000_000);
  });

  it("rejects a defined Sonnet 5 temperature before calling the provider", async () => {
    const create = vi.fn();
    const adapter = new AnthropicAdapter({ messages: { create } }, rates);
    await expect(adapter.generate({
      model: ANTHROPIC_MODELS.sonnet,
      messages: [],
      tools: [],
      temperature: 0,
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    })).rejects.toThrow("Sonnet 5 does not accept temperature");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects models without injected pricing before calling the provider", async () => {
    const create = vi.fn();
    const adapter = new AnthropicAdapter({ messages: { create } }, {
      [ANTHROPIC_MODELS.haiku]: rates[ANTHROPIC_MODELS.haiku],
    });
    await expect(adapter.generate({
      model: ANTHROPIC_MODELS.sonnet,
      messages: [],
      tools: [],
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    })).rejects.toThrow("Missing pricing rate");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects model aliases", async () => {
    const adapter = new AnthropicAdapter({ messages: { create: vi.fn() } }, rates);
    await expect(
      adapter.generate({ model: "claude-sonnet-latest", messages: [], tools: [], temperature: 0, maxOutputTokens: 10, signal: new AbortController().signal }),
    ).rejects.toThrow("Unpinned");
  });

  it("preserves assistant tool-use blocks before tool results", async () => {
    const create = vi.fn().mockResolvedValue({
      model: ANTHROPIC_MODELS.sonnet,
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
      content: [{ type: "text", text: "done" }],
    });
    const adapter = new AnthropicAdapter({ messages: { create } }, rates);
    await adapter.generate({
      model: ANTHROPIC_MODELS.sonnet,
      messages: [
        { role: "user", content: "Find it" },
        { role: "assistant", content: JSON.stringify({ text: "", toolCalls: [{ id: "call-1", name: "get_document", input: { documentId: "INV-001" } }] }) },
        { role: "tool", toolCallId: "call-1", content: "{\"ok\":true}" },
      ],
      tools: [], maxOutputTokens: 100, signal: new AbortController().signal,
    });
    const providerRequest = create.mock.calls[0]?.[0] as { messages: Array<{ content: unknown }> };
    expect(providerRequest.messages[1]?.content).toEqual([{ type: "tool_use", id: "call-1", name: "get_document", input: { documentId: "INV-001" } }]);
    expect(providerRequest.messages[2]?.content).toEqual([{ type: "tool_result", tool_use_id: "call-1", content: "{\"ok\":true}" }]);
  });
});
