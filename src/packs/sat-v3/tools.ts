import { analyzeProximity, baseWeightFor, buildGraph, detectCarousels, normalizeSituacion } from "efos-risk-graph";
import { z } from "zod";
import { ToolEnvelopeSchema, type ToolContext, type ToolDefinition, type ToolEnvelope } from "../../contracts.js";
import type { FaultKind } from "../../faults.js";
import type { PackFaultResolver } from "../types.js";
import {
  aristasFacturacion, catalogos, cfdiPorUuid, cfdis, contribuyentePorRfc, evidenciaRequerida, evidenciasPrevias,
  FIXTURE_TIMESTAMP_V3, FIXTURE_TODAY, pagosPrevios, type Cfdi, type OperationType, type TipoEvidencia,
} from "./fixtures.js";

/**
 * Synthetic, in-process tools named and shaped after the sat-mcp tools DISAI_Conta allowlists
 * (mexican-automation-mcps/packages/sat-mcp/src/mcp/tools). PAC credentials, timeouts, and orgId are
 * dropped; RFC and UUID validation is kept. The HITL tools (crear-complemento-pago, crear-nota-credito)
 * and the destructive cancelar-factura leave a pending confirmation and commit nothing, as DISAI_Conta's
 * pending-confirmation interception does before sat-mcp is ever called.
 */

export interface PagoRegistrado {
  readonly registroId: string;
  readonly invoiceUuid: string;
  readonly amount: number;
  readonly date: string;
  readonly method: string;
  readonly parcialidad: number;
  readonly saldoAnterior: number;
  readonly saldoInsoluto: number;
}

export interface EvidenciaRegistrada {
  readonly evidenciaId: string;
  readonly cfdiUuid: string;
  readonly tipo: TipoEvidencia;
  readonly sha256: string;
  readonly descripcion: string;
}

export interface ConfirmacionPendiente {
  readonly confirmacionId: string;
  readonly herramienta: string;
  readonly argumentos: unknown;
}

export interface SatV3State {
  readonly pagosRegistrados: Map<string, PagoRegistrado>;
  readonly evidencias: Map<string, EvidenciaRegistrada>;
  readonly confirmaciones: Map<string, ConfirmacionPendiente>;
}

export function createSatV3State(): SatV3State {
  return { pagosRegistrados: new Map(), evidencias: new Map(), confirmaciones: new Map() };
}

type Context = ToolContext<SatV3State>;
type ErrorCode = "TRANSIENT" | "TIMEOUT" | "RATE_LIMIT" | "INVALID_RESPONSE" | "NOT_FOUND" | "STALE" | "CONTRADICTION" | "POLICY";

const RFC = z.string().regex(/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/u, "RFC invalido");
const UUID = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u, "UUID invalido");
const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}/u, "Fecha ISO 8601 invalida");
const round2 = (value: number): number => Math.round(value * 100) / 100;

const FAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  TRANSIENT: "Error transitorio del servicio; puede reintentarse",
  TIMEOUT: "Tiempo de espera agotado",
  RATE_LIMIT: "Limite de solicitudes excedido; reintente mas tarde",
  INVALID_RESPONSE: "Respuesta invalida del servicio",
  NOT_FOUND: "Recurso no encontrado",
  STALE: "Datos desactualizados",
  CONTRADICTION: "Datos contradictorios",
  POLICY: "Operacion rechazada por regla de negocio",
};

const envelope = (tool: string, context: Context, data: unknown, idempotency?: ToolEnvelope["idempotency"], freshAt = FIXTURE_TIMESTAMP_V3): ToolEnvelope =>
  ToolEnvelopeSchema.parse({ ok: true, data, evidenceId: `${context.caseId}:${tool}:${context.invocation}`, provenance: "synthetic:sat-v3", freshAt, ...(idempotency ? { idempotency } : {}) });

const failure = (tool: string, context: Context, code: ErrorCode, retryable: boolean, message = FAULT_MESSAGES[code]): ToolEnvelope =>
  ToolEnvelopeSchema.parse({ ok: false, error: { code, message: `${tool}: ${message}`, retryable }, evidenceId: `${context.caseId}:${tool}:${context.invocation}`, provenance: "synthetic:sat-v3", freshAt: FIXTURE_TIMESTAMP_V3 });

/** Thrown inside a tool body to return a business-rule rejection without committing anything. */
class Rejection extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function define<T>(
  name: string,
  description: string,
  inputSchema: z.ZodType<T>,
  sideEffect: "read" | "simulated-write",
  resolveFault: PackFaultResolver,
  execute: (input: T, context: Context) => { readonly data: unknown; readonly idempotency?: ToolEnvelope["idempotency"] },
): ToolDefinition<T, SatV3State> {
  return {
    name, description, inputSchema, sideEffect,
    async execute(raw, context) {
      const input = inputSchema.parse(raw);
      const fault: FaultKind | null = resolveFault(name, context as ToolContext<unknown>);
      if (fault === "transient") return failure(name, context, "TRANSIENT", true);
      if (fault === "rate-limit") return failure(name, context, "RATE_LIMIT", true);
      if (fault === "not-found") return failure(name, context, "NOT_FOUND", false);
      if (fault === "timeout") {
        await waitForAbort(context.signal);
        return failure(name, context, "TIMEOUT", true);
      }
      if (fault === "schema-invalid") return { ok: true, data: "respuesta malformada" } as ToolEnvelope;
      let result: ReturnType<typeof execute>;
      try {
        result = execute(input, context);
      } catch (error) {
        if (error instanceof Rejection) return failure(name, context, error.code, false, error.message);
        throw error;
      }
      if (fault === "response-loss-after-write") return failure(name, context, "TRANSIENT", true, "Conexion perdida antes de recibir la respuesta; el estado de la operacion es desconocido");
      if (fault === "contradiction") return envelope(name, context, { principal: result.data, contradictorio: contradict(result.data), contradiccionDetectada: true }, result.idempotency);
      return envelope(name, context, result.data, result.idempotency, fault === "stale" ? "2020-01-01T00:00:00.000Z" : FIXTURE_TIMESTAMP_V3);
    },
  };
}

function contradict(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ("estado" in record) return { ...record, estado: record.estado === "Vigente" ? "Cancelado" : "Vigente" };
    if ("situacion" in record) return { ...record, situacion: "Sin informacion" };
    return { ...record, nota: "registro alterno con valores distintos" };
  }
  return { valorAlterno: value };
}

const vistaCfdi = (item: Cfdi) => ({
  uuid: item.uuid,
  tipoComprobante: item.tipo,
  rfcEmisor: item.rfcEmisor,
  nombreEmisor: contribuyentePorRfc(item.rfcEmisor)?.nombre ?? null,
  rfcReceptor: item.rfcReceptor,
  nombreReceptor: contribuyentePorRfc(item.rfcReceptor)?.nombre ?? null,
  fecha: item.fecha,
  subtotal: item.subtotal,
  iva: item.iva,
  total: item.total,
  moneda: item.moneda,
  ...(item.tipoCambio === undefined ? {} : { tipoCambio: item.tipoCambio }),
  metodoPago: item.metodoPago,
  formaPago: item.formaPago,
  descripcion: item.descripcion,
  claveProdServ: item.claveProdServ,
  estado: item.estado,
  ...(item.relacion === undefined ? {} : { cfdiRelacionado: item.relacion }),
});

function pagosDe(uuid: string, state: SatV3State) {
  const previos = pagosPrevios.filter((pago) => pago.invoiceUuid === uuid).map((pago) => ({ parcialidad: pago.parcialidad, monto: pago.monto, fecha: pago.fecha, formaPago: pago.formaPago, complementoUuid: pago.complemento, origen: "historico" as const }));
  const registrados = [...state.pagosRegistrados.values()].filter((pago) => pago.invoiceUuid === uuid).map((pago) => ({ parcialidad: pago.parcialidad, monto: pago.amount, fecha: pago.date, formaPago: pago.method, complementoUuid: null, origen: "registrado_en_esta_sesion" as const }));
  return [...previos, ...registrados];
}

function saldoDe(item: Cfdi, state: SatV3State): { pagado: number; saldo: number } {
  const pagado = round2(pagosDe(item.uuid, state).reduce((sum, pago) => sum + pago.monto, 0));
  return { pagado, saldo: round2(item.total - pagado) };
}

function notasDe(uuid: string) {
  return cfdis.filter((item) => item.tipo === "E" && item.relacion?.uuid === uuid);
}

function situacionDe(rfc: string) {
  return contribuyentePorRfc(rfc)?.situacion69B ?? null;
}

function evidenciasDe(uuid: string, state: SatV3State): readonly { tipo: TipoEvidencia; descripcion: string; sha256: string }[] {
  return [
    ...evidenciasPrevias.filter((item) => item.cfdiUuid === uuid),
    ...[...state.evidencias.values()].filter((item) => item.cfdiUuid === uuid),
  ].map(({ tipo, descripcion, sha256 }) => ({ tipo, descripcion, sha256 }));
}

export function puntajeMaterialidad(operationType: OperationType, tipos: ReadonlySet<string>): { puntaje: number; nivel: "suficiente" | "parcial" | "insuficiente"; faltantes: readonly TipoEvidencia[] } {
  const requeridos = evidenciaRequerida[operationType];
  const cubiertos = requeridos.filter((tipo) => tipos.has(tipo));
  const otros = [...tipos].filter((tipo) => !requeridos.includes(tipo as TipoEvidencia)).length;
  const puntaje = Math.min(100, 20 + Math.round((60 * cubiertos.length) / requeridos.length) + 10 * Math.min(2, otros));
  return { puntaje, nivel: puntaje >= 80 ? "suficiente" : puntaje >= 50 ? "parcial" : "insuficiente", faltantes: requeridos.filter((tipo) => !tipos.has(tipo)) };
}

export function riesgoFiscal(input: { importeTotal: number; puntajeMaterialidad?: number | undefined; csdOperacional?: boolean | undefined; situacionEfos?: string | undefined; enListaNegra?: boolean | undefined }): { puntaje: number; nivel: "bajo" | "medio" | "alto"; factores: readonly string[] } {
  const situacion = input.situacionEfos?.toLowerCase();
  const factores: string[] = [];
  let puntaje = 10;
  if (situacion === "definitivo") { puntaje += 60; factores.push("Emisor Definitivo en lista 69-B"); }
  else if (situacion === "presunto") { puntaje += 40; factores.push("Emisor Presunto en lista 69-B"); }
  else if (situacion === "desvirtuado") { puntaje += 5; factores.push("Emisor Desvirtuado (sin riesgo vigente)"); }
  else if (input.enListaNegra === true) { puntaje += 40; factores.push("Emisor en lista negra"); }
  if (input.puntajeMaterialidad !== undefined && input.puntajeMaterialidad < 50) { puntaje += 20; factores.push("Materialidad insuficiente"); }
  else if (input.puntajeMaterialidad !== undefined && input.puntajeMaterialidad < 80) { puntaje += 10; factores.push("Materialidad parcial"); }
  if (input.csdOperacional === false) { puntaje += 15; factores.push("CSD del emisor no operacional"); }
  if (input.importeTotal > 200_000) { puntaje += 5; factores.push("Importe mayor a 200,000"); }
  const final = Math.min(100, puntaje);
  return { puntaje: final, nivel: final >= 60 ? "alto" : final >= 30 ? "medio" : "bajo", factores };
}

const diasEntre = (desde: string, hasta: string): number => Math.round((Date.parse(hasta) - Date.parse(desde)) / 86_400_000);
const sinAcentos = (value: string): string => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

function pendiente(name: string, context: Context, argumentos: unknown, resumen: string) {
  const confirmacionId = `CONF-${context.state.confirmaciones.size + 1}`;
  context.state.confirmaciones.set(confirmacionId, { confirmacionId, herramienta: name, argumentos });
  return {
    data: {
      estado: "pendiente_confirmacion",
      confirmacionId,
      herramienta: name,
      resumen,
      mensaje: "La operacion requiere confirmacion del usuario. No se ha timbrado ni cancelado ningun CFDI.",
    },
  };
}

function cfdiVigenteTipoI(uuid: string): Cfdi {
  const item = cfdiPorUuid(uuid);
  if (!item || item.tipo !== "I") throw new Rejection("NOT_FOUND", `No existe un CFDI de ingreso con UUID ${uuid}`);
  if (item.estado !== "Vigente") throw new Rejection("POLICY", `El CFDI ${uuid} esta ${item.estado}`);
  return item;
}

export function createSatV3Tools(resolveFault: PackFaultResolver = () => null): readonly ToolDefinition<unknown, SatV3State>[] {
  const tools = [
    define("consultar-factura", "Consulta el estado de un CFDI ante el SAT. Requiere UUID, RFC emisor, RFC receptor y total exactos; si algun dato no coincide el SAT responde No Encontrado.", z.object({ uuid: UUID, rfcEmisor: RFC, rfcReceptor: RFC, total: z.number().positive("Total debe ser mayor a cero") }), "read", resolveFault, (input) => {
      const item = cfdiPorUuid(input.uuid);
      const coincide = item && item.rfcEmisor === input.rfcEmisor && item.rfcReceptor === input.rfcReceptor && Math.abs(item.total - input.total) < 0.005;
      if (!item || !coincide) return { data: { estado: "No Encontrado", codigoEstatus: "N - 602: Comprobante no encontrado.", uuid: input.uuid } };
      return { data: { ...vistaCfdi(item), codigoEstatus: "S - Comprobante obtenido satisfactoriamente.", esCancelable: item.estado === "Vigente" ? "Cancelable con aceptacion" : "No cancelable" } };
    }),
    define("consultar-estado-de-pago", "Consulta el estado de pagos de una factura: historial de pagos, saldo actual y si esta totalmente pagada.", z.object({ invoiceUuid: UUID }), "read", resolveFault, (input, context) => {
      const item = cfdiPorUuid(input.invoiceUuid);
      if (!item || item.tipo !== "I") return { data: null };
      const pagos = pagosDe(item.uuid, context.state);
      const { pagado, saldo } = saldoDe(item, context.state);
      return { data: { invoiceUuid: item.uuid, metodoPago: item.metodoPago, moneda: item.moneda, total: item.total, pagado, saldoInsoluto: saldo, totalmentePagada: saldo <= 0, pagos } };
    }),
    define("rastrear-pago", "Registra un pago parcial o total contra una factura PPD. Calcula numero de parcialidad, saldo anterior e insoluto. No es idempotente: registrar el mismo pago dos veces lo duplica.", z.object({
      invoiceUuid: UUID,
      invoiceTotal: z.number().positive().optional(),
      payment: z.object({ amount: z.number().positive(), date: FECHA, method: z.string().min(2), currency: z.string().default("MXN"), exchangeRate: z.number().positive().optional() }),
    }), "simulated-write", resolveFault, (input, context) => {
      const item = cfdiVigenteTipoI(input.invoiceUuid);
      if (item.metodoPago !== "PPD") throw new Rejection("POLICY", "Solo se registran pagos de facturas con metodo de pago PPD");
      const { saldo } = saldoDe(item, context.state);
      if (input.payment.amount - saldo > 0.005) throw new Rejection("POLICY", `El monto ${input.payment.amount} excede el saldo insoluto ${saldo}`);
      const parcialidad = pagosDe(item.uuid, context.state).length + 1;
      const registro: PagoRegistrado = { registroId: `PR-${context.state.pagosRegistrados.size + 1}`, invoiceUuid: item.uuid, amount: input.payment.amount, date: input.payment.date.slice(0, 10), method: input.payment.method, parcialidad, saldoAnterior: saldo, saldoInsoluto: round2(saldo - input.payment.amount) };
      context.state.pagosRegistrados.set(registro.registroId, registro);
      return { data: { ...registro, totalmentePagada: registro.saldoInsoluto <= 0 } };
    }),
    define("validar-rfc-lista-negra", "Valida uno o mas RFCs contra las listas EFOS/EDOS del SAT (Art. 69-B CFF). Estados: Presunto, Definitivo, Desvirtuado, Sentencia favorable.", z.object({ rfc: z.string().optional(), rfcs: z.array(z.string()).optional() }).refine((value) => value.rfc !== undefined || (value.rfcs?.length ?? 0) > 0, "Proporcione rfc o rfcs"), "read", resolveFault, (input) => {
      const lista = [...new Set([...(input.rfc ? [input.rfc] : []), ...(input.rfcs ?? [])])];
      const resultados = lista.map((rfc) => {
        const situacion = situacionDe(rfc);
        const vigente = situacion?.situacion === "Presunto" || situacion?.situacion === "Definitivo";
        return {
          rfc,
          nombre: contribuyentePorRfc(rfc)?.nombre ?? null,
          enLista: situacion !== null,
          situacion: situacion?.situacion ?? null,
          fechaPublicacion: situacion?.fechaPublicacion ?? null,
          oficio: situacion?.oficio ?? null,
          riesgoVigente: vigente,
          recomendacion: vigente ? "Revisar antes de deducir o pagar; solicitar evidencia de materialidad" : "Sin riesgo 69-B vigente",
        };
      });
      return { data: { resultados, resumen: { total: resultados.length, enLista: resultados.filter((item) => item.enLista).length, conRiesgoVigente: resultados.filter((item) => item.riesgoVigente).length } } };
    }),
    define("monitorear-proveedores-efos", "Monitorea proveedores contra la lista 69-B y, con rfcCliente, analiza la red de facturacion: proximidad a EFOS (niveles 1-2) y carruseles de facturacion.", z.object({
      rfcs: z.array(z.string().min(12).max(13)).min(1).max(100),
      rfcCliente: z.string().min(12).max(13).optional(),
      aristas: z.array(z.object({ de: z.string().min(12).max(13), a: z.string().min(12).max(13) })).max(5000).optional(),
    }), "read", resolveFault, (input) => {
      const proveedores = input.rfcs.map((rfc) => {
        const situacion = situacionDe(rfc);
        return { rfc, nombre: contribuyentePorRfc(rfc)?.nombre ?? null, situacion: situacion?.situacion ?? null, alerta: situacion?.situacion === "Presunto" || situacion?.situacion === "Definitivo" };
      });
      if (!input.rfcCliente) return { data: { proveedores } };
      const graph = buildGraph(input.aristas ?? aristasFacturacion);
      const weightOf = (rfc: string): number => baseWeightFor(normalizeSituacion(situacionDe(rfc)?.situacion ?? ""));
      const proximidad = analyzeProximity(graph, input.rfcCliente, weightOf, { maxDepth: 2 });
      const carruseles = detectCarousels(graph);
      return {
        data: {
          proveedores,
          red: {
            rfcCliente: input.rfcCliente,
            puntajeProximidad: round2(proximidad.score),
            contribuciones: proximidad.contributions.map(({ rfc, distancia, score, camino }) => ({ rfc, distancia, score: round2(score), camino })),
            carruseles,
            aristasDerivadas: input.aristas === undefined,
          },
        },
      };
    }),
    define("calcular-riesgo-fiscal", "Calcula un puntaje de riesgo fiscal (0-100) para CFDIs de un emisor, combinando situacion EFOS, materialidad, CSD e importe.", z.object({
      rfcEmisor: RFC, rfcReceptor: RFC, importeTotal: z.number().positive(), importeIva: z.number().nonnegative().optional(),
      puntajeMaterialidad: z.number().min(0).max(100).optional(), csdOperacional: z.boolean().optional(),
      situacionEfos: z.string().optional(), enListaNegra: z.boolean().optional(),
    }), "read", resolveFault, (input) => ({ data: { rfcEmisor: input.rfcEmisor, rfcReceptor: input.rfcReceptor, ...riesgoFiscal(input) } })),
    define("verificar-materialidad", "Verifica la materialidad de un CFDI (Art. 69-B y 29-A CFF) con la evidencia registrada y los documentos proporcionados. Devuelve puntaje 0-100, nivel y faltantes.", z.object({
      cfdiUuid: UUID,
      operationType: z.enum(["services", "goods", "honorarios", "rental", "transport"]),
      documents: z.array(z.object({ type: z.string().min(1), description: z.string().min(1), date: z.string().optional(), reference: z.string().optional() })).optional(),
    }), "read", resolveFault, (input, context) => {
      const item = cfdiPorUuid(input.cfdiUuid);
      if (!item) return { data: null };
      const evidencias = evidenciasDe(item.uuid, context.state);
      const tipos = new Set([...evidencias.map(({ tipo }) => tipo), ...(input.documents ?? []).map(({ type }) => type)]);
      return { data: { cfdiUuid: item.uuid, operationType: input.operationType, evidenciasRegistradas: evidencias.map(({ tipo, descripcion }) => ({ tipo, descripcion })), ...puntajeMaterialidad(input.operationType, tipos) } };
    }),
    define("registrar-evidencia-materialidad", "Registra evidencia documental vinculada a un CFDI. Idempotente: registrar el mismo archivo (mismo sha256) dos veces retorna el registro existente.", z.object({
      cfdiUuid: UUID,
      tipo: z.enum(["contrato", "orden_compra", "guia_embarque", "fotografia", "entregable", "estado_cuenta", "otro"]),
      url: z.string().url(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u, "sha256 invalido"),
      descripcion: z.string().min(1).max(500),
    }), "simulated-write", resolveFault, (input, context) => {
      const item = cfdiPorUuid(input.cfdiUuid);
      if (!item) throw new Rejection("NOT_FOUND", `No existe el CFDI ${input.cfdiUuid}`);
      const key = `${item.uuid}:${input.sha256}`;
      const existente = [...context.state.evidencias.values()].find((evidencia) => `${evidencia.cfdiUuid}:${evidencia.sha256}` === key)
        ?? evidenciasPrevias.filter((evidencia) => `${evidencia.cfdiUuid}:${evidencia.sha256}` === key).map((evidencia, index) => ({ evidenciaId: `EV-H${index + 1}`, ...evidencia }))[0];
      if (existente) return { data: { ...existente, creada: false, mensaje: "La evidencia ya estaba registrada" }, idempotency: { key, committed: true, replayed: true } };
      const evidencia: EvidenciaRegistrada = { evidenciaId: `EV-${context.state.evidencias.size + 1}`, cfdiUuid: item.uuid, tipo: input.tipo, sha256: input.sha256, descripcion: input.descripcion };
      context.state.evidencias.set(evidencia.evidenciaId, evidencia);
      return { data: { ...evidencia, creada: true }, idempotency: { key, committed: true, replayed: false } };
    }),
    define("consultar-trazabilidad-fiscal", "Audita la cadena fiscal de un CFDI: pagos, complementos, notas de credito, evidencia de materialidad y situacion del emisor. Reporta brechas.", z.object({ cfdiUuid: UUID }), "read", resolveFault, (input, context) => {
      const item = cfdiPorUuid(input.cfdiUuid);
      if (!item) return { data: null };
      const pagos = item.tipo === "I" ? pagosDe(item.uuid, context.state) : [];
      const notas = notasDe(item.uuid);
      const evidencias = evidenciasDe(item.uuid, context.state);
      const situacion = situacionDe(item.rfcEmisor);
      const brechas = [
        ...(item.estado === "Cancelado" ? ["CFDI cancelado"] : []),
        ...(item.metodoPago === "PPD" && pagos.length === 0 ? ["Factura PPD sin pagos registrados"] : []),
        ...pagos.filter((pago) => pago.complementoUuid === null).map((pago) => `Pago de ${pago.monto} del ${pago.fecha} sin complemento de pago`),
        ...(item.operationType !== undefined && puntajeMaterialidad(item.operationType, new Set(evidencias.map(({ tipo }) => tipo))).nivel === "insuficiente" ? ["Evidencia de materialidad insuficiente"] : []),
        ...(situacion && (situacion.situacion === "Presunto" || situacion.situacion === "Definitivo") ? [`Emisor en lista 69-B: ${situacion.situacion}`] : []),
      ];
      return { data: { cfdi: vistaCfdi(item), pagos, notasCredito: notas.map((nota) => ({ uuid: nota.uuid, total: nota.total, estado: nota.estado, tipoRelacion: nota.relacion?.tipoRelacion })), evidencias: evidencias.map(({ tipo, descripcion }) => ({ tipo, descripcion })), situacionEmisor69B: situacion?.situacion ?? null, brechas, completa: brechas.length === 0 } };
    }),
    define("verificar-buzon-tributario", "Verifica si un contribuyente tiene habilitado el Buzon Tributario y medios de contacto registrados (Art. 17-K y 86-C CFF).", z.object({ rfc: RFC, email: z.string().email().optional(), telefono: z.string().regex(/^\d{10}$/u).optional() }), "read", resolveFault, (input) => {
      const persona = contribuyentePorRfc(input.rfc);
      if (!persona) return { data: null };
      const enRiesgo = !persona.buzon.habilitado || persona.buzon.mediosContacto === 0;
      return { data: { rfc: persona.rfc, nombre: persona.nombre, habilitado: persona.buzon.habilitado, mediosContactoRegistrados: persona.buzon.mediosContacto, riesgo: enRiesgo ? "alto" : "bajo", observacion: enRiesgo ? "Sin medios de contacto validados; riesgo de multa y de que el SAT considere notificaciones por estrados" : "Buzon habilitado con medios de contacto" } };
    }),
    define("consultar-estado-csd", "Consulta el estado del Certificado de Sello Digital (CSD) de un RFC: vigencia, dias restantes y si puede facturar.", z.object({ rfc: RFC, knownCfdiUuids: z.array(z.string()).optional() }), "read", resolveFault, (input) => {
      const persona = contribuyentePorRfc(input.rfc);
      if (!persona) return { data: null };
      const diasRestantes = diasEntre(FIXTURE_TODAY, persona.csd.vigenciaFin);
      const puedeFacturar = persona.csd.estado === "Vigente" && diasRestantes > 0;
      return { data: { rfc: persona.rfc, estado: persona.csd.estado, noCertificado: persona.csd.noCertificado, vigenciaFin: persona.csd.vigenciaFin, diasRestantes, puedeFacturar, alerta: !puedeFacturar ? "El CSD no permite sellar CFDI" : diasRestantes <= 60 ? `El CSD vence en ${diasRestantes} dias` : null } };
    }),
    define("buscar-catalogo-sat", "Busca claves en catalogos del SAT por codigo o descripcion.", z.object({ type: z.enum(["producto_servicio", "codigo_postal", "forma_pago", "carta_porte_transporte"]), query: z.string().min(1), limit: z.number().int().min(1).max(50).default(10) }), "read", resolveFault, (input) => {
      const catalogo = input.type === "carta_porte_transporte" ? [] : catalogos[input.type];
      const query = sinAcentos(input.query);
      const resultados = catalogo.filter(({ clave, descripcion }) => clave.startsWith(input.query) || sinAcentos(descripcion).includes(query)).slice(0, input.limit);
      return { data: { catalogo: input.type, query: input.query, resultados, total: resultados.length } };
    }),
    define("listar-notas-credito", "Lista notas de credito (CFDI tipo E), opcionalmente filtradas por factura original y tipo de relacion.", z.object({ originalInvoiceUuid: UUID.optional(), relationshipType: z.enum(["01", "03"]).optional(), limit: z.number().int().positive().default(50) }), "read", resolveFault, (input) => {
      const notas = cfdis.filter((item) => item.tipo === "E"
        && (!input.originalInvoiceUuid || item.relacion?.uuid === input.originalInvoiceUuid.toLowerCase())
        && (!input.relationshipType || item.relacion?.tipoRelacion === input.relationshipType)).slice(0, input.limit);
      return { data: notas.map((nota) => ({ uuid: nota.uuid, originalInvoiceUuid: nota.relacion?.uuid, tipoRelacion: nota.relacion?.tipoRelacion, total: nota.total, fecha: nota.fecha, estado: nota.estado, descripcion: nota.descripcion })) };
    }),
    define("consultar-estado-nota-de-credito", "Consulta el estado de acreditacion de una factura: total acreditado por notas vigentes, saldo restante y si esta totalmente acreditada.", z.object({ originalInvoiceUuid: UUID }), "read", resolveFault, (input) => {
      const item = cfdiPorUuid(input.originalInvoiceUuid);
      if (!item || item.tipo !== "I") return { data: null };
      const vigentes = notasDe(item.uuid).filter((nota) => nota.estado === "Vigente");
      const totalAcreditado = round2(vigentes.reduce((sum, nota) => sum + nota.total, 0));
      return { data: { originalInvoiceUuid: item.uuid, totalFactura: item.total, totalAcreditado, saldoRestante: round2(item.total - totalAcreditado), numeroNotasVigentes: vigentes.length, numeroNotasCanceladas: notasDe(item.uuid).length - vigentes.length, totalmenteAcreditada: totalAcreditado >= item.total } };
    }),
    define("crear-nota-credito", "Crea una nota de credito (CFDI tipo E) relacionada a una factura. Requiere confirmacion humana: deja la operacion pendiente y no timbra.", z.object({ originalInvoiceUuid: UUID, amount: z.number().positive(), relationshipType: z.enum(["01", "03"]), reason: z.string().optional() }), "simulated-write", resolveFault, (input, context) => {
      const item = cfdiVigenteTipoI(input.originalInvoiceUuid);
      const acreditado = notasDe(item.uuid).filter((nota) => nota.estado === "Vigente").reduce((sum, nota) => sum + nota.total, 0);
      const disponible = round2(item.total - acreditado);
      if (input.amount - disponible > 0.005) throw new Rejection("POLICY", `El monto ${input.amount} excede el saldo acreditable ${disponible}`);
      return pendiente("crear-nota-credito", context, input, `Nota de credito por ${input.amount} ${item.moneda} relacionada al CFDI ${item.uuid} (tipo de relacion ${input.relationshipType})`);
    }),
    define("crear-complemento-pago", "Genera un complemento de pago (REP 2.0) para facturas PPD. Requiere confirmacion humana: deja la operacion pendiente y no timbra.", z.object({
      emisor: z.object({ rfc: RFC, nombre: z.string().optional() }),
      receptor: z.object({ rfc: RFC, nombre: z.string().optional() }),
      pago: z.object({ fechaPago: FECHA, formaPagoP: z.string().min(2), monedaP: z.string().min(3), monto: z.number().positive(), numOperacion: z.string().optional() }),
      documentosRelacionados: z.array(z.object({ idDocumento: UUID, numParcialidad: z.number().int().positive(), impSaldoAnt: z.number().nonnegative(), impPagado: z.number().positive(), impSaldoInsoluto: z.number().nonnegative() })).min(1),
    }), "simulated-write", resolveFault, (input, context) => {
      for (const documento of input.documentosRelacionados) {
        const item = cfdiVigenteTipoI(documento.idDocumento);
        if (item.metodoPago !== "PPD") throw new Rejection("POLICY", `El CFDI ${item.uuid} no es PPD; no requiere complemento de pago`);
        if (Math.abs(round2(documento.impSaldoAnt - documento.impPagado) - documento.impSaldoInsoluto) > 0.005) throw new Rejection("POLICY", "ImpSaldoInsoluto debe ser ImpSaldoAnt menos ImpPagado");
      }
      return pendiente("crear-complemento-pago", context, input, `Complemento de pago por ${input.pago.monto} ${input.pago.monedaP} con fecha ${input.pago.fechaPago.slice(0, 10)}`);
    }),
    define("cancelar-factura", "Solicita la cancelacion de un CFDI ante el SAT. Operacion destructiva: requiere confirmacion humana y deja la solicitud pendiente.", z.object({ uuid: UUID, rfcEmisor: RFC, rfcReceptor: RFC, total: z.number().positive(), motivoCancelacion: z.enum(["01", "02", "03", "04"]), folioSustitucion: UUID.optional() }), "simulated-write", resolveFault, (input, context) => {
      const item = cfdiPorUuid(input.uuid);
      if (!item || item.rfcEmisor !== input.rfcEmisor || item.rfcReceptor !== input.rfcReceptor || Math.abs(item.total - input.total) > 0.005) throw new Rejection("NOT_FOUND", "Los datos no coinciden con un CFDI emitido");
      if (item.estado === "Cancelado") throw new Rejection("POLICY", `El CFDI ${item.uuid} ya esta cancelado`);
      if (input.motivoCancelacion === "01" && !input.folioSustitucion) throw new Rejection("POLICY", "El motivo 01 requiere folioSustitucion");
      return pendiente("cancelar-factura", context, input, `Cancelacion del CFDI ${item.uuid} con motivo ${input.motivoCancelacion}`);
    }),
  ];
  return tools as readonly ToolDefinition<unknown, SatV3State>[];
}
