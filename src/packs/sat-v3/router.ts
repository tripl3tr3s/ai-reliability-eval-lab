/**
 * Domain router for the sat-v3 pack, modeled on DISAI_Conta's router (`src/lib/ai/router.ts`, ROUTER_SYSTEM):
 * English instructions with the production Spanish keyword lists, restricted to the domains whose tools
 * this pack simulates. Production also returns a query type and a confidence and sends low-confidence
 * routes to a read-only generalist; every v3 case is an action on a named entity, so the lab asks for the
 * domain only. Tiering mirrors production `modelTier`: pagos and cumplimiento run on the advanced executor.
 */

export const ROUTER_DOMAINS = [
  "facturacion",
  "pagos",
  "notas-credito",
  "cumplimiento",
  "cancelaciones",
  "general",
] as const;
export type RouterDomain = (typeof ROUTER_DOMAINS)[number];

export const ADVANCED_DOMAINS: ReadonlySet<RouterDomain> = new Set([
  "pagos",
  "cumplimiento",
]);

export type ExecutionTier = "standard" | "advanced";

export function tierForDomain(domain: RouterDomain): ExecutionTier {
  return ADVANCED_DOMAINS.has(domain) ? "advanced" : "standard";
}

const DOMAIN_KEYWORDS: Readonly<
  Record<Exclude<RouterDomain, "general">, string>
> = {
  facturacion:
    "factura, CFDI ingreso, timbrar, emisor, receptor, clave, uuid, forma de pago, método de pago, uso CFDI, código SAT, catálogo SAT, ClaveProdServ, ClaveUnidad, código producto, código servicio, buscar catálogo, clave producto",
  pagos:
    "complemento de pago, REP, pago parcial, parcialidad, saldo insoluto, aplicar pago, pago diferido, PPD, rastrear pago, estado de pago",
  "notas-credito":
    "nota de crédito, devolución, descuento, egreso, tipo E, CFDI relacionado, corrección",
  cumplimiento:
    "EFOS, EDOS, lista negra, riesgo fiscal, CSD, certificado sello digital, buzón tributario, Art. 69-B, cumplimiento, validar RFC, materialidad, evidencia, trazabilidad fiscal",
  cancelaciones:
    "cancelar, cancelación, cancelar CFDI, motivo cancelación, motivo 01, motivo 02, motivo 03, motivo 04, aceptación receptor, UUID cancelación, estatus cancelación, CFDI cancelado",
};

export const DOMAIN_ROUTER_V3_PROMPT = `You are a domain router for a Mexican tax compliance platform.
Classify the user message into exactly one domain.

DOMAINS:
${Object.entries(DOMAIN_KEYWORDS)
  .map(([domain, keywords]) => `- ${domain}: ${keywords}`)
  .join("\n")}
- general: cross-domain or messages with no domain-suggestive content at all

When a message is vague but leans toward a domain, choose that domain. Reserve general for messages that give no domain signal.

Return only one JSON object: {"domain":"<one of ${ROUTER_DOMAINS.join(", ")}>"}. No Markdown fences, no prose.`;

const DOMAINS: ReadonlySet<string> = new Set(ROUTER_DOMAINS);

/** Reads the first JSON object in the router text. Anything unparseable or off-list routes to general (standard tier). */
export function parseRoutedDomain(text: string): RouterDomain {
  const match = /\{[^{}]*\}/u.exec(text);
  if (!match) return "general";
  try {
    const domain = (JSON.parse(match[0]) as { domain?: unknown }).domain;
    return typeof domain === "string" && DOMAINS.has(domain)
      ? (domain as RouterDomain)
      : "general";
  } catch {
    return "general";
  }
}
