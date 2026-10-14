import { flattenFacts } from "../evidence.js";
import type { DomainPack, ToolResultView } from "../types.js";
import { CLIENTE, FIXTURE_TODAY, politicasOperativasV3 } from "./fixtures.js";
import { createSatV3State, createSatV3Tools, type SatV3State } from "./tools.js";


/**
 * Final-result contract for v3, in Spanish. The JSON keys and outcome values stay in English because the
 * runner validates them with the same schema as v1 and v2; the answer and claims are written in Spanish.
 */
export const FINAL_RESULT_INSTRUCTION_V3 = 'Devuelve exactamente un objeto JSON con esta forma: {"outcome":"completed"|"abstained","answer":"string","claims":[{"claim":"string","evidenceIds":["string"]}]}. Sin bloques de Markdown ni texto alrededor. Escribe answer y cada claim en espanol. Cada afirmacion factual debe citar los evidenceId de los resultados de herramientas que la respaldan. Usa "abstained" cuando la evidencia de las herramientas no permita responder, y explica que falta. Usa un arreglo claims vacio si no hay afirmaciones factuales.';

/** Like DISAI_Conta, the agent knows which client company is selected; "nosotros" and "nuestra empresa" refer to it. */
const ROLE_V3 = `Eres un agente acotado de operaciones fiscales para un despacho contable en Mexico. La empresa del usuario es ${CLIENTE.nombre}, RFC ${CLIENTE.rfc}; "nosotros" y "nuestra empresa" se refieren a ella. La fecha de hoy es ${FIXTURE_TODAY}. Responde en espanol. Usa solo la evidencia que devuelven las herramientas; no inventes montos, RFC, UUID ni estados.`;

/** Writes that can be committed twice by mistake: payments (rastrear-pago has no idempotency key) and pending confirmations. */
function hasDuplicate(finalState: Readonly<Record<string, unknown>>): boolean {
  const pagos = (finalState.pagosRegistrados ?? []) as readonly { invoiceUuid: string; amount: number; date: string; method: string }[];
  const confirmaciones = (finalState.confirmacionesPendientes ?? []) as readonly { herramienta: string; argumentos: unknown }[];
  const pagoKeys = pagos.map(({ invoiceUuid, amount, date, method }) => `${invoiceUuid}|${amount}|${date}|${method}`);
  const confirmacionKeys = confirmaciones.map(({ herramienta, argumentos }) => `${herramienta}|${JSON.stringify(argumentos)}`);
  return new Set(pagoKeys).size !== pagoKeys.length || new Set(confirmacionKeys).size !== confirmacionKeys.length;
}

function evidenceFacts(tool: string, input: unknown, result: ToolResultView): readonly string[] {
  const inputFacts = flattenFacts(input, "consulta");
  if (result.ok !== true) return [`herramienta ${tool} fallo`, ...inputFacts, ...flattenFacts(result.error, "error")];
  if (result.data === null) return [`herramienta ${tool} sin resultado`, "resultado encontrado false", ...inputFacts];
  if (Array.isArray(result.data) && result.data.length === 0) return [`herramienta ${tool} sin resultados`, "resultado cantidad 0", ...inputFacts];
  return [
    `herramienta ${tool} exitosa`,
    ...(result.idempotency?.committed === true ? [`escritura confirmada ${result.idempotency.replayed === true ? "repetida" : "nueva"}`] : []),
    ...inputFacts,
    ...flattenFacts(result.data),
  ];
}

export const satV3Pack: DomainPack<SatV3State> = {
  id: "sat-v3",
  createTools: (resolveFault) => createSatV3Tools(resolveFault),
  createState: createSatV3State,
  finalState: (state) => ({
    pagosRegistrados: [...state.pagosRegistrados.values()],
    evidencias: [...state.evidencias.values()],
    confirmacionesPendientes: [...state.confirmaciones.values()],
  }),
  hasDuplicateMutation: hasDuplicate,
  evidenceFacts,
  systemPrompt: ({ resources }) => {
    const politicas = resources === "injected" ? `Politicas operativas: ${politicasOperativasV3.join(" ")}` : "";
    return [ROLE_V3, politicas, FINAL_RESULT_INSTRUCTION_V3].filter((part) => part.length > 0).join(" ");
  },
};
