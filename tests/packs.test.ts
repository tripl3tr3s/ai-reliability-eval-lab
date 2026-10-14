import { describe, expect, it } from "vitest";
import { loadDataset } from "../src/dataset.js";
import { fiscalV2Pack } from "../src/packs/fiscal-v2/index.js";
import { packForCase, packForDatasetVersion, writeToolNames } from "../src/packs/index.js";
import { FINAL_RESULT_INSTRUCTION } from "../src/runner.js";

describe("domain pack registry", () => {
  it("serves datasets v1 and v2 with the fiscal-v2 pack", async () => {
    expect(packForDatasetVersion("v1")).toBe(fiscalV2Pack);
    expect(packForDatasetVersion("v2")).toBe(fiscalV2Pack);
    const { cases } = await loadDataset("datasets/v2/manifest.json");
    expect(cases.every((datasetCase) => packForCase(datasetCase) === fiscalV2Pack)).toBe(true);
  });

  it("fails closed for a dataset version no pack serves", () => {
    expect(() => packForDatasetVersion("v9")).toThrow("No domain pack serves dataset version v9");
  });

  it("derives write tools from tool side effects", () => {
    expect([...writeToolNames(fiscalV2Pack)].sort()).toEqual(["create_follow_up", "match_payment"]);
  });
});

describe("fiscal-v2 pack", () => {
  it("records follow-ups and matched payments exactly as the runner did", () => {
    const state = fiscalV2Pack.createState();
    state.followUps.set("k1", { id: "FU-1", supplierRfc: "RFC14", reason: "r", idempotencyKey: "k1" });
    state.paymentMatches.set("m1", { paymentId: "PAY-011", documentId: "INV-011", idempotencyKey: "m1" });
    expect(fiscalV2Pack.finalState(state)).toEqual({
      followUps: [{ id: "FU-1", supplierRfc: "RFC14", reason: "r", idempotencyKey: "k1" }],
      matchedPayments: { "PAY-011": "INV-011" },
    });
  });

  it("detects a duplicate follow-up mutation", () => {
    expect(fiscalV2Pack.hasDuplicateMutation({ followUps: [{ idempotencyKey: "a" }, { idempotencyKey: "a" }] })).toBe(true);
    expect(fiscalV2Pack.hasDuplicateMutation({ followUps: [{ idempotencyKey: "a" }, { idempotencyKey: "b" }] })).toBe(false);
  });

  it("keeps the v1 and v2 system prompts unchanged", () => {
    expect(fiscalV2Pack.systemPrompt({ resources: "excluded", promptVersion: "agent-prompt-v2", resourceVersion: "operational-resources-v2" }))
      .toBe(`You are a bounded fiscal operations agent.  ${FINAL_RESULT_INSTRUCTION}`);
    expect(fiscalV2Pack.systemPrompt({ resources: "injected", promptVersion: "agent-prompt-v1", resourceVersion: "operational-resources-v1" }))
      .toBe("You are a bounded fiscal operations agent. Operational resources: Escalate Definitivo suppliers. Require invoice evidence before payment matching. Never create duplicate follow-ups. Return JSON with outcome, answer, and evidence-linked claims.");
  });
});
