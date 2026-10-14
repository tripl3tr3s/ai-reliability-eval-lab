import { describe, expect, it } from "vitest";
import { claimSupportedEs, containsAffirmedEs, containsAmount, containsIdentifier, extractAmounts } from "../src/text-es.js";

describe("containsAffirmedEs", () => {
  it.each([
    ["La operación quedó pendiente de confirmación.", "pendiente de confirmacion", true],
    ["QUEDÓ PENDIENTE DE CONFIRMACIÓN", "pendiente de confirmación", true],
    ["El proveedor está en situación Presunto.", "presunto", true],
    ["El proveedor no está en situación Presunto.", "presunto", false],
    ["No se emitió la nota de crédito, quedó pendiente.", "se emitio la nota", false],
    ["Sin riesgo vigente: el contribuyente fue desvirtuado.", "riesgo vigente", false],
    ["El contribuyente fue desvirtuado y tiene riesgo vigente.", "riesgo vigente", true],
    ["No hay pagos, pero el saldo insoluto es 34,800.", "saldo insoluto", true],
    ["Nunca se registró evidencia.", "se registro evidencia", false],
    ["Presuntamente correcto", "presunto", false],
  ])("%j contains affirmed %j: %s", (text, phrase, expected) => {
    expect(containsAffirmedEs(text, phrase)).toBe(expected);
  });

  it("accepts negative-polarity expected phrases inside negation", () => {
    expect(containsAffirmedEs("No se puede determinar el propietario.", "no se puede determinar")).toBe(true);
  });
});

describe("amounts", () => {
  it.each([
    ["El total es 116000", 116_000],
    ["El total es 116,000.00 MXN", 116_000],
    ["Total: $116,000", 116_000],
    ["Total de 116 000 pesos", 116_000],
    ["Total 116.000,00", 116_000],
    ["Un saldo de 66 mil pesos", 66_000],
    ["Saldo insoluto: $36,000.50.", 36_000.5],
  ])("%j contains %d", (text, value) => {
    expect(containsAmount(text, value)).toBe(true);
  });

  it("never reads digits inside RFCs, UUIDs, dates, or folios as amounts", () => {
    const text = "CFDI 5b1e0c3a-7d2f-4a9b-8c6e-000000000016 del RFC CFB150310QX4 con fecha 2026-03-20, folio CONF-1 y PR-2.";
    expect(extractAmounts(text).map(({ value }) => value)).toEqual([]);
  });

  it("ignores negated amounts and requires the named currency", () => {
    expect(containsAmount("El total no es 160,000; es 116,000.", 160_000)).toBe(false);
    expect(containsAmount("El total no es 160,000; es 116,000.", 116_000)).toBe(true);
    expect(containsAmount("Total 2,500.00 USD", 2_500, "USD")).toBe(true);
    expect(containsAmount("Total 2,500.00 pesos", 2_500, "USD")).toBe(false);
    expect(containsAmount("Total 2,500.00 dólares", 2_500, "USD")).toBe(true);
  });

  it("does not confuse grouped lists with one amount", () => {
    expect(extractAmounts("parcialidad 2 100,000").map(({ value }) => value)).toEqual([2, 100_000]);
  });
});

describe("identifiers", () => {
  it("matches whole tokens case-insensitively", () => {
    expect(containsIdentifier("rfc tco190722hb8 en lista", "TCO190722HB8")).toBe(true);
    expect(containsIdentifier("RFC TCO190722HB80", "TCO190722HB8")).toBe(false);
    expect(containsIdentifier("folio CONF-1.", "CONF-1")).toBe(true);
    expect(containsIdentifier("folio CONF-12", "CONF-1")).toBe(false);
  });
});

describe("claimSupportedEs", () => {
  const facts = "herramienta consultar-estado-de-pago exitosa consulta.invoiceUuid 5b1e0c3a-7d2f-4a9b-8c6e-000000000018 result.total 290000 result.saldoInsoluto 100000";
  it("requires every stated identifier and amount in the linked facts", () => {
    expect(claimSupportedEs("El saldo insoluto del CFDI 5b1e0c3a-7d2f-4a9b-8c6e-000000000018 es 100,000.", facts)).toBe(true);
    expect(claimSupportedEs("El saldo insoluto es 90,000.", facts)).toBe(false);
    expect(claimSupportedEs("El CFDI 5b1e0c3a-7d2f-4a9b-8c6e-000000000019 tiene saldo.", facts)).toBe(false);
  });

  it("falls back to content-word overlap for claims without identifiers or amounts", () => {
    expect(claimSupportedEs("La factura tiene saldo insoluto.", facts)).toBe(true);
    expect(claimSupportedEs("El proveedor es EFOS definitivo.", facts)).toBe(false);
  });
});

describe("review regressions (negation scope and formats)", () => {
  it.each([
    ["No puedo crear la nota porque el CFDI esta cancelado", "cancelado"],
    ["No puedo crear la nota ya que el CFDI esta cancelado", "cancelado"],
    ["Esa factura no requiere complemento de pago porque es PUE", "es pue"],
    ["No puedo cancelarla porque solo el emisor puede cancelar", "solo el emisor"],
    ["Ya no debe nada porque esta totalmente pagada", "totalmente pagada"],
  ])("affirms the phrase after a causal conjunction: %j", (text, phrase) => {
    expect(containsAffirmedEs(text, phrase)).toBe(true);
  });

  it("keeps a negation that sits right before the phrase", () => {
    expect(containsAffirmedEs("El proveedor no está en situación Presunto.", "presunto")).toBe(false);
    expect(containsAffirmedEs("Sin riesgo vigente.", "riesgo vigente")).toBe(false);
  });

  it("does not let a far-away negation cancel the phrase", () => {
    expect(containsAffirmedEs("No encontré pagos en el historial registrado del cliente, la factura sigue vigente", "vigente")).toBe(true);
  });

  it.each([
    ["El subtotal sin IVA es de $100,000 y el total 116,000", 100_000],
    ["Sin IVA: 100000", 100_000],
    ["El saldo no es 116,000 sino 66,000", 66_000],
    ["No puedo crear la nota porque excede el saldo acreditable de $8120.00", 8_120],
    ["No se pudo crear la nota por $9,000 ya que excede el saldo de 8,120", 8_120],
    ["Puntaje 80/100", 80],
    ["Saldo de 4,000USD", 4_000],
  ])("reads the affirmed amount in %j", (text, value) => {
    expect(containsAmount(text, value)).toBe(true);
  });

  it("requires the currency right after the amount, not anywhere in the answer", () => {
    expect(containsAmount("De la factura por $116,000.00 se pagaron 50,000 pesos", 116_000, "MXN")).toBe(false);
    expect(containsAmount("Saldo de $66,000 M.N.", 66_000, "MXN")).toBe(true);
    expect(containsAmount("Saldo de 4,000USD", 4_000, "USD")).toBe(true);
    expect(containsAmount("Son 4,000 dólares, unos 68,400 pesos", 4_000, "MXN")).toBe(false);
  });

  it("does not treat written dates or percentages in claims as amounts to verify", () => {
    expect(claimSupportedEs("Se pagó el 20 de marzo la cantidad de 50,000.", "result.pagos.0.monto 50000 result.pagos.0.fecha 2026-03-20")).toBe(true);
    expect(claimSupportedEs("Su estado es Cancelado.", "result.estado Vigente result.proveedor X")).toBe(false);
  });
});
