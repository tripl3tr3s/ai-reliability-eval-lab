import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANTHROPIC_MODEL_ROLES, ANTHROPIC_MODELS } from "../../src/adapter.js";
import { DEFAULT_AGENT_POLICY } from "../../src/config.js";
import { ModelProviderError, PROVIDER_ERROR_CODES, type ModelRequest, type ModelResponse, type ModelRoles } from "../../src/contracts.js";
import { loadDataset } from "../../src/dataset.js";
import { loadExperimentConfig, runExperiment } from "../../src/experiment.js";
import { runGate } from "../../src/gate-command.js";
import { createScriptedModel } from "../../src/mock/scripted-model.js";
import { encodeAssistantTurn } from "../../src/providers/assistant-turn.js";
import { capabilitiesFor, GENERIC_CAPABILITIES } from "../../src/providers/capabilities.js";
import { MOCK_MODEL_PREFIX } from "../../src/raw-run.js";
import { runAgent } from "../../src/runner.js";
import { createSyntheticTools } from "../../src/tools.js";
import { assistantTurnOf, simulatedAnthropic, simulatedOpenAiCompatible, type Brain, type SimulatedProvider, type WireFailure } from "../helpers/wire-simulators.js";

interface Harness {
  readonly name: string;
  readonly roles: ModelRoles;
  readonly rates: Readonly<Record<string, { input: number; output: number }>>;
  build(brain: Brain, failure?: WireFailure, rates?: Readonly<Record<string, { input: number; output: number }>>): SimulatedProvider;
}

const anthropicRates = { [ANTHROPIC_MODELS.haiku]: { input: 1, output: 5 }, [ANTHROPIC_MODELS.sonnet]: { input: 2, output: 10 } };
const openAiRoles: ModelRoles = { executor: "local-large", router: "local-small", simpleExecutor: "local-small" };
const openAiRates = { "local-large": { input: 0.5, output: 1.5 }, "local-small": { input: 0.1, output: 0.3 } };

// Every adapter must pass every test in this file. Add a new adapter by adding one harness.
const harnesses: readonly Harness[] = [
  { name: "anthropic", roles: ANTHROPIC_MODEL_ROLES, rates: anthropicRates, build: (brain, failure, rates = anthropicRates) => simulatedAnthropic(brain, rates, failure) },
  { name: "openai-compatible", roles: openAiRoles, rates: openAiRates, build: (brain, failure, rates = openAiRates) => simulatedOpenAiCompatible(brain, rates, { models: Object.values(openAiRoles) }, failure) },
];

const reply = (value: Partial<ModelResponse>): Brain => async (request) => ({
  text: "", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1_000, outputTokens: 200, costUsd: 0 }, modelId: request.model, latencyMs: 0, ...value,
});
const requestFor = (model: string, overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  model, messages: [{ role: "user", content: "Find it" }], tools: [], maxOutputTokens: 100, signal: new AbortController().signal, ...overrides,
});

describe.each(harnesses)("adapter contract: $name", ({ roles, rates, build }) => {
  it("returns text with normalized stop reason, usage, and cost from the pricing rates", async () => {
    const { adapter } = build(reply({ text: "hello", modelId: `${roles.executor}-2026` }));
    const result = await adapter.generate(requestFor(roles.executor));
    const rate = rates[roles.executor]!;
    expect(result).toMatchObject({ text: "hello", toolCalls: [], stopReason: "end_turn", modelId: `${roles.executor}-2026`, usage: { inputTokens: 1_000, outputTokens: 200 } });
    expect(result.usage.costUsd).toBeCloseTo((1_000 * rate.input + 200 * rate.output) / 1_000_000, 12);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("normalizes tool calls with parsed arguments", async () => {
    const { adapter } = build(reply({ stopReason: "tool_use", toolCalls: [{ id: "call-1", name: "get_document", input: { documentId: "INV-001", nested: { n: 1 } } }] }));
    const result = await adapter.generate(requestFor(roles.executor));
    expect(result).toMatchObject({ text: "", stopReason: "tool_use", toolCalls: [{ id: "call-1", name: "get_document", input: { documentId: "INV-001", nested: { n: 1 } } }] });
  });

  it("maps the provider's output-limit signal to max_tokens", async () => {
    const { adapter } = build(reply({ text: "cut off", stopReason: "max_tokens" }));
    expect((await adapter.generate(requestFor(roles.executor))).stopReason).toBe("max_tokens");
  });

  it("delivers system, user, assistant tool-call, and tool-result turns intact", async () => {
    const seen: ModelRequest[] = [];
    const { adapter } = build(async (request) => { seen.push(request); return reply({ text: "done" })(request); });
    await adapter.generate(requestFor(roles.executor, {
      messages: [
        { role: "system", content: "Be careful." },
        { role: "user", content: "Find INV-001" },
        { role: "assistant", content: encodeAssistantTurn({ text: "Looking", toolCalls: [{ id: "call-1", name: "get_document", input: { documentId: "INV-001" } }] }) },
        { role: "tool", toolCallId: "call-1", content: "{\"ok\":true}" },
      ],
    }));
    const [system, user, assistant, tool] = seen[0]!.messages;
    expect(system).toEqual({ role: "system", content: "Be careful." });
    expect(user).toEqual({ role: "user", content: "Find INV-001" });
    expect(assistantTurnOf(assistant)).toEqual({ text: "Looking", toolCalls: [{ id: "call-1", name: "get_document", input: { documentId: "INV-001" } }] });
    expect(tool).toEqual({ role: "tool", toolCallId: "call-1", content: "{\"ok\":true}" });
  });

  it("passes tool definitions, output limit, temperature, and the abort signal through", async () => {
    const seen: ModelRequest[] = [];
    const { adapter } = build(async (request) => { seen.push(request); return reply({ text: "ok" })(request); });
    const controller = new AbortController();
    const tools = [{ name: "get_document", description: "Gets one", inputSchema: { type: "object", properties: { documentId: { type: "string" } }, required: ["documentId"] } }];
    const temperature = adapter.capabilities!(roles.router).acceptsTemperature ? { temperature: 0 } : {};
    await adapter.generate(requestFor(roles.router, { tools, maxOutputTokens: 321, signal: controller.signal, ...temperature }));
    expect(seen[0]).toMatchObject({ model: roles.router, tools, maxOutputTokens: 321, ...temperature });
    expect(seen[0]!.signal).toBe(controller.signal);
  });

  it.each([[429, "rate_limit", true], [401, "auth", false], [400, "invalid_request", false], [503, "server", true]] as const)(
    "normalizes HTTP %i to a %s provider error", async (status, code, retryable) => {
      const { adapter } = build(reply({}), { status });
      const error = await adapter.generate(requestFor(roles.executor)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ModelProviderError);
      expect(error).toMatchObject({ code, retryable, status });
      expect(PROVIDER_ERROR_CODES).toContain((error as ModelProviderError).code);
    });

  it("normalizes connection failures and malformed responses", async () => {
    await expect(build(reply({}), { network: "socket hang up" }).adapter.generate(requestFor(roles.executor))).rejects.toMatchObject({ name: "ModelProviderError", code: "server", retryable: true });
    await expect(build(reply({}), { malformed: true }).adapter.generate(requestFor(roles.executor))).rejects.toMatchObject({ name: "ModelProviderError", code: "invalid_response", retryable: false });
  });

  it("refuses unknown models and unpriced models before any provider call", async () => {
    const unknown = build(reply({}));
    await expect(unknown.adapter.generate(requestFor("some-other-model"))).rejects.toThrow(/Unpinned|Unconfigured/u);
    expect(() => unknown.adapter.capabilities!("some-other-model")).toThrow(/Unpinned|Unconfigured/u);
    expect(unknown.wire).toHaveLength(0);
    const unpriced = build(reply({}), undefined, { [roles.router]: rates[roles.router]! });
    if (roles.executor !== roles.router) {
      await expect(unpriced.adapter.generate(requestFor(roles.executor))).rejects.toThrow(/Missing pricing rate|Unconfigured/u);
      expect(unpriced.wire).toHaveLength(0);
    }
  });

  it("declares complete capabilities that the runner then honours on the wire", async () => {
    const provider = build(reply({ text: JSON.stringify({ outcome: "completed", answer: "ok", claims: [] }) }));
    for (const model of new Set(Object.values(roles))) {
      const capabilities = provider.adapter.capabilities!(model);
      expect(capabilities).toMatchObject({ provider: expect.any(String), acceptsTemperature: expect.any(Boolean), toolCalling: true, structuredOutput: "prompt" });
      expect(capabilities.maxOutputTokensPerCall).toBeGreaterThan(0);
      expect(capabilitiesFor(provider.adapter, model)).toEqual(capabilities);
      provider.wire.length = 0;
      await runAgent({ caseId: "case", seed: 1, prompt: "Find it", systemPrompt: "Be careful.", model, adapter: provider.adapter, tools: createSyntheticTools(), policy: DEFAULT_AGENT_POLICY });
      const sent = provider.wire[0]!;
      expect(sent.max_tokens ?? sent.max_completion_tokens).toBe(Math.min(capabilities.maxOutputTokensPerCall, DEFAULT_AGENT_POLICY.maxTokens));
      expect("temperature" in sent).toBe(capabilities.acceptsTemperature && capabilities.defaultTemperature !== undefined);
    }
  });

  it("runs the whole benchmark and the gate end to end in mock mode", async () => {
    const dataset = await loadDataset("datasets/v2/manifest.json");
    const scripted = createScriptedModel(dataset.cases);
    const provider = build(async (request) => ({ ...(await scripted.generate(request)), modelId: `${MOCK_MODEL_PREFIX}${request.model}` }));
    const raw = join(await mkdtemp(join(tmpdir(), "provider-e2e-")), "results.jsonl");
    const runs = await runExperiment({ config: await loadExperimentConfig("config/full.v2.json"), adapter: provider.adapter, models: roles, outputPath: raw, policyOverrides: { toolTimeoutMs: 25 } });
    expect(runs).toHaveLength(450);
    expect(new Set(runs.flatMap(({ modelIds }) => modelIds ?? []))).toEqual(new Set(Object.values(roles).map((model) => `${MOCK_MODEL_PREFIX}${model}`)));
    const { report } = await runGate({ rawPath: raw, configPath: "config/full.v2.json", thresholdsPath: "config/thresholds.v1.json", candidate: "routed" });
    expect(report).toMatchObject({ decision: "PASS", exitCode: 0, dataSource: "mock", candidate: { cases: 30, runs: 150 } });
    expect(report.checks.every(({ passed }) => passed)).toBe(true);
  }, 60_000);
});

describe("provider independence", () => {
  it("produces the same scored behaviour through both adapters", async () => {
    const dataset = await loadDataset("datasets/v2/manifest.json");
    const scripted = createScriptedModel(dataset.cases);
    const config = { ...(await loadExperimentConfig("config/full.v2.json")), repeats: 1 };
    const behaviour = async ({ roles, build }: Harness) => {
      const provider = build((request) => scripted.generate(request));
      const runs = await runExperiment({ config, adapter: provider.adapter, models: roles, outputPath: join(await mkdtemp(join(tmpdir(), "provider-parity-")), "results.jsonl"), policyOverrides: { toolTimeoutMs: 25 } });
      return runs.map(({ runId, outcome, answer, finalState, toolCalls, claims, policyViolation, duplicateMutation }) => ({ runId, outcome, answer, finalState, toolCalls, claims, policyViolation, duplicateMutation }));
    };
    const [first, second] = await Promise.all(harnesses.map(behaviour));
    expect(first).toHaveLength(90);
    expect(second).toEqual(first);
  }, 60_000);

  it("falls back to the pinned registry, then to generic defaults, for adapters that declare nothing", () => {
    const bare = { generate: reply({}) };
    expect(capabilitiesFor(bare, ANTHROPIC_MODELS.sonnet)).toMatchObject({ acceptsTemperature: false, maxOutputTokensPerCall: 8_192 });
    expect(capabilitiesFor(bare, ANTHROPIC_MODELS.haiku)).toMatchObject({ acceptsTemperature: true, defaultTemperature: 0, maxOutputTokensPerCall: 4_096 });
    expect(capabilitiesFor(bare, "unheard-of")).toBe(GENERIC_CAPABILITIES);
  });
});
