import type { ModelAdapter, ModelRequest, ModelResponse } from "../contracts.js";
import { isV3Case, type DatasetCase, type DatasetCaseV2, type DatasetCaseV3 } from "../dataset.js";
import { MOCK_MODEL_PREFIX } from "../raw-run.js";

export const SCRIPTED_MODEL_ID = `${MOCK_MODEL_PREFIX}scripted-v1`;
export const SCRIPTED_PROFILES = ["clean", "regressed", "noisy"] as const;
export type ScriptedProfile = (typeof SCRIPTED_PROFILES)[number];

export type ScriptedBehaviour = "follow-plan" | "wrong-answer" | "unauthorized-write" | "omission";

export interface ScriptedContext {
  readonly datasetCase: DatasetCaseV2 | DatasetCaseV3;
  readonly caseIndex: number;
  /** True when the system prompt carries injected operational resources. */
  readonly resourcesInjected: boolean;
  /** Model the request was sent to. */
  readonly model: string;
  /** The run in progress, when the caller reports it (the mock runner does). Runs are sequential. */
  readonly job?: { readonly configuration: string; readonly repeat: number };
}

export interface ScriptedModelOptions {
  /** Models whose answers the regressed profile degrades even with resources injected (v3: the advanced-tier executor). */
  readonly regressModels?: ReadonlySet<string>;
  /** Returns the run in progress, so a profile can vary by arm and repeat. */
  readonly currentJob?: () => ScriptedContext["job"];
}

/** The noisy profile's reference arms: the direct baselines. Every other arm is a candidate. */
const isReferenceArm = (configuration: string): boolean => configuration.startsWith("direct-");
/** Cases whose answer drops a required fact in repeats 0 to 2 of every arm, so failures cluster by case. */
export const NOISY_SHARED_CASES = (caseIndex: number): boolean => caseIndex % 10 === 3;
export const NOISY_SHARED_FAILING_REPEATS = 3;
/** v3 case lost only by the candidate arms (repeat 1), and v3 case lost only by the reference arm (repeat 2). Neither applies recovery. */
export const NOISY_CANDIDATE_LOSS = "v3-consulta-69b-desvirtuado-08";
export const NOISY_REFERENCE_LOSS = "v3-multi-cancelar-ya-cancelada-42";

/**
 * Built-in behaviours.
 * - clean: always follows the first accepted plan and gives the required answer.
 * - regressed: identical with injected resources; without them every third case gets a wrong
 *   answer and write cases attempt an unplanned write. This makes the no-resource-injection
 *   arm a known regression against the routed arm. Dataset v3 has no resource ablation arm, so
 *   createScriptedModel also degrades requests sent to `regressModels` (the advanced executor of the
 *   production-mirror arm), making that arm a known regression against the direct reference.
 * - noisy: needs the run in progress (`currentJob`). Cases with index 3 mod 10 omit a required fact in
 *   repeats 0 to 2 of every arm, so repeats of a case disagree and failures cluster by case (positive ICC). One v3
 *   case fails one candidate repeat and another one reference repeat, so each arm loses exactly one case under the every-repeat rule. The omission
 *   answers are the dataset's own `omission` counterexamples (v3) or "No result." (v2); neither is a
 *   critical error, and tool calls are unchanged. Without a job it throws, so the noise can never silently disappear.
 */
export const PROFILE_BEHAVIOUR: Readonly<Record<ScriptedProfile, (context: ScriptedContext) => ScriptedBehaviour>> = {
  clean: () => "follow-plan",
  regressed: ({ caseIndex, resourcesInjected, datasetCase }) =>
    resourcesInjected ? "follow-plan" : datasetCase.expectedState.length > 0 ? "unauthorized-write" : caseIndex % 3 === 0 ? "wrong-answer" : "follow-plan",
  noisy: ({ caseIndex, job, datasetCase }) => {
    if (job === undefined) throw new Error("The noisy profile needs the run in progress; pass currentJob to createScriptedModel");
    if (NOISY_SHARED_CASES(caseIndex) && job.repeat < NOISY_SHARED_FAILING_REPEATS) return "omission";
    if (datasetCase.id === NOISY_CANDIDATE_LOSS && !isReferenceArm(job.configuration) && job.repeat === 1) return "omission";
    if (datasetCase.id === NOISY_REFERENCE_LOSS && isReferenceArm(job.configuration) && job.repeat === 2) return "omission";
    return "follow-plan";
  },
};

/** Sets a dotted path ("payment.amount", "documentos.0.id") without mutating the input; numeric segments build arrays. */
function setPath(target: unknown, path: string, value: unknown): unknown {
  const [head, ...rest] = path.split(".");
  const key = head!;
  const container: Record<string, unknown> | unknown[] = Array.isArray(target)
    ? [...target]
    : target !== null && typeof target === "object" ? { ...(target as Record<string, unknown>) } : /^\d+$/u.test(key) ? [] : {};
  const current = (container as Record<string, unknown>)[key];
  const next = rest.length === 0 ? value : setPath(current ?? (/^\d+$/u.test(rest[0]!) ? [] : {}), rest.join("."), value);
  if (Array.isArray(container)) {
    const index = Number(key);
    return Array.from({ length: Math.max(container.length, index + 1) }, (_, position): unknown => (position === index ? next : container[position]));
  }
  return { ...container, [key]: next };
}

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
export function createScriptedModel(cases: readonly DatasetCase[], behaviour: (context: ScriptedContext) => ScriptedBehaviour = PROFILE_BEHAVIOUR.clean, options: ScriptedModelOptions = {}): ModelAdapter {
  const scripted = cases.filter((item): item is DatasetCaseV2 | DatasetCaseV3 => "acceptedPlans" in item);
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
      const prompt = request.messages.find(({ role }) => role === "user")?.content ?? "";
      const known = byPrompt.get(prompt);
      if (request.tools.length === 0) {
        // Routing request: the v3 domain router gets the case's expected domain (a perfect router); v2 gets a fixed label.
        return known && isV3Case(known.datasetCase) ? respond(request, JSON.stringify({ domain: known.datasetCase.domain }), []) : respond(request, "multi-step", []);
      }
      if (!known) throw new Error("Scripted model received a prompt that is not in the dataset");
      const { datasetCase } = known;
      const resourcesInjected = request.messages.some(({ role, content }) => role === "system" && (content.includes("Operational resources:") || content.includes("Politicas operativas:")));
      const forcedRegression = PROFILE_BEHAVIOUR.regressed === behaviour && options.regressModels?.has(request.model) === true;
      const job = options.currentJob?.();
      const mode = behaviour({ ...known, resourcesInjected: resourcesInjected && !forcedRegression, model: request.model, ...(job === undefined ? {} : { job }) });
      const plan = datasetCase.acceptedPlans[0]!;
      const turn = request.messages.filter(({ role }) => role === "tool").length;
      const schemaOf = (tool: string) => request.tools.find(({ name }) => name === tool)?.inputSchema;
      const call = plan.calls[turn];
      if (call) {
        const input = call.argumentMatchers.reduce<unknown>((acc, matcher) => setPath(acc, matcher.path, "operator" in matcher ? matcher.example ?? `${datasetCase.id}-key` : matcher.equals), {}) as Record<string, unknown>;
        return respond(request, "", [{ id: `call-${turn + 1}`, name: call.tool, input: fillRequired(schemaOf(call.tool), input) }]);
      }
      if (mode === "unauthorized-write" && turn === plan.calls.length) {
        const forbidden = datasetCase.forbiddenTools[0] ?? "create_follow_up";
        const write = plan.calls.some(({ tool }) => tool === forbidden) ? "match_payment" : forbidden;
        return respond(request, "", [{ id: `call-${turn + 1}`, name: write, input: fillRequired(schemaOf(write), { idempotencyKey: `${datasetCase.id}-unplanned` }) }]);
      }
      const answer = isV3Case(datasetCase)
        ? mode === "follow-plan"
          ? datasetCase.referenceAnswer
          : mode === "omission"
            ? (datasetCase.counterexamples.find(({ kind }) => kind === "omission") ?? datasetCase.counterexamples[0]!).answer
            : datasetCase.counterexamples[0]!.answer
        : mode === "follow-plan" ? datasetCase.requiredAssertions[0]!.map(({ includes }) => includes).join(". ") : "No result.";
      return respond(request, JSON.stringify({ outcome: datasetCase.category === "abstention" ? "abstained" : "completed", answer, claims: [] }), []);
    },
  };
}
