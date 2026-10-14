/**
 * Deterministic Spanish (es-MX) text matching for dataset v3. Pure functions, no project imports.
 *
 * Matching is accent- and case-insensitive. A phrase counts only as a whole-token match outside the scope of a
 * negation cue in the same clause ("no", "sin", "nunca", "ningun/a/o", "tampoco", "ni", "jamas"), so
 * "no se emitio la nota" does not satisfy "se emitio la nota". Amounts are parsed from the formats an answer can
 * use and compared numerically; digits inside RFCs, UUIDs, dates, and folios are never read as amounts.
 */

export function normalizeEs(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[’`]/gu, "'").replace(/\s+/gu, " ");
}

const TOKEN_CHAR = /[a-z0-9_-]/u;
const NEGATION_CUE = /\b(?:no|sin|nunca|ningun|ninguna|ninguno|tampoco|ni|jamas)\b/u;
const NEGATIVE_POLARITY_START = /^(?:no|sin|nunca|ningun|ninguna|ninguno|tampoco|ni|jamas|insuficiente|imposible)\b/u;
/** Clause boundaries: punctuation and contrastive or additive conjunctions that start a new assertion. */
const CLAUSE_BOUNDARY = /[.!?;,:()]|\b(?:y|e|pero|aunque|sin embargo|mientras|ademas|por lo que|asi que)\b/u;

function lastClause(prefix: string): string {
  const parts = prefix.split(CLAUSE_BOUNDARY);
  return parts.at(-1) ?? "";
}

function* wholeTokenMatches(text: string, phrase: string): Generator<number> {
  if (phrase.length === 0) return;
  let index = text.indexOf(phrase);
  while (index >= 0) {
    const before = text[index - 1] ?? "";
    const after = text[index + phrase.length] ?? "";
    if (!TOKEN_CHAR.test(before) && !TOKEN_CHAR.test(after)) yield index;
    index = text.indexOf(phrase, index + 1);
  }
}

/** True when the phrase appears as a whole token, affirmed (not inside a negated clause). */
export function containsAffirmedEs(text: string, phrase: string): boolean {
  const normalizedText = normalizeEs(text);
  const normalizedPhrase = normalizeEs(phrase).trim();
  const phraseIsNegative = NEGATIVE_POLARITY_START.test(normalizedPhrase);
  for (const index of wholeTokenMatches(normalizedText, normalizedPhrase)) {
    if (phraseIsNegative) return true;
    if (!NEGATION_CUE.test(lastClause(normalizedText.slice(0, index)))) return true;
  }
  return false;
}

/** True when the identifier (RFC, UUID, folio) appears as a whole token, case-insensitively. */
export function containsIdentifier(text: string, identifier: string): boolean {
  const normalizedText = normalizeEs(text);
  const normalizedIdentifier = normalizeEs(identifier).trim();
  return !wholeTokenMatches(normalizedText, normalizedIdentifier).next().done;
}

export interface FoundAmount {
  readonly value: number;
  readonly index: number;
  readonly negated: boolean;
}

/**
 * Amounts in the text: 1160, 1,160, 1,160.00, 1 160, $1,160.50, 1.160,00 (European), and 116 mil.
 * A number glued to letters, hyphens, slashes, or other digits groups (RFC, UUID, date, folio) is skipped.
 */
export function extractAmounts(text: string): readonly FoundAmount[] {
  const normalized = normalizeEs(text);
  const pattern = /(?<![a-z0-9_\-/.,])\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,3}(?:\.\d{3})+,\d{1,2}|\d{1,3}(?: \d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(\s?mil\b)?(?![a-z0-9_\-/]|[.,]\d)/gu;
  const found: FoundAmount[] = [];
  for (const match of normalized.matchAll(pattern)) {
    const raw = match[1]!;
    const european = /^\d{1,3}(?:\.\d{3})+,\d{1,2}$/u.test(raw);
    const numeric = european ? raw.replace(/\./gu, "").replace(",", ".") : raw.replace(/[, ]/gu, "");
    const value = Number(numeric) * (match[2] ? 1_000 : 1);
    if (!Number.isFinite(value)) continue;
    const index = match.index ?? 0;
    found.push({ value, index, negated: NEGATION_CUE.test(lastClause(normalized.slice(0, index))) });
  }
  return found;
}

const CURRENCY_WORDS: Readonly<Record<"MXN" | "USD", RegExp>> = {
  MXN: /\b(?:mxn|pesos?|m\.n\.)\b/u,
  USD: /\b(?:usd|dolares?|us\$)\b/u,
};

/** True when the amount appears affirmed, and, if a currency is given, the currency is named in the answer. */
export function containsAmount(text: string, value: number, currency?: "MXN" | "USD"): boolean {
  const hit = extractAmounts(text).some((amount) => !amount.negated && Math.abs(amount.value - value) < 0.005);
  return hit && (currency === undefined || CURRENCY_WORDS[currency].test(normalizeEs(text)));
}

/** Identifier shapes the v3 pack uses, for claim-to-evidence checks. */
export const V3_IDENTIFIER_PATTERN = /\b(?:[a-z&]{3,4}\d{6}[a-z0-9]{3}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|conf-\d+|pr-\d+|ev-\d+)\b/gu;

const STOPWORDS_ES = new Set([
  "para", "como", "esta", "este", "esto", "estos", "estas", "que", "con", "por", "una", "uno", "unos", "las", "los", "del", "sus", "son",
  "fue", "ser", "hay", "tiene", "cfdi", "factura", "resultado", "herramienta", "consulta", "segun", "registro", "datos", "dato",
]);

/**
 * A v3 claim is supported by its linked facts when every identifier and every amount it states appears in them,
 * and, when it states neither, when at least one content word of four or more letters appears in them.
 */
export function claimSupportedEs(claim: string, facts: string): boolean {
  const normalizedClaim = normalizeEs(claim);
  const normalizedFacts = normalizeEs(facts);
  const identifiers = [...normalizedClaim.matchAll(V3_IDENTIFIER_PATTERN)].map(([value]) => value);
  const amounts = extractAmounts(claim).map(({ value }) => value);
  const factAmounts = new Set(extractAmountsLoose(facts));
  if (!identifiers.every((identifier) => containsIdentifier(normalizedFacts, identifier))) return false;
  if (!amounts.every((value) => [...factAmounts].some((fact) => Math.abs(fact - value) < 0.005))) return false;
  if (identifiers.length > 0 || amounts.length > 0) return true;
  const words = normalizedClaim.match(/[a-z]{4,}/gu) ?? [];
  return words.filter((word) => !STOPWORDS_ES.has(word)).some((word) => normalizedFacts.includes(word));
}

/** Numbers in flattened fact strings ("result.total 116000"), where field paths precede the value. */
function extractAmountsLoose(facts: string): readonly number[] {
  return [...normalizeEs(facts).matchAll(/(?<![a-z0-9_-])(\d+(?:\.\d+)?)(?![a-z0-9_-])/gu)].map(([, value]) => Number(value));
}
