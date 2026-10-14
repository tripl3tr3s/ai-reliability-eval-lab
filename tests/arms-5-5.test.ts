import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANTHROPIC_MODELS } from "../src/adapter.js";
import {
  AGENT_CONFIGURATIONS,
  CONFIGURATION_IDS,
  LEGACY_ARMS,
  V3_AGENT_POLICY,
  resolveSlot,
} from "../src/config.js";
import type { ModelAdapter, ModelRequest } from "../src/contracts.js";
import { loadExperimentConfig, runExperiment } from "../src/experiment.js";
import {
  ADVANCED_DOMAINS,
  DOMAIN_ROUTER_V3_PROMPT,
  ROUTER_DOMAINS,
  parseRoutedDomain,
  tierForDomain,
} from "../src/packs/sat-v3/router.js";

describe("5.5 arms", () => {
  it("adds the production-mirror candidate and the Sonnet 5.5 reference", () => {
    expect(CONFIGURATION_IDS).toEqual(
      expect.arrayContaining(["prod-routed-5-5", "direct-sonnet-5-5"]),
    );
  });

  it("mirrors production: Haiku 5.5 low router, Sonnet 5.5 medium standard, Opus 5.5 high advanced", () => {
    const arm = AGENT_CONFIGURATIONS["prod-routed-5-5"];
    expect(arm.router).toEqual({
      kind: "domain-v3",
      slot: { model: ANTHROPIC_MODELS.haiku55, effort: "low" },
    });
    expect(arm.executor).toEqual({
      model: ANTHROPIC_MODELS.sonnet55,
      effort: "medium",
    });
    expect(arm.advancedExecutor).toEqual({
      model: ANTHROPIC_MODELS.opus55,
      effort: "high",
    });
    expect(arm.resources).toBe("injected");
    expect(arm.policy).toBe(V3_AGENT_POLICY);
  });

  it("runs Sonnet 5.5 at medium on every case in the reference arm", () => {
    const arm = AGENT_CONFIGURATIONS["direct-sonnet-5-5"];
    expect(arm.router).toBeUndefined();
    expect(arm.executor).toEqual({
      model: ANTHROPIC_MODELS.sonnet55,
      effort: "medium",
    });
    expect(arm.policy).toBe(V3_AGENT_POLICY);
  });

  it("gives thinking models a larger run-level budget than the legacy policy", () => {
    expect(V3_AGENT_POLICY.maxTokens).toBeGreaterThan(
      AGENT_CONFIGURATIONS["direct-sonnet"].policy.maxTokens,
    );
    expect(V3_AGENT_POLICY.deadlineMs).toBeGreaterThan(
      AGENT_CONFIGURATIONS["direct-sonnet"].policy.deadlineMs,
    );
  });

  it("keeps legacy arms on provider roles so env-configured providers still work", () => {
    expect([...LEGACY_ARMS]).toEqual([
      "direct-sonnet",
      "routed",
      "no-resource-injection",
    ]);
    const roles = { executor: "e", router: "r", simpleExecutor: "s" };
    expect(resolveSlot(AGENT_CONFIGURATIONS.routed.executor, roles)).toEqual({
      model: "e",
    });
    expect(
      resolveSlot(AGENT_CONFIGURATIONS["prod-routed-5-5"].executor, roles),
    ).toEqual({ model: ANTHROPIC_MODELS.sonnet55, effort: "medium" });
  });
});

describe("domain router v3", () => {
  it("routes pagos and cumplimiento to the advanced tier, as production does", () => {
    expect([...ADVANCED_DOMAINS].sort()).toEqual(["cumplimiento", "pagos"]);
    expect(tierForDomain("pagos")).toBe("advanced");
    expect(tierForDomain("cumplimiento")).toBe("advanced");
    expect(tierForDomain("facturacion")).toBe("standard");
    expect(tierForDomain("general")).toBe("standard");
  });

  it("mirrors the production router: English instructions, Spanish keyword lists, every domain", () => {
    expect(DOMAIN_ROUTER_V3_PROMPT).toContain(
      "domain router for a Mexican tax compliance platform",
    );
    expect(DOMAIN_ROUTER_V3_PROMPT).toContain("complemento de pago");
    expect(DOMAIN_ROUTER_V3_PROMPT).toContain("Art. 69-B");
    for (const domain of ROUTER_DOMAINS)
      expect(DOMAIN_ROUTER_V3_PROMPT).toContain(domain);
  });

  it.each([
    ['{"domain":"pagos"}', "pagos"],
    ['```json\n{"domain": "cumplimiento"}\n```', "cumplimiento"],
    ['Dominio: {"domain":"notas-credito"} listo', "notas-credito"],
    ['{"domain":"nomina"}', "general"],
    ["no json", "general"],
    ["", "general"],
  ])("parses %j as %s", (text, domain) => {
    expect(parseRoutedDomain(text)).toBe(domain);
  });
});

function recordingAdapter(routerAnswer: string) {
  const requests: ModelRequest[] = [];
  const adapter: ModelAdapter = {
    async generate(request) {
      requests.push(request);
      const routing = request.tools.length === 0;
      return {
        text: routing
          ? routerAnswer
          : JSON.stringify({
              outcome: "abstained",
              answer: "Sin evidencia suficiente.",
              claims: [],
            }),
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.000001 },
        modelId: request.model,
        latencyMs: 1,
      };
    },
  };
  return { adapter, requests };
}

async function runArm(
  configuration: (typeof CONFIGURATION_IDS)[number],
  routerAnswer: string,
) {
  const { adapter, requests } = recordingAdapter(routerAnswer);
  const config = await loadExperimentConfig("config/smoke.v2.json");
  const outputPath = join(
    await mkdtemp(join(tmpdir(), "arms-")),
    "results.jsonl",
  );
  const runs = await runExperiment({
    config: { ...config, configurations: [configuration], repeats: 1 },
    adapter,
    outputPath,
  });
  return { runs, requests, raw: await readFile(outputPath, "utf8") };
}

describe("per-configuration execution", () => {
  it("sends the router Haiku 5.5 at low effort with room for thinking and no temperature", async () => {
    const { requests } = await runArm(
      "prod-routed-5-5",
      '{"domain":"facturacion"}',
    );
    const routing = requests.filter(({ tools }) => tools.length === 0);
    expect(routing.length).toBeGreaterThan(0);
    for (const request of routing) {
      expect(request.model).toBe(ANTHROPIC_MODELS.haiku55);
      expect(request.effort).toBe("low");
      expect(request.temperature).toBeUndefined();
      expect(request.maxOutputTokens).toBeGreaterThanOrEqual(1024);
    }
  });

  it("executes advanced domains on Opus 5.5 at high and records domain and tier", async () => {
    const { requests, runs } = await runArm(
      "prod-routed-5-5",
      '{"domain":"pagos"}',
    );
    const execution = requests.filter(({ tools }) => tools.length > 0);
    expect(
      execution.every(
        ({ model, effort }) =>
          model === ANTHROPIC_MODELS.opus55 && effort === "high",
      ),
    ).toBe(true);
    expect(
      runs.every(
        ({ routedDomain, tier }) =>
          routedDomain === "pagos" && tier === "advanced",
      ),
    ).toBe(true);
  });

  it("executes standard domains on Sonnet 5.5 at medium", async () => {
    const { requests, runs } = await runArm(
      "prod-routed-5-5",
      '{"domain":"facturacion"}',
    );
    const execution = requests.filter(({ tools }) => tools.length > 0);
    expect(
      execution.every(
        ({ model, effort }) =>
          model === ANTHROPIC_MODELS.sonnet55 && effort === "medium",
      ),
    ).toBe(true);
    expect(runs.every(({ tier }) => tier === "standard")).toBe(true);
  });

  it("makes no router call in the direct 5.5 arm and records no routing fields", async () => {
    const { requests, runs } = await runArm("direct-sonnet-5-5", "unused");
    expect(requests.every(({ tools }) => tools.length > 0)).toBe(true);
    expect(
      requests.every(
        ({ model, effort }) =>
          model === ANTHROPIC_MODELS.sonnet55 && effort === "medium",
      ),
    ).toBe(true);
    expect(
      runs.every((run) => !("routedDomain" in run) && !("tier" in run)),
    ).toBe(true);
  });

  it("leaves legacy routed rows without the new fields so v2 output is unchanged", async () => {
    const { raw } = await runArm("routed", "simple-read-only");
    expect(raw).not.toContain("routedDomain");
    expect(raw).not.toContain('"tier"');
  });
});
