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
