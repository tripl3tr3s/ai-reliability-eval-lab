import { LEGACY_PROMPT_VERSION, LEGACY_RESOURCE_VERSION } from "../../config.js";
import type { CaseState } from "../../contracts.js";
import { operationalResourceText } from "../../fixtures.js";
import { FINAL_RESULT_INSTRUCTION } from "../../runner.js";
import { createSyntheticTools } from "../../tools.js";
import { fiscalV2State } from "./state.js";
import { flattenFacts, getStringPath } from "../evidence.js";
import type { DomainPack, ToolResultView } from "../types.js";

/**
 * The original Mexican fiscal domain pack behind datasets v1 and v2: 8 English synthetic tools,
 * follow-ups and payment matches as case state. Every function here was moved without change from
 * runner.ts and experiment.ts, so v1 and v2 runs are unaffected.
 */
export const fiscalV2Pack: DomainPack<CaseState> = {
  id: "fiscal-v2",
  createTools: (resolveFault) => createSyntheticTools(resolveFault),
  createState: fiscalV2State.createState,
  finalState: fiscalV2State.finalState,
  hasDuplicateMutation: (finalState) => hasDuplicateMutation((finalState.followUps ?? []) as readonly { idempotencyKey: string }[]),
  evidenceFacts: (tool, input, result) => fiscalEvidenceFacts(tool, input, result),
  systemPrompt: ({ resources, promptVersion, resourceVersion }) => {
    const resourceText = resources === "injected"
      ? resourceVersion === LEGACY_RESOURCE_VERSION
        ? "Operational resources: Escalate Definitivo suppliers. Require invoice evidence before payment matching. Never create duplicate follow-ups."
        : `Operational resources: ${operationalResourceText}`
      : "";
    const finalInstruction = promptVersion === LEGACY_PROMPT_VERSION
      ? "Return JSON with outcome, answer, and evidence-linked claims."
      : FINAL_RESULT_INSTRUCTION;
    return `You are a bounded fiscal operations agent. ${resourceText} ${finalInstruction}`;
  },
};

export function fiscalEvidenceFacts(
  tool: string,
  input: unknown,
  result: ToolResultView,
): readonly string[] {
  const inputFacts = flattenFacts(input, "query");
  if (result.ok !== true) {
    return [
      `tool ${tool} failed`,
      ...inputFacts,
      ...flattenFacts(result.error, "error"),
    ];
  }
  if (result.data === null) {
    const documentId = getStringPath(input, "documentId");
    return [
      `tool ${tool} returned no result`,
      "result found false",
      "result empty true",
      ...(tool === "get_document" && documentId
        ? [`document ${documentId} not found in available records`, `no document found for ${documentId}`]
        : []),
      ...inputFacts,
    ];
  }
  if (Array.isArray(result.data)) {
    const countFacts = [`result count ${result.data.length}`, `result empty ${result.data.length === 0}`];
    if (result.data.length === 0) {
      return [
        `tool ${tool} returned no results`,
        ...(tool === "search_documents" ? ["no documents matched the query", "zero documents found"] : []),
        ...(tool === "list_payments" ? ["no payments matched the query", "zero payments found"] : []),
        ...countFacts,
        ...inputFacts,
      ];
    }
    return [
      ...(tool === "search_documents" ? ["documents found"] : []),
      ...(tool === "list_payments" ? ["payments found"] : []),
      ...(tool === "list_payments" ? paymentStatusFacts(result.data) : []),
      ...countFacts,
      ...inputFacts,
      ...flattenFacts(result.data),
    ];
  }
  const documentId = getStringPath(input, "documentId");
  const paymentId = getStringPath(input, "paymentId");
  const idempotencyKey = getStringPath(input, "idempotencyKey");
  const resultDocumentId = getStringPath(result.data, "documentId");
  const resultPaymentId = getStringPath(result.data, "paymentId");
  const supplierRfc = getStringPath(input, "supplierRfc");
  const resultSupplierRfc = getStringPath(result.data, "supplierRfc");
  const reason = getStringPath(input, "reason");
  const resultReason = getStringPath(result.data, "reason");
  const resultIdempotencyKey = typeof result.idempotency?.key === "string" ? result.idempotency.key : null;
  const committed = result.idempotency?.committed;
  const replayed = result.idempotency?.replayed;
  const validMatch = tool === "match_payment" && committed === true
    && paymentId !== null && documentId !== null && idempotencyKey !== null
    && resultPaymentId === paymentId && resultDocumentId === documentId
    && resultIdempotencyKey === idempotencyKey;
  const validFollowUp = tool === "create_follow_up" && committed === true
    && supplierRfc !== null && idempotencyKey !== null && reason !== null && reason.length > 0
    && resultSupplierRfc === supplierRfc && resultIdempotencyKey === idempotencyKey
    && resultReason === reason;
  return [
    `tool ${tool} succeeded`,
    ...(tool === "get_document" && documentId ? [`document ${documentId} found`] : []),
    ...(validMatch
      ? [`payment ${paymentId} matched to document ${documentId}`]
      : []),
    ...(validMatch ? ["match committed true"] : []),
    ...(validMatch && typeof replayed === "boolean" ? [`match replayed ${replayed}`, ...(replayed ? [] : ["match not replayed"])] : []),
    ...(validFollowUp ? ["follow-up committed true"] : []),
    ...(validFollowUp && typeof replayed === "boolean" ? [`follow-up replayed ${replayed}`] : []),
    ...inputFacts,
    ...flattenFacts(result.data),
  ];
}

function paymentStatusFacts(items: readonly unknown[]): readonly string[] {
  return items.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const payment = item as Record<string, unknown>;
    if (typeof payment.id !== "string") return [];
    if (payment.matchedDocumentId === null) {
      return [`payment ${payment.id} unmatched`, `payment ${payment.id} previously unmatched`];
    }
    return typeof payment.matchedDocumentId === "string"
      ? [`payment ${payment.id} matched to document ${payment.matchedDocumentId}`]
      : [];
  });
}

function hasDuplicateMutation(items: readonly { idempotencyKey: string }[]): boolean {
  return new Set(items.map(({ idempotencyKey }) => idempotencyKey)).size !== items.length;
}
