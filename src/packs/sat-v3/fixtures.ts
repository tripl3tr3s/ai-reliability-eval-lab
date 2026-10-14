/**
 * Fictional fixtures for the sat-v3 pack. Every RFC, name, UUID, amount, and document is invented; RFCs
 * follow the SAT format (3 letters, 6 digits, 3 characters for personas morales) so the tool schemas can
 * keep the production RFC regex. Names follow SAT registration style: uppercase, no legal suffix.
 */

export const FIXTURE_TODAY = "2026-10-01";
export const FIXTURE_TIMESTAMP_V3 = "2026-10-01T09:00:00.000Z";

/** Deterministic, visibly synthetic CFDI UUIDs: the last block carries the fixture number. */
export const cfdiUuid = (n: number): string => `5b1e0c3a-7d2f-4a9b-8c6e-${String(n).padStart(12, "0")}`;

export const CLIENTE = { rfc: "CFB150310QX4", nombre: "COMERCIALIZADORA FICTICIA DEL BAJIO", codigoPostal: "37000", regimenFiscal: "601" } as const;

export type Situacion69B = "Presunto" | "Definitivo" | "Desvirtuado" | "Sentencia favorable";

export interface Contribuyente {
  readonly rfc: string;
  readonly nombre: string;
  readonly situacion69B?: { readonly situacion: Situacion69B; readonly fechaPublicacion: string; readonly oficio: string };
  readonly csd: { readonly estado: "Vigente" | "Revocado" | "Caduco"; readonly noCertificado: string; readonly vigenciaFin: string };
  readonly buzon: { readonly habilitado: boolean; readonly mediosContacto: number };
}

const contribuyente = (rfc: string, nombre: string, extra: Partial<Contribuyente> = {}): Contribuyente => ({
  rfc,
  nombre,
  csd: { estado: "Vigente", noCertificado: `0000100000${rfc.slice(3, 9)}0001`, vigenciaFin: "2028-01-31" },
  buzon: { habilitado: true, mediosContacto: 2 },
  ...extra,
});

export const contribuyentes: readonly Contribuyente[] = [
  contribuyente(CLIENTE.rfc, CLIENTE.nombre, { csd: { estado: "Vigente", noCertificado: "00001000000150310001", vigenciaFin: "2027-05-10" } }),
  contribuyente("LMA180214RT5", "LOGISTICA MAREA AZUL"),
  contribuyente("SVN170905KL2", "SERVICIOS VALLE NEVADO", { csd: { estado: "Vigente", noCertificado: "00001000000170905001", vigenciaFin: "2026-11-02" } }),
  contribuyente("TCO190722HB8", "TECNOLOGIA COSTERA", { situacion69B: { situacion: "Presunto", fechaPublicacion: "2026-02-14", oficio: "500-05-2026-1234" } }),
  contribuyente("DIM160118PQ3", "DISTRIBUIDORA IMPERIAL DEL NORTE", { situacion69B: { situacion: "Definitivo", fechaPublicacion: "2025-11-28", oficio: "500-05-2025-9876" } }),
  contribuyente("AGR200330ZX1", "AGROINSUMOS DEL RIO", { situacion69B: { situacion: "Desvirtuado", fechaPublicacion: "2026-01-09", oficio: "500-05-2026-0456" } }),
  contribuyente("CNS150611MN7", "CONSTRUCTORA NOGAL SUR", { situacion69B: { situacion: "Sentencia favorable", fechaPublicacion: "2025-09-30", oficio: "500-05-2025-7001" } }),
  contribuyente("PUB210101AA9", "PUBLICIDAD URBANA NOVA", { csd: { estado: "Revocado", noCertificado: "00001000000210101001", vigenciaFin: "2029-01-01" } }),
  contribuyente("FAR180808FF2", "FARMACEUTICA ARCOIRIS", { buzon: { habilitado: false, mediosContacto: 0 } }),
  contribuyente("MET170420GH6", "METALES TIERRA ROJA"),
  contribuyente("EMB190909JK4", "EMBALAJES BRISA"),
  contribuyente("CAR200202LM8", "CARGA RAPIDA OCCIDENTE", { situacion69B: { situacion: "Presunto", fechaPublicacion: "2026-05-22", oficio: "500-05-2026-3321" } }),
  contribuyente("IMP160606NP1", "IMPRESOS PALMA", { csd: { estado: "Caduco", noCertificado: "00001000000160606001", vigenciaFin: "2026-08-01" } }),
  contribuyente("HON220315QR3", "CONSULTORIA ATLAS"),
  contribuyente("ARR190101ST5", "ARRENDADORA LOMA ALTA"),
  contribuyente("TRA210707UV7", "TRANSPORTES SIERRA MADRE"),
  contribuyente("MRD140909WX2", "MERCADOS DEL RIO DULCE"),
  contribuyente("HTL180505YZ4", "HOTELERA LAGUNA"),
  contribuyente("RST200101AB6", "RESTAURANTES TRES ESTRELLAS"),
];

export const contribuyentePorRfc = (rfc: string): Contribuyente | undefined => contribuyentes.find((item) => item.rfc === rfc.trim().toUpperCase());

export type OperationType = "services" | "goods" | "honorarios" | "rental" | "transport";

export interface Cfdi {
  readonly n: number;
  readonly uuid: string;
  readonly tipo: "I" | "E" | "P";
  readonly rfcEmisor: string;
  readonly rfcReceptor: string;
  readonly subtotal: number;
  readonly iva: number;
  readonly total: number;
  readonly moneda: "MXN" | "USD";
  readonly tipoCambio?: number;
  readonly fecha: string;
  readonly metodoPago: "PUE" | "PPD";
  readonly formaPago: string;
  readonly estado: "Vigente" | "Cancelado";
  readonly descripcion: string;
  readonly claveProdServ: string;
  readonly operationType?: OperationType;
  /** Credit notes (tipo E) only. */
  readonly relacion?: { readonly uuid: string; readonly tipoRelacion: "01" | "03" };
}

const cfdi = (n: number, data: Omit<Cfdi, "n" | "uuid" | "iva" | "total"> & { readonly iva?: number }): Cfdi => {
  const iva = data.iva ?? Math.round(data.subtotal * 0.16 * 100) / 100;
  return { ...data, n, uuid: cfdiUuid(n), iva, total: Math.round((data.subtotal + iva) * 100) / 100 };
};

/** Purchases from suppliers (F01-F15), sales to customers (F16-F25), credit notes (F31-F33), payment complements (F34). */
export const cfdis: readonly Cfdi[] = [
  cfdi(1, { tipo: "I", rfcEmisor: "LMA180214RT5", rfcReceptor: CLIENTE.rfc, subtotal: 10_000, moneda: "MXN", fecha: "2026-01-15", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Servicio de flete enero", claveProdServ: "78101802", operationType: "transport" }),
  cfdi(2, { tipo: "I", rfcEmisor: "SVN170905KL2", rfcReceptor: CLIENTE.rfc, subtotal: 50_000, moneda: "MXN", fecha: "2026-01-20", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Mantenimiento preventivo de montacargas", claveProdServ: "72154000", operationType: "services" }),
  cfdi(3, { tipo: "I", rfcEmisor: "TCO190722HB8", rfcReceptor: CLIENTE.rfc, subtotal: 200_000, moneda: "MXN", fecha: "2026-02-03", metodoPago: "PPD", formaPago: "99", estado: "Vigente", descripcion: "Consultoria tecnologica", claveProdServ: "81111500", operationType: "services" }),
  cfdi(4, { tipo: "I", rfcEmisor: "DIM160118PQ3", rfcReceptor: CLIENTE.rfc, subtotal: 75_000, moneda: "MXN", fecha: "2026-02-10", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Venta de mercancia general", claveProdServ: "50192100", operationType: "goods" }),
  cfdi(5, { tipo: "I", rfcEmisor: "AGR200330ZX1", rfcReceptor: CLIENTE.rfc, subtotal: 30_000, moneda: "MXN", fecha: "2026-02-12", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Fertilizantes", claveProdServ: "10171500", operationType: "goods" }),
  cfdi(6, { tipo: "I", rfcEmisor: "CNS150611MN7", rfcReceptor: CLIENTE.rfc, subtotal: 400_000, moneda: "MXN", fecha: "2026-02-20", metodoPago: "PPD", formaPago: "99", estado: "Vigente", descripcion: "Obra civil de bodega", claveProdServ: "72141100", operationType: "services" }),
  cfdi(7, { tipo: "I", rfcEmisor: "PUB210101AA9", rfcReceptor: CLIENTE.rfc, subtotal: 20_000, moneda: "MXN", fecha: "2026-03-01", metodoPago: "PUE", formaPago: "03", estado: "Cancelado", descripcion: "Campana publicitaria", claveProdServ: "82101500", operationType: "services" }),
  cfdi(8, { tipo: "I", rfcEmisor: "FAR180808FF2", rfcReceptor: CLIENTE.rfc, subtotal: 2_500, iva: 0, moneda: "USD", tipoCambio: 17.25, fecha: "2026-03-03", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Insumos farmaceuticos", claveProdServ: "51101500", operationType: "goods" }),
  cfdi(9, { tipo: "I", rfcEmisor: "MET170420GH6", rfcReceptor: CLIENTE.rfc, subtotal: 125_000, moneda: "MXN", fecha: "2026-03-05", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Lamina de acero", claveProdServ: "30102200", operationType: "goods" }),
  cfdi(10, { tipo: "I", rfcEmisor: "EMB190909JK4", rfcReceptor: CLIENTE.rfc, subtotal: 16_000, moneda: "MXN", fecha: "2026-03-08", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Cajas de carton corrugado", claveProdServ: "24112700", operationType: "goods" }),
  cfdi(11, { tipo: "I", rfcEmisor: "CAR200202LM8", rfcReceptor: CLIENTE.rfc, subtotal: 60_000, moneda: "MXN", fecha: "2026-03-09", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Fletes regionales", claveProdServ: "78101802", operationType: "transport" }),
  cfdi(12, { tipo: "I", rfcEmisor: "IMP160606NP1", rfcReceptor: CLIENTE.rfc, subtotal: 4_000, moneda: "MXN", fecha: "2026-03-10", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Impresion de folletos", claveProdServ: "82121500", operationType: "services" }),
  cfdi(13, { tipo: "I", rfcEmisor: "HON220315QR3", rfcReceptor: CLIENTE.rfc, subtotal: 35_000, moneda: "MXN", fecha: "2026-03-12", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Honorarios por asesoria fiscal", claveProdServ: "80101500", operationType: "honorarios" }),
  cfdi(14, { tipo: "I", rfcEmisor: "ARR190101ST5", rfcReceptor: CLIENTE.rfc, subtotal: 25_000, moneda: "MXN", fecha: "2026-03-15", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Arrendamiento de bodega marzo", claveProdServ: "80131500", operationType: "rental" }),
  cfdi(15, { tipo: "I", rfcEmisor: "TRA210707UV7", rfcReceptor: CLIENTE.rfc, subtotal: 45_000, moneda: "MXN", fecha: "2026-03-18", metodoPago: "PPD", formaPago: "99", estado: "Vigente", descripcion: "Transporte de mercancia a Monterrey", claveProdServ: "78101802", operationType: "transport" }),
  cfdi(16, { tipo: "I", rfcEmisor: CLIENTE.rfc, rfcReceptor: "MRD140909WX2", subtotal: 100_000, moneda: "MXN", fecha: "2026-03-02", metodoPago: "PPD", formaPago: "99", estado: "Vigente", descripcion: "Venta de abarrotes mayoreo", claveProdServ: "50192100" }),
  cfdi(17, { tipo: "I", rfcEmisor: CLIENTE.rfc, rfcReceptor: "MRD140909WX2", subtotal: 30_000, moneda: "MXN", fecha: "2026-03-04", metodoPago: "PPD", formaPago: "99", estado: "Vigente", descripcion: "Venta de bebidas", claveProdServ: "50202300" }),
  cfdi(18, { tipo: "I", rfcEmisor: CLIENTE.rfc, rfcReceptor: "HTL180505YZ4", subtotal: 250_000, moneda: "MXN", fecha: "2026-03-06", metodoPago: "PPD", formaPago: "99", estado: "Vigente", descripcion: "Suministro de blancos para hotel", claveProdServ: "52121500" }),
  cfdi(19, { tipo: "I", rfcEmisor: CLIENTE.rfc, rfcReceptor: "HTL180505YZ4", subtotal: 15_000, moneda: "MXN", fecha: "2026-03-07", metodoPago: "PPD", formaPago: "99", estado: "Vigente", descripcion: "Amenidades", claveProdServ: "53131600" }),
  cfdi(20, { tipo: "I", rfcEmisor: CLIENTE.rfc, rfcReceptor: "RST200101AB6", subtotal: 7_000, moneda: "MXN", fecha: "2026-03-11", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Venta de insumos de cocina", claveProdServ: "50192100" }),
  cfdi(21, { tipo: "I", rfcEmisor: CLIENTE.rfc, rfcReceptor: "RST200101AB6", subtotal: 4_000, iva: 0, moneda: "USD", tipoCambio: 17.1, fecha: "2026-03-13", metodoPago: "PPD", formaPago: "99", estado: "Vigente", descripcion: "Equipo de cocina importado", claveProdServ: "48101500" }),
  cfdi(22, { tipo: "I", rfcEmisor: CLIENTE.rfc, rfcReceptor: "MRD140909WX2", subtotal: 8_000, moneda: "MXN", fecha: "2026-03-14", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Venta de botanas", claveProdServ: "50192100" }),
  cfdi(23, { tipo: "I", rfcEmisor: CLIENTE.rfc, rfcReceptor: "HTL180505YZ4", subtotal: 40_000, moneda: "MXN", fecha: "2026-03-16", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Venta de vajilla", claveProdServ: "52151500" }),
  cfdi(24, { tipo: "I", rfcEmisor: CLIENTE.rfc, rfcReceptor: "RST200101AB6", subtotal: 11_000, moneda: "MXN", fecha: "2026-03-19", metodoPago: "PUE", formaPago: "03", estado: "Cancelado", descripcion: "Venta de utensilios", claveProdServ: "52151600" }),
  cfdi(25, { tipo: "I", rfcEmisor: CLIENTE.rfc, rfcReceptor: "MRD140909WX2", subtotal: 65_000, moneda: "MXN", fecha: "2026-03-21", metodoPago: "PPD", formaPago: "99", estado: "Vigente", descripcion: "Venta de abarrotes abril", claveProdServ: "50192100" }),
  cfdi(31, { tipo: "E", rfcEmisor: CLIENTE.rfc, rfcReceptor: "MRD140909WX2", subtotal: 1_000, moneda: "MXN", fecha: "2026-03-28", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Bonificacion por pronto pago", claveProdServ: "84111506", relacion: { uuid: cfdiUuid(22), tipoRelacion: "01" } }),
  cfdi(32, { tipo: "E", rfcEmisor: CLIENTE.rfc, rfcReceptor: "HTL180505YZ4", subtotal: 4_000, moneda: "MXN", fecha: "2026-03-29", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Descuento por volumen", claveProdServ: "84111506", relacion: { uuid: cfdiUuid(23), tipoRelacion: "01" } }),
  cfdi(33, { tipo: "E", rfcEmisor: CLIENTE.rfc, rfcReceptor: "HTL180505YZ4", subtotal: 2_000, moneda: "MXN", fecha: "2026-03-30", metodoPago: "PUE", formaPago: "03", estado: "Cancelado", descripcion: "Devolucion de vajilla", claveProdServ: "84111506", relacion: { uuid: cfdiUuid(23), tipoRelacion: "03" } }),
  cfdi(34, { tipo: "P", rfcEmisor: CLIENTE.rfc, rfcReceptor: "MRD140909WX2", subtotal: 0, iva: 0, moneda: "MXN", fecha: "2026-03-20", metodoPago: "PUE", formaPago: "03", estado: "Vigente", descripcion: "Complemento de pago parcialidad 1", claveProdServ: "84111506", relacion: { uuid: cfdiUuid(16), tipoRelacion: "01" } }),
];

export const cfdiPorUuid = (uuid: string): Cfdi | undefined => cfdis.find((item) => item.uuid === uuid.toLowerCase());
export const cfdiN = (n: number): Cfdi => {
  const found = cfdis.find((item) => item.n === n);
  if (!found) throw new Error(`Unknown fixture CFDI F${n}`);
  return found;
};

export interface PagoFixture {
  readonly invoiceUuid: string;
  readonly parcialidad: number;
  readonly monto: number;
  readonly fecha: string;
  readonly formaPago: string;
  /** UUID of the payment complement (REP) that covers this payment, if one was issued. */
  readonly complemento: string | null;
}

/** Payments already received before the run, for PPD sales invoices. */
export const pagosPrevios: readonly PagoFixture[] = [
  { invoiceUuid: cfdiUuid(16), parcialidad: 1, monto: 50_000, fecha: "2026-03-20", formaPago: "03", complemento: cfdiUuid(34) },
  { invoiceUuid: cfdiUuid(18), parcialidad: 1, monto: 100_000, fecha: "2026-03-25", formaPago: "03", complemento: "5b1e0c3a-7d2f-4a9b-8c6e-000000000035" },
  { invoiceUuid: cfdiUuid(18), parcialidad: 2, monto: 90_000, fecha: "2026-04-10", formaPago: "03", complemento: null },
  { invoiceUuid: cfdiUuid(19), parcialidad: 1, monto: 17_400, fecha: "2026-03-30", formaPago: "03", complemento: "5b1e0c3a-7d2f-4a9b-8c6e-000000000036" },
  { invoiceUuid: cfdiUuid(25), parcialidad: 1, monto: 75_400, fecha: "2026-04-02", formaPago: "03", complemento: null },
];

export type TipoEvidencia = "contrato" | "orden_compra" | "guia_embarque" | "fotografia" | "entregable" | "estado_cuenta" | "otro";

export interface EvidenciaFixture {
  readonly cfdiUuid: string;
  readonly tipo: TipoEvidencia;
  readonly descripcion: string;
  readonly sha256: string;
}

const sha = (seed: string): string => seed.repeat(64).slice(0, 64);

/** Materiality evidence already on file for purchase CFDIs. */
export const evidenciasPrevias: readonly EvidenciaFixture[] = [
  { cfdiUuid: cfdiUuid(1), tipo: "contrato", descripcion: "Contrato de servicios de flete 2026", sha256: sha("a1") },
  { cfdiUuid: cfdiUuid(1), tipo: "guia_embarque", descripcion: "Guia de embarque GE-0115", sha256: sha("a2") },
  { cfdiUuid: cfdiUuid(3), tipo: "contrato", descripcion: "Contrato de consultoria tecnologica", sha256: sha("b1") },
  { cfdiUuid: cfdiUuid(13), tipo: "contrato", descripcion: "Contrato de asesoria fiscal", sha256: sha("c1") },
  { cfdiUuid: cfdiUuid(13), tipo: "entregable", descripcion: "Informe de asesoria marzo", sha256: sha("c2") },
  { cfdiUuid: cfdiUuid(14), tipo: "contrato", descripcion: "Contrato de arrendamiento de bodega", sha256: sha("d1") },
  { cfdiUuid: cfdiUuid(9), tipo: "orden_compra", descripcion: "Orden de compra OC-0305", sha256: sha("e1") },
];

/** Evidence each operation type needs for full materiality. */
export const evidenciaRequerida: Readonly<Record<OperationType, readonly TipoEvidencia[]>> = {
  services: ["contrato", "entregable"],
  goods: ["orden_compra", "guia_embarque"],
  honorarios: ["contrato", "entregable"],
  rental: ["contrato", "estado_cuenta"],
  transport: ["contrato", "guia_embarque"],
};

/** Billing edges emisor -> receptor for network analysis. Includes a three-party carousel and a Definitivo neighbour. */
export const aristasFacturacion: readonly { readonly de: string; readonly a: string }[] = [
  { de: "LMA180214RT5", a: CLIENTE.rfc },
  { de: "SVN170905KL2", a: CLIENTE.rfc },
  { de: "TCO190722HB8", a: CLIENTE.rfc },
  { de: "DIM160118PQ3", a: "MET170420GH6" },
  { de: "MET170420GH6", a: CLIENTE.rfc },
  { de: "EMB190909JK4", a: "CAR200202LM8" },
  { de: "CAR200202LM8", a: "IMP160606NP1" },
  { de: "IMP160606NP1", a: "EMB190909JK4" },
  { de: "EMB190909JK4", a: CLIENTE.rfc },
  { de: "CAR200202LM8", a: CLIENTE.rfc },
];

export interface CatalogoEntrada { readonly clave: string; readonly descripcion: string }

export const catalogos: Readonly<Record<"producto_servicio" | "codigo_postal" | "forma_pago", readonly CatalogoEntrada[]>> = {
  producto_servicio: [
    { clave: "78101802", descripcion: "Servicios de transporte de carga por carretera (en camion) a nivel regional y nacional" },
    { clave: "80101500", descripcion: "Servicios de consultoria de negocios y administracion corporativa" },
    { clave: "80131500", descripcion: "Alquiler y arrendamiento de propiedades o edificaciones" },
    { clave: "81111500", descripcion: "Ingenieria de software o hardware" },
    { clave: "84111506", descripcion: "Servicios de facturacion" },
    { clave: "50192100", descripcion: "Botanas y productos de abarrotes" },
    { clave: "24112700", descripcion: "Cajas de carton corrugado" },
    { clave: "72154000", descripcion: "Servicios de mantenimiento de equipo industrial" },
  ],
  codigo_postal: [
    { clave: "37000", descripcion: "Leon de los Aldama, Guanajuato" },
    { clave: "76000", descripcion: "Santiago de Queretaro, Queretaro" },
    { clave: "44100", descripcion: "Guadalajara, Jalisco" },
    { clave: "64000", descripcion: "Monterrey, Nuevo Leon" },
  ],
  forma_pago: [
    { clave: "01", descripcion: "Efectivo" },
    { clave: "02", descripcion: "Cheque nominativo" },
    { clave: "03", descripcion: "Transferencia electronica de fondos" },
    { clave: "04", descripcion: "Tarjeta de credito" },
    { clave: "28", descripcion: "Tarjeta de debito" },
    { clave: "99", descripcion: "Por definir" },
  ],
};

/** Operational resources for agent-prompt-v3, in Spanish, mirroring DISAI_Conta's HITL and payment rules. */
export const politicasOperativasV3 = [
  "crear-complemento-pago, crear-nota-credito y cancelar-factura requieren confirmacion humana: la herramienta deja la operacion pendiente de confirmacion y no timbra ni cancela nada. Nunca afirmes que el documento quedo emitido, timbrado o cancelado; informa que quedo pendiente de confirmacion.",
  "Antes de registrar un pago con rastrear-pago consulta el saldo con consultar-estado-de-pago. No registres el mismo pago dos veces.",
  "Los proveedores en situacion Presunto o Definitivo del Art. 69-B requieren revision antes de deducir sus CFDI. Desvirtuado y Sentencia favorable no son un riesgo vigente.",
  "Para cancelar con motivo 01 se requiere el folio fiscal (UUID) que sustituye al CFDI.",
  "Solo el emisor puede cancelar un CFDI. Las facturas que recibe la empresa no se cancelan desde aqui: se le pide al emisor que solicite la cancelacion.",
] as const;
