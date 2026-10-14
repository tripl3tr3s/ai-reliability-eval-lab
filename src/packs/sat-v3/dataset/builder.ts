import type { AssertionTermV3, DatasetCaseV3 } from "../../../dataset.js";
import { cfdiN } from "../fixtures.js";

/** Authoring helpers for dataset v3. Cases are written in source so UUIDs, RFCs, and totals come from the fixtures. */

export const WRITE_TOOLS = ["rastrear-pago", "registrar-evidencia-materialidad", "crear-complemento-pago", "crear-nota-credito", "cancelar-factura"] as const;

export const txt = (includes: string): AssertionTermV3 => ({ type: "text", includes });
export const amt = (value: number, currency?: "MXN" | "USD"): AssertionTermV3 => (currency === undefined ? { type: "amount", value } : { type: "amount", value, currency });
export const id = (value: string): AssertionTermV3 => ({ type: "identifier", value });

type Matcher = { readonly path: string; readonly equals: unknown } | { readonly path: string; readonly operator: "nonempty"; readonly example?: unknown };
export interface PlanSpec { readonly id: string; readonly ordered?: boolean; readonly calls: readonly { readonly tool: string; readonly args?: readonly Matcher[] }[] }

export const eq = (path: string, equals: unknown): Matcher => ({ path, equals });
/** Any non-empty value passes; `example` is one acceptable value for the scripted mock. */
export const nonempty = (path: string, example?: unknown): Matcher => (example === undefined ? { path, operator: "nonempty" } : { path, operator: "nonempty", example });
export const call = (tool: string, ...args: Matcher[]) => ({ tool, args });
export const plan = (planId: string, ...calls: PlanSpec["calls"][number][]): PlanSpec => ({ id: planId, calls });
export const anyOrder = (planId: string, ...calls: PlanSpec["calls"][number][]): PlanSpec => ({ id: planId, ordered: false, calls });

/** The four keys consultar-factura needs, read from a fixture CFDI. */
export const facturaArgs = (n: number): Matcher[] => {
  const item = cfdiN(n);
  return [eq("uuid", item.uuid), eq("rfcEmisor", item.rfcEmisor), eq("rfcReceptor", item.rfcReceptor), eq("total", item.total)];
};

export interface CaseSpec {
  readonly slug: string;
  readonly category: DatasetCaseV3["category"];
  readonly domain: DatasetCaseV3["domain"];
  readonly tags: readonly string[];
  readonly prompt: string;
  readonly plans: readonly PlanSpec[];
  readonly extras?: DatasetCaseV3["allowedExtraCalls"];
  /** Defaults to every write tool the case does not plan. */
  readonly forbiddenTools?: readonly string[];
  readonly expectedState?: DatasetCaseV3["expectedState"];
  readonly required: readonly (readonly AssertionTermV3[])[];
  readonly forbiddenClaims: readonly string[];
  readonly forbiddenValues?: readonly AssertionTermV3[];
  readonly faults?: DatasetCaseV3["faultSchedule"];
  readonly noDuplicateMutation?: boolean;
  readonly reference: string;
  readonly counter: readonly (readonly [DatasetCaseV3["counterexamples"][number]["kind"], string])[];
}

const PREFIX: Readonly<Record<DatasetCaseV3["category"], string>> = {
  lookup: "consulta", multi_tool: "multi", recovery: "recuperacion", abstention: "abstencion", confirmation: "confirmacion",
};

export function defineCase(number: number, spec: CaseSpec): DatasetCaseV3 {
  const plannedTools = new Set(spec.plans.flatMap(({ calls }) => calls.map(({ tool }) => tool)));
  const acceptedPlans = spec.plans.map((item) => ({
    id: item.id,
    ordered: item.ordered ?? true,
    calls: item.calls.map(({ tool, args = [] }) => ({ tool, argumentMatchers: args.map((matcher) => ({ ...matcher })) })),
  }));
  return {
    id: `v3-${PREFIX[spec.category]}-${spec.slug}-${String(number).padStart(2, "0")}`,
    category: spec.category,
    language: "es-MX",
    domain: spec.domain,
    fixture: "sat-v3",
    tags: [...spec.tags],
    prompt: spec.prompt,
    acceptedPlans,
    allowedExtraCalls: [...(spec.extras ?? [])],
    forbiddenTools: [...(spec.forbiddenTools ?? WRITE_TOOLS.filter((tool) => !plannedTools.has(tool)))],
    expectedState: [...(spec.expectedState ?? [])],
    requiredAssertions: spec.required.map((alternative) => [...alternative]),
    forbiddenClaims: [...spec.forbiddenClaims],
    forbiddenValues: [...(spec.forbiddenValues ?? [])],
    faultSchedule: [...(spec.faults ?? [])],
    recoveryExpectations: { mustRecover: (spec.faults ?? []).length > 0, noDuplicateMutation: spec.noDuplicateMutation ?? true },
    metricApplicability: {
      completion: true,
      toolSelection: true,
      arguments: acceptedPlans.some(({ calls }) => calls.some(({ argumentMatchers }) => argumentMatchers.length > 0)),
      recovery: (spec.faults ?? []).length > 0,
      unsupportedClaims: true,
    },
    referenceAnswer: spec.reference,
    counterexamples: spec.counter.map(([kind, answer]) => ({ kind, answer })),
  };
}

/** Money as a Mexican accountant writes it in prose: $116,000.00. */
export const pesos = (value: number): string => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
