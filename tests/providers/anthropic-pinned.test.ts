import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANTHROPIC_MODELS, AnthropicAdapter } from "../../src/adapter.js";
import { DEFAULT_AGENT_POLICY } from "../../src/config.js";
import { loadExperimentConfig, runExperiment } from "../../src/experiment.js";
import { runAgent } from "../../src/runner.js";
import { createSyntheticTools } from "../../src/tools.js";

const rates = { [ANTHROPIC_MODELS.haiku]: { input: 1, output: 5 }, [ANTHROPIC_MODELS.sonnet]: { input: 2, output: 10 } };

/** Fake Anthropic client that records every request and replies with one tool call, then a final answer. */
function recordingClient() {
  const requests: unknown[] = [];
  return {
    requests,
    client: {
      messages: {
        async create(request: Record<string, unknown>) {
          requests.push(JSON.parse(JSON.stringify(request)));
          const messages = request.messages as readonly { content: unknown }[];
          const routing = (request.tools as readonly unknown[]).length === 0;
          const sawToolResult = messages.some(({ content }) => Array.isArray(content) && content.some((block: { type?: string }) => block.type === "tool_result"));
          return {
            model: request.model,
            stop_reason: routing || sawToolResult ? "end_turn" : "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
            content: routing
              ? [{ type: "text", text: "simple-read-only" }]
              : sawToolResult
                ? [{ type: "text", text: JSON.stringify({ outcome: "completed", answer: "1160", claims: [] }) }]
                : [{ type: "tool_use", id: "call-1", name: "get_document", input: { documentId: "INV-001" } }],
          };
        },
      },
    },
  };
}

// These snapshots were recorded before the provider refactor. They pin the exact request the
// Anthropic adapter sends so that moving provider rules behind the adapter cannot change it.
describe("Anthropic request contract", () => {
  it.each([["sonnet", ANTHROPIC_MODELS.sonnet], ["haiku", ANTHROPIC_MODELS.haiku]])("sends an unchanged request sequence for %s execution", async (_label, model) => {
    const { client, requests } = recordingClient();
    const result = await runAgent({
      runId: "pinned",
      caseId: "case",
      seed: 1,
      prompt: "Find invoice INV-001 and report its total.",
      systemPrompt: "You are a bounded fiscal operations agent.",
      model,
      adapter: new AnthropicAdapter(client, rates),
      tools: createSyntheticTools(),
      policy: DEFAULT_AGENT_POLICY,
    });
    expect(result.outcome).toBe("completed");
    expect(requests).toHaveLength(2);
    expect(requests).toMatchSnapshot();
  });

  it("sends an unchanged routing request and routed execution through the experiment loop", async () => {
    const { client, requests } = recordingClient();
    const config = await loadExperimentConfig("config/smoke.v2.json");
    const runs = await runExperiment({
      config: { ...config, configurations: ["routed", "direct-sonnet"], repeats: 1 },
      adapter: new AnthropicAdapter(client, rates),
      outputPath: join(await mkdtemp(join(tmpdir(), "pinned-")), "results.jsonl"),
    });
    expect(runs).toHaveLength(8);
    expect(requests.map((request) => {
      const { model, max_tokens: maxTokens, temperature, system, tools } = request as { model: string; max_tokens: number; temperature?: number; system?: string; tools: readonly unknown[] };
      return { model, maxTokens, temperature: temperature ?? "omitted", routing: tools.length === 0, systemLength: system?.length ?? 0 };
    })).toMatchSnapshot();
    expect(requests.find((request) => (request as { tools: readonly unknown[] }).tools.length === 0)).toMatchSnapshot();
  });
});
