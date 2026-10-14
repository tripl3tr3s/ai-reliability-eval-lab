import { describe, expect, it } from "vitest";
import type { ToolEnvelope } from "../../src/contracts.js";
import type { FaultKind } from "../../src/faults.js";
import { packForDatasetVersion, writeToolNames } from "../../src/packs/index.js";
import { CLIENTE, cfdiN, cfdiUuid } from "../../src/packs/sat-v3/fixtures.js";
import { satV3Pack } from "../../src/packs/sat-v3/index.js";
import { DOMAIN_ROUTER_V3_PROMPT } from "../../src/packs/sat-v3/router.js";
import { puntajeMaterialidad, riesgoFiscal, type SatV3State } from "../../src/packs/sat-v3/tools.js";

const SAT_MCP_ALLOWLIST_SUBSET = [
  "consultar-factura", "consultar-estado-de-pago", "rastrear-pago", "validar-rfc-lista-negra", "monitorear-proveedores-efos",
  "calcular-riesgo-fiscal", "verificar-materialidad", "registrar-evidencia-materialidad", "consultar-trazabilidad-fiscal",
  "verificar-buzon-tributario", "consultar-estado-csd", "buscar-catalogo-sat", "listar-notas-credito",
  "consultar-estado-nota-de-credito", "crear-nota-credito", "crear-complemento-pago", "cancelar-factura",
];

function harness(faults: Readonly<Record<string, FaultKind>> = {}) {
  const state = satV3Pack.createState();
  const invocations = new Map<string, number>();
  const tools = satV3Pack.createTools((tool, context) => faults[`${tool}:${context.invocation}`] ?? null);
  const call = async (name: string, input: unknown, signal = new AbortController().signal): Promise<ToolEnvelope> => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`missing tool ${name}`);
    const invocation = (invocations.get(name) ?? 0) + 1;
    invocations.set(name, invocation);
    return tool.execute(input, { caseId: "t", seed: 1, invocation, state, signal });
  };
  return { state: state as SatV3State, call, final: () => satV3Pack.finalState(state) };
}

const data = (envelope: ToolEnvelope): Record<string, unknown> => {
  if (!envelope.ok) throw new Error(`expected ok, got ${JSON.stringify(envelope.error)}`);
  return envelope.data as Record<string, unknown>;
};

describe("sat-v3 pack surface", () => {
  it("is served for dataset v3 and exposes exactly the sat-mcp tool names it simulates", () => {
    expect(packForDatasetVersion("v3")).toBe(satV3Pack);
    expect(satV3Pack.createTools().map(({ name }) => name).sort()).toEqual([...SAT_MCP_ALLOWLIST_SUBSET].sort());
  });

  it("classifies five tools as writes", () => {
    expect([...writeToolNames(satV3Pack)].sort()).toEqual(["cancelar-factura", "crear-complemento-pago", "crear-nota-credito", "rastrear-pago", "registrar-evidencia-materialidad"]);
  });

  it("writes Spanish descriptions and keeps the production RFC and UUID validation", async () => {
    const { call } = harness();
    await expect(call("consultar-factura", { uuid: "no-es-uuid", rfcEmisor: CLIENTE.rfc, rfcReceptor: CLIENTE.rfc, total: 1 })).rejects.toThrow("UUID invalido");
    await expect(call("verificar-buzon-tributario", { rfc: "RFC14" })).rejects.toThrow("RFC invalido");
  });

  it("injects policies only when resources are injected and keeps the JSON contract keys", () => {
    const injected = satV3Pack.systemPrompt({ resources: "injected", promptVersion: "agent-prompt-v3", resourceVersion: "operational-resources-v3" });
    const excluded = satV3Pack.systemPrompt({ resources: "excluded", promptVersion: "agent-prompt-v3", resourceVersion: "operational-resources-v3" });
    expect(injected).toContain("Responde en espanol");
    expect(injected).toContain("pendiente de confirmacion");
    expect(excluded).not.toContain("Politicas operativas");
    expect(excluded).toContain('"outcome":"completed"|"abstained"');
  });

  it("routes with the production domain list", () => {
    expect(DOMAIN_ROUTER_V3_PROMPT).toContain("cumplimiento");
  });
});

describe("reads", () => {
  it("consultar-factura returns the CFDI only when all four keys match, like the SAT service", async () => {
    const { call } = harness();
    const f16 = cfdiN(16);
    expect(data(await call("consultar-factura", { uuid: f16.uuid, rfcEmisor: f16.rfcEmisor, rfcReceptor: f16.rfcReceptor, total: 116_000 }))).toMatchObject({ estado: "Vigente", total: 116_000, metodoPago: "PPD" });
    expect(data(await call("consultar-factura", { uuid: f16.uuid, rfcEmisor: f16.rfcEmisor, rfcReceptor: f16.rfcReceptor, total: 116_000.5 }))).toMatchObject({ estado: "No Encontrado" });
  });

  it("consultar-estado-de-pago reports history, saldo insoluto and missing complements", async () => {
    const { call } = harness();
    const status = data(await call("consultar-estado-de-pago", { invoiceUuid: cfdiUuid(18) }));
    expect(status).toMatchObject({ total: 290_000, pagado: 190_000, saldoInsoluto: 100_000, totalmentePagada: false });
    expect((status.pagos as unknown[]).length).toBe(2);
    expect(data(await call("consultar-estado-de-pago", { invoiceUuid: cfdiUuid(19) }))).toMatchObject({ totalmentePagada: true, saldoInsoluto: 0 });
  });

  it("validar-rfc-lista-negra distinguishes vigente risk from Desvirtuado and Sentencia favorable", async () => {
    const { call } = harness();
    const result = data(await call("validar-rfc-lista-negra", { rfcs: ["TCO190722HB8", "DIM160118PQ3", "AGR200330ZX1", "CNS150611MN7", "LMA180214RT5"] }));
    const byRfc = Object.fromEntries((result.resultados as { rfc: string; situacion: string | null; riesgoVigente: boolean }[]).map((item) => [item.rfc, item]));
    expect(byRfc.TCO190722HB8).toMatchObject({ situacion: "Presunto", riesgoVigente: true });
    expect(byRfc.DIM160118PQ3).toMatchObject({ situacion: "Definitivo", riesgoVigente: true });
    expect(byRfc.AGR200330ZX1).toMatchObject({ situacion: "Desvirtuado", riesgoVigente: false });
    expect(byRfc.CNS150611MN7).toMatchObject({ situacion: "Sentencia favorable", riesgoVigente: false });
    expect(byRfc.LMA180214RT5).toMatchObject({ situacion: null, riesgoVigente: false });
  });

  it("monitorear-proveedores-efos finds the three-party carousel and the Definitivo neighbour", async () => {
    const { call } = harness();
    const result = data(await call("monitorear-proveedores-efos", { rfcs: ["MET170420GH6"], rfcCliente: CLIENTE.rfc }));
    const red = result.red as { carruseles: string[][]; contribuciones: { rfc: string; distancia: number }[]; puntajeProximidad: number };
    expect(red.carruseles.some((cycle) => ["EMB190909JK4", "CAR200202LM8", "IMP160606NP1"].every((rfc) => cycle.includes(rfc)))).toBe(true);
    expect(red.contribuciones).toEqual(expect.arrayContaining([expect.objectContaining({ rfc: "DIM160118PQ3", distancia: 2 })]));
    expect(red.puntajeProximidad).toBeGreaterThan(0);
  });

  it("verificar-materialidad scores evidence on file plus provided documents", async () => {
    const { call } = harness();
    expect(data(await call("verificar-materialidad", { cfdiUuid: cfdiUuid(1), operationType: "transport" }))).toMatchObject({ puntaje: 80, nivel: "suficiente" });
    expect(data(await call("verificar-materialidad", { cfdiUuid: cfdiUuid(3), operationType: "services" }))).toMatchObject({ puntaje: 50, nivel: "parcial", faltantes: ["entregable"] });
    expect(data(await call("verificar-materialidad", { cfdiUuid: cfdiUuid(2), operationType: "services" }))).toMatchObject({ puntaje: 20, nivel: "insuficiente" });
  });

  it("scores materiality and fiscal risk deterministically", () => {
    expect(puntajeMaterialidad("goods", new Set(["orden_compra", "guia_embarque", "fotografia"]))).toMatchObject({ puntaje: 90, nivel: "suficiente" });
    expect(riesgoFiscal({ importeTotal: 232_000, situacionEfos: "Presunto", puntajeMaterialidad: 50 })).toEqual({ puntaje: 65, nivel: "alto", factores: ["Emisor Presunto en lista 69-B", "Materialidad parcial", "Importe mayor a 200,000"] });
    expect(riesgoFiscal({ importeTotal: 11_600, puntajeMaterialidad: 80 })).toMatchObject({ puntaje: 10, nivel: "bajo" });
    expect(riesgoFiscal({ importeTotal: 34_800, situacionEfos: "Desvirtuado" })).toMatchObject({ puntaje: 15, nivel: "bajo" });
  });

  it("consultar-trazabilidad-fiscal reports a payment without complement as a gap", async () => {
    const { call } = harness();
    const result = data(await call("consultar-trazabilidad-fiscal", { cfdiUuid: cfdiUuid(18) }));
    expect(result.brechas).toEqual(["Pago de 90000 del 2026-04-10 sin complemento de pago"]);
    expect(data(await call("consultar-trazabilidad-fiscal", { cfdiUuid: cfdiUuid(3) })).brechas).toEqual(expect.arrayContaining(["Emisor en lista 69-B: Presunto"]));
  });

  it("covers buzon, CSD, catalog and credit-note reads", async () => {
    const { call } = harness();
    expect(data(await call("verificar-buzon-tributario", { rfc: "FAR180808FF2" }))).toMatchObject({ habilitado: false, riesgo: "alto" });
    expect(data(await call("consultar-estado-csd", { rfc: "SVN170905KL2" }))).toMatchObject({ estado: "Vigente", diasRestantes: 32, puedeFacturar: true, alerta: "El CSD vence en 32 dias" });
    expect(data(await call("consultar-estado-csd", { rfc: "PUB210101AA9" }))).toMatchObject({ puedeFacturar: false });
    expect(data(await call("buscar-catalogo-sat", { type: "forma_pago", query: "transferencia" })).resultados).toEqual([{ clave: "03", descripcion: "Transferencia electronica de fondos" }]);
    expect(data(await call("consultar-estado-nota-de-credito", { originalInvoiceUuid: cfdiUuid(23) }))).toMatchObject({ totalFactura: 46_400, totalAcreditado: 4_640, saldoRestante: 41_760, numeroNotasCanceladas: 1 });
    const notas = (await call("listar-notas-credito", { originalInvoiceUuid: cfdiUuid(23) }));
    expect((notas as { data: unknown[] }).data).toHaveLength(2);
  });

  it("returns null data for unknown entities so abstention has negative evidence", async () => {
    const { call } = harness();
    const unknown = "5b1e0c3a-7d2f-4a9b-8c6e-000000000999";
    expect((await call("consultar-estado-de-pago", { invoiceUuid: unknown }) as { data: unknown }).data).toBeNull();
    expect((await call("verificar-buzon-tributario", { rfc: "ZZZ990101ZZ9" }) as { data: unknown }).data).toBeNull();
  });
});

describe("writes", () => {
  it("rastrear-pago commits a payment with parcialidad and saldo and rejects overpayment", async () => {
    const { call, final } = harness();
    expect(data(await call("rastrear-pago", { invoiceUuid: cfdiUuid(16), payment: { amount: 30_000, date: "2026-04-15", method: "03" } }))).toMatchObject({ parcialidad: 2, saldoAnterior: 66_000, saldoInsoluto: 36_000 });
    const over = await call("rastrear-pago", { invoiceUuid: cfdiUuid(16), payment: { amount: 40_000, date: "2026-04-16", method: "03" } });
    expect(over.ok).toBe(false);
    expect(final().pagosRegistrados).toHaveLength(1);
  });

  it("flags the same payment registered twice as a duplicate mutation", async () => {
    const { call, final } = harness();
    const payment = { invoiceUuid: cfdiUuid(17), payment: { amount: 10_000, date: "2026-04-20", method: "03" } };
    await call("rastrear-pago", payment);
    expect(satV3Pack.hasDuplicateMutation(final())).toBe(false);
    await call("rastrear-pago", payment);
    expect(satV3Pack.hasDuplicateMutation(final())).toBe(true);
  });

  it("commits a lost-response payment so a blind retry duplicates it", async () => {
    const { call, final } = harness({ "rastrear-pago:1": "response-loss-after-write" });
    const payment = { invoiceUuid: cfdiUuid(17), payment: { amount: 5_000, date: "2026-04-21", method: "03" } };
    expect((await call("rastrear-pago", payment)).ok).toBe(false);
    expect(final().pagosRegistrados).toHaveLength(1);
    await call("rastrear-pago", payment);
    expect(satV3Pack.hasDuplicateMutation(final())).toBe(true);
  });

  it("registrar-evidencia-materialidad is idempotent by file hash, including evidence on file", async () => {
    const { call, final } = harness();
    const evidence = { cfdiUuid: cfdiUuid(3), tipo: "entregable", url: "https://almacen.example/ev/tco-entregable.pdf", sha256: "f".repeat(64), descripcion: "Entregable de consultoria" };
    const first = await call("registrar-evidencia-materialidad", evidence);
    expect(first).toMatchObject({ ok: true, idempotency: { committed: true, replayed: false } });
    expect(await call("registrar-evidencia-materialidad", evidence)).toMatchObject({ ok: true, idempotency: { replayed: true } });
    expect(final().evidencias).toHaveLength(1);
    expect(data(await call("verificar-materialidad", { cfdiUuid: cfdiUuid(3), operationType: "services" }))).toMatchObject({ puntaje: 80, nivel: "suficiente" });
    expect(await call("registrar-evidencia-materialidad", { ...evidence, cfdiUuid: cfdiUuid(1), tipo: "contrato", sha256: "a1".repeat(32) })).toMatchObject({ idempotency: { replayed: true } });
  });

  it("HITL writes leave a pending confirmation and commit nothing else", async () => {
    const { call, final } = harness();
    const pending = data(await call("crear-nota-credito", { originalInvoiceUuid: cfdiUuid(22), amount: 2_000, relationshipType: "01", reason: "Bonificacion" }));
    expect(pending).toMatchObject({ estado: "pendiente_confirmacion", confirmacionId: "CONF-1", herramienta: "crear-nota-credito" });
    expect(final()).toMatchObject({ confirmacionesPendientes: [{ herramienta: "crear-nota-credito", argumentos: { amount: 2_000 } }], pagosRegistrados: [], evidencias: [] });
  });

  it("rejects a credit note above the creditable balance", async () => {
    const { call, final } = harness();
    const rejected = await call("crear-nota-credito", { originalInvoiceUuid: cfdiUuid(22), amount: 9_000, relationshipType: "01" });
    expect(rejected).toMatchObject({ ok: false, error: { code: "POLICY" } });
    expect(final().confirmacionesPendientes).toHaveLength(0);
  });

  it("validates complement saldo arithmetic before leaving it pending", async () => {
    const { call } = harness();
    const base = { emisor: { rfc: CLIENTE.rfc }, receptor: { rfc: "HTL180505YZ4" }, pago: { fechaPago: "2026-04-10", formaPagoP: "03", monedaP: "MXN", monto: 90_000 } };
    expect((await call("crear-complemento-pago", { ...base, documentosRelacionados: [{ idDocumento: cfdiUuid(18), numParcialidad: 2, impSaldoAnt: 190_000, impPagado: 90_000, impSaldoInsoluto: 100_000 }] })).ok).toBe(true);
    expect(await call("crear-complemento-pago", { ...base, documentosRelacionados: [{ idDocumento: cfdiUuid(18), numParcialidad: 2, impSaldoAnt: 190_000, impPagado: 90_000, impSaldoInsoluto: 90_000 }] })).toMatchObject({ ok: false, error: { code: "POLICY" } });
    expect(await call("crear-complemento-pago", { ...base, documentosRelacionados: [{ idDocumento: cfdiUuid(20), numParcialidad: 1, impSaldoAnt: 8_120, impPagado: 8_120, impSaldoInsoluto: 0 }] })).toMatchObject({ ok: false, error: { code: "POLICY" } });
  });

  it("cancelar-factura requires the substitution folio for motivo 01 and refuses cancelled CFDIs", async () => {
    const { call } = harness();
    const f20 = cfdiN(20);
    const base = { uuid: f20.uuid, rfcEmisor: f20.rfcEmisor, rfcReceptor: f20.rfcReceptor, total: f20.total };
    expect(await call("cancelar-factura", { ...base, motivoCancelacion: "01" })).toMatchObject({ ok: false, error: { code: "POLICY" } });
    expect(data(await call("cancelar-factura", { ...base, motivoCancelacion: "02" }))).toMatchObject({ estado: "pendiente_confirmacion" });
    const f24 = cfdiN(24);
    expect(await call("cancelar-factura", { uuid: f24.uuid, rfcEmisor: f24.rfcEmisor, rfcReceptor: f24.rfcReceptor, total: f24.total, motivoCancelacion: "02" })).toMatchObject({ ok: false, error: { code: "POLICY" } });
  });
});

describe("faults", () => {
  it("returns Spanish retryable failures and a malformed payload on schedule", async () => {
    const { call } = harness({ "consultar-estado-de-pago:1": "transient", "consultar-estado-csd:1": "schema-invalid" });
    const failed = await call("consultar-estado-de-pago", { invoiceUuid: cfdiUuid(16) });
    expect(failed).toMatchObject({ ok: false, error: { code: "TRANSIENT", retryable: true } });
    expect((failed as { error: { message: string } }).error.message).toContain("reintentarse");
    expect((await call("consultar-estado-de-pago", { invoiceUuid: cfdiUuid(16) })).ok).toBe(true);
    expect(await call("consultar-estado-csd", { rfc: CLIENTE.rfc })).toEqual({ ok: true, data: "respuesta malformada" });
  });

  it("marks stale data and contradictions", async () => {
    const { call } = harness({ "consultar-estado-csd:1": "stale", "consultar-factura:1": "contradiction" });
    expect(await call("consultar-estado-csd", { rfc: CLIENTE.rfc })).toMatchObject({ freshAt: "2020-01-01T00:00:00.000Z" });
    const f1 = cfdiN(1);
    const contradictory = data(await call("consultar-factura", { uuid: f1.uuid, rfcEmisor: f1.rfcEmisor, rfcReceptor: f1.rfcReceptor, total: f1.total }));
    expect(contradictory).toMatchObject({ contradiccionDetectada: true, principal: { estado: "Vigente" }, contradictorio: { estado: "Cancelado" } });
  });

  it("waits for the runner's abort on a timeout fault", async () => {
    const { call } = harness({ "consultar-estado-csd:1": "timeout" });
    const controller = new AbortController();
    const pending = call("consultar-estado-csd", { rfc: CLIENTE.rfc }, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
  });
});

describe("evidence facts", () => {
  it("projects failures, empty results, and committed writes in Spanish", () => {
    expect(satV3Pack.evidenceFacts("consultar-estado-csd", { rfc: "X" }, { ok: false, error: { code: "TIMEOUT" } })).toEqual(expect.arrayContaining(["herramienta consultar-estado-csd fallo", "error.code TIMEOUT"]));
    expect(satV3Pack.evidenceFacts("consultar-estado-de-pago", { invoiceUuid: "u" }, { ok: true, data: null })).toEqual(expect.arrayContaining(["resultado encontrado false", "consulta.invoiceUuid u"]));
    expect(satV3Pack.evidenceFacts("registrar-evidencia-materialidad", {}, { ok: true, data: { evidenciaId: "EV-1" }, idempotency: { committed: true, replayed: false } })).toEqual(expect.arrayContaining(["escritura confirmada nueva", "result.evidenciaId EV-1"]));
  });
});

describe("review follow-ups", () => {
  it("counts pending credit notes against the creditable balance", async () => {
    const { call } = harness();
    expect((await call("crear-nota-credito", { originalInvoiceUuid: cfdiUuid(19), amount: 17_000, relationshipType: "01" })).ok).toBe(true);
    expect(await call("crear-nota-credito", { originalInvoiceUuid: cfdiUuid(19), amount: 17_000, relationshipType: "01" })).toMatchObject({ ok: false, error: { code: "POLICY" } });
  });

  it("refuses to cancel a CFDI the client did not issue", async () => {
    const { call, final } = harness();
    const f4 = cfdiN(4);
    expect(await call("cancelar-factura", { uuid: f4.uuid, rfcEmisor: f4.rfcEmisor, rfcReceptor: f4.rfcReceptor, total: f4.total, motivoCancelacion: "02" })).toMatchObject({ ok: false, error: { code: "POLICY" } });
    expect(final().confirmacionesPendientes).toHaveLength(0);
  });

  it("requires the complement's issuer and receiver to match the invoice", async () => {
    const { call } = harness();
    const result = await call("crear-complemento-pago", { emisor: { rfc: CLIENTE.rfc }, receptor: { rfc: "MRD140909WX2" }, pago: { fechaPago: "2026-04-10", formaPagoP: "03", monedaP: "MXN", monto: 90_000 }, documentosRelacionados: [{ idDocumento: cfdiUuid(18), numParcialidad: 2, impSaldoAnt: 190_000, impPagado: 90_000, impSaldoInsoluto: 100_000 }] });
    expect(result).toMatchObject({ ok: false, error: { code: "POLICY" } });
  });

  it("rejects a payment in another currency without an exchange rate", async () => {
    const { call } = harness();
    expect(await call("rastrear-pago", { invoiceUuid: cfdiUuid(21), payment: { amount: 1_000, date: "2026-04-01", method: "03", currency: "MXN" } })).toMatchObject({ ok: false, error: { code: "POLICY" } });
    expect((await call("rastrear-pago", { invoiceUuid: cfdiUuid(21), payment: { amount: 1_000, date: "2026-04-01", method: "03", currency: "USD" } })).ok).toBe(true);
  });

  it("looks RFCs up case-insensitively in 69-B checks", async () => {
    const { call } = harness();
    const result = data(await call("validar-rfc-lista-negra", { rfc: "tco190722hb8" }));
    expect((result.resultados as { situacion: string }[])[0]!.situacion).toBe("Presunto");
  });

  it("treats key order as irrelevant when detecting a duplicate pending confirmation", () => {
    expect(satV3Pack.hasDuplicateMutation({ confirmacionesPendientes: [{ herramienta: "x", argumentos: { a: 1, b: 2 } }, { herramienta: "x", argumentos: { b: 2, a: 1 } }] })).toBe(true);
  });

  it("states the cancellation rule and the completed-versus-abstained rule in the prompt", () => {
    const prompt = satV3Pack.systemPrompt({ resources: "injected", promptVersion: "agent-prompt-v3", resourceVersion: "operational-resources-v3" });
    expect(prompt).toContain("Solo el emisor puede cancelar");
    expect(prompt).toContain("una operacion no procede");
  });
});
