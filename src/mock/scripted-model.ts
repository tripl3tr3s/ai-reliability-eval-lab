import type { ModelAdapter, ModelRequest, ModelResponse } from "../contracts.js";
import type { DatasetCase, DatasetCaseV2 } from "../dataset.js";
import { MOCK_MODEL_PREFIX } from "../raw-run.js";

export const SCRIPTED_MODEL_ID = `${MOCK_MODEL_PREFIX}scripted-v1`;
export const SCRIPTED_PROFILES = ["clean", "regressed"] as const;
export type ScriptedProfile = (typeof SCRIPTED_PROFILES)[number];

export type ScriptedBehaviour = "follow-plan" | "wrong-answer" | "unauthorized-write";

export interface ScriptedContext {
  readonly datasetCase: DatasetCaseV2;
  readonly caseIndex: number;
  /** True when the system prompt carries injected operational resources. */
  readonly resourcesInjected: boolean;
}

/**
 * Built-in behaviours.
 * - clean: always follows the first accepted plan and gives the required answer.
 * - regressed: identical with injected resources; without them every third case gets a wrong
 *   answer and write cases attempt an unplanned write. This makes the no-resource-injection
 *   arm a known regression against the routed arm.
 */
export const PROFILE_BEHAVIOUR: Readonly<Record<ScriptedProfile, (context: ScriptedContext) => ScriptedBehaviour>> = {
  clean: () => "follow-plan",
  regressed: ({ caseIndex, resourcesInjected, datasetCase }) =>
    resourcesInjected ? "follow-plan" : datasetCase.expectedState.length > 0 ? "unauthorized-write" : caseIndex % 3 === 0 ? "wrong-answer" : "follow-plan",
};

function fillRequired(schema: Readonly<Record<string, unknown>> | undefined, input: Record<string, unknown>): Record<string, unknown> {
  const required = Array.isArray(schema?.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  return { ...Object.fromEntries(required.filter((key) => !(key in input)).map((key) => [key, "scripted"])), ...input };
}

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Deterministic stand-in for a model. It recognises the case from the user prompt, walks the
 * case's first accepted plan one tool call per turn, and then returns the final JSON result.
 * It makes no network calls and reports zero cost.
 */
export function createScriptedModel(cases: readonly DatasetCase[], behaviour: (context: ScriptedContext) => ScriptedBehaviour = PROFILE_BEHAVIOUR.clean): ModelAdapter {
  const scripted = cases.filter((item): item is DatasetCaseV2 => "acceptedPlans" in item);
  const byPrompt = new Map(scripted.map((item, caseIndex) => [item.prompt, { datasetCase: item, caseIndex }]));
  const respond = (request: ModelRequest, text: string, toolCalls: ModelResponse["toolCalls"]): ModelResponse => ({
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
    usage: {
      inputTokens: estimateTokens(request.messages.map(({ content }) => content).join("")),
      outputTokens: estimateTokens(text + JSON.stringify(toolCalls)),
      costUsd: 0,
    },
    modelId: SCRIPTED_MODEL_ID,
    latencyMs: 0,
  });
  return {
    async generate(request) {
      if (request.tools.length === 0) return respond(request, "multi-step", []);
      const prompt = request.messages.find(({ role }) => role === "user")?.content ?? "";
      const known = byPrompt.get(prompt);
      if (!known) throw new Error("Scripted model received a prompt that is not in the dataset");
      const { datasetCase } = known;
      const resourcesInjected = request.messages.some(({ role, content }) => role === "system" && content.includes("Operational resources:"));
      const mode = behaviour({ ...known, resourcesInjected });
      const plan = datasetCase.acceptedPlans[0]!;
      const turn = request.messages.filter(({ role }) => role === "tool").length;
      const schemaOf = (tool: string) => request.tools.find(({ name }) => name === tool)?.inputSchema;
      const call = plan.calls[turn];
      if (call) {
        const input = Object.fromEntries(call.argumentMatchers.map((matcher) => [matcher.path, "equals" in matcher ? matcher.equals : `${datasetCase.id}-key`]));
        return respond(request, "", [{ id: `call-${turn + 1}`, name: call.tool, input: fillRequired(schemaOf(call.tool), input) }]);
      }
      if (mode === "unauthorized-write" && turn === plan.calls.length) {
        const forbidden = datasetCase.forbiddenTools[0] ?? "create_follow_up";
        const write = plan.calls.some(({ tool }) => tool === forbidden) ? "match_payment" : forbidden;
        return respond(request, "", [{ id: `call-${turn + 1}`, name: write, input: fillRequired(schemaOf(write), { idempotencyKey: `${datasetCase.id}-unplanned` }) }]);
      }
      const answer = mode === "follow-plan" ? datasetCase.requiredAssertions[0]!.map(({ includes }) => includes).join(". ") : "No result.";
      return respond(request, JSON.stringify({ outcome: datasetCase.category === "abstention" ? "abstained" : "completed", answer, claims: [] }), []);
    },
  };
}
