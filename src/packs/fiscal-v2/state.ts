import type { CaseState } from "../../contracts.js";
import { createCaseState } from "../../tools.js";

/** Case state of the fiscal-v2 pack, split out so the runner can default to it without an import cycle. */
export const fiscalV2State = {
  createState: createCaseState,
  finalState: (state: CaseState): Readonly<Record<string, unknown>> => ({
    followUps: [...state.followUps.values()],
    matchedPayments: Object.fromEntries(
      [...state.paymentMatches.values()].map(({ paymentId, documentId }) => [paymentId, documentId]),
    ),
  }),
};
