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
/** Amounts are negated only by a verbal negation ("el saldo no es 90,000"); "sin IVA 100,000" is not a negation of the amount. */
const AMOUNT_NEGATION_CUE = /\b(?:no|nunca|jamas|ni)\b/u;
/** A negation cue counts only within this many words before the phrase, inside the same clause. */
const NEGATION_WINDOW_WORDS = 6;
const NEGATIVE_POLARITY_START = /^(?:no|sin|nunca|ningun|ninguna|ninguno|tampoco|ni|jamas|insuficiente|imposible)\b/u;
/**
 * Clause boundaries: punctuation followed by a space or the end (so "9,000" and "17.25" do not split), and
 * conjunctions that start a new assertion, including causal and corrective ones ("porque", "ya que", "sino").
 */
const CLAUSE_BOUNDARY = /[.!?;,:](?=\s|$)|[()]|\b(?:y|e|pero|aunque|sin embargo|mientras|ademas|por lo que|asi que|porque|ya que|dado que|puesto que|pues|sino)\b/u;

/** The words of the current clause that can scope a negation over what follows. */
function negationScope(prefix: string): string {
  const clause = prefix.split(CLAUSE_BOUNDARY).at(-1) ?? "";
  return clause.trim().split(/\s+/u).slice(-NEGATION_WINDOW_WORDS).join(" ");
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
    if (!NEGATION_CUE.test(negationScope(normalizedText.slice(0, index)))) return true;
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
  // A trailing currency code ("4,000USD") or a score denominator ("80/100") may follow the number directly.
  const pattern = /(?<![a-z0-9_\-/.,])\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,3}(?:\.\d{3})+,\d{1,2}|\d{1,3}(?: \d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(\s?mil\b)?(?!(?!usd|mxn|pesos|dolares|\/100\b)[a-z0-9_\-/]|[.,]\d)/gu;
  const found: FoundAmount[] = [];
  for (const match of normalized.matchAll(pattern)) {
    const raw = match[1]!;
    const european = /^\d{1,3}(?:\.\d{3})+,\d{1,2}$/u.test(raw);
    const numeric = european ? raw.replace(/\./gu, "").replace(",", ".") : raw.replace(/[, ]/gu, "");
    const value = Number(numeric) * (match[2] ? 1_000 : 1);
    if (!Number.isFinite(value)) continue;
    const index = match.index ?? 0;
    found.push({ value, index, negated: AMOUNT_NEGATION_CUE.test(negationScope(normalized.slice(0, index))) });
  }
  return found;
}

const CURRENCY_WORDS: Readonly<Record<"MXN" | "USD", RegExp>> = {
  MXN: /^[\d,. ]*(?:mil\s*)?(?:mxn|pesos?|m\.n\.)/u,
  USD: /^[\d,. ]*(?:mil\s*)?(?:usd|dolares?|us\$)/u,
};

/** Characters after an amount within which its currency must be named. */
const CURRENCY_WINDOW = 24;

/** True when the amount appears affirmed and, if a currency is given, that currency is named right after it. */
export function containsAmount(text: string, value: number, currency?: "MXN" | "USD"): boolean {
  const normalized = normalizeEs(text);
  return extractAmounts(text).some((amount) => {
    if (amount.negated || Math.abs(amount.value - value) >= 0.005) return false;
    if (currency === undefined) return true;
    const after = normalized.slice(amount.index, amount.index + CURRENCY_WINDOW).replace(/^\$?\s?/u, "");
    return CURRENCY_WORDS[currency].test(after);
  });
}

/** Identifier shapes the v3 pack uses, for claim-to-evidence checks. */
export const V3_IDENTIFIER_PATTERN = /\b(?:[a-z&]{3,4}\d{6}[a-z0-9]{3}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|conf-\d+|pr-\d+|ev-\d+)\b/gu;

const STOPWORDS_ES = new Set([
  "para", "como", "esta", "este", "esto", "estos", "estas", "que", "con", "por", "una", "uno", "unos", "las", "los", "del", "sus", "son",
  "fue", "ser", "hay", "tiene", "cfdi", "factura", "resultado", "herramienta", "consulta", "segun", "registro", "datos", "dato",
  "estado", "proveedor", "cliente", "monto", "pago", "pagos", "total", "fecha", "tipo",
]);

const DATE_OR_PERCENT_AFTER = /^\d+(?:\.\d+)?\s*(?:%|de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre))/u;

/**
 * A v3 claim is supported by its linked facts when every identifier and every amount it states appears in them,
 * and, when it states neither, when at least one content word of four or more letters appears in them.
 */
export function claimSupportedEs(claim: string, facts: string): boolean {
  const normalizedClaim = normalizeEs(claim);
  const normalizedFacts = normalizeEs(facts);
  const identifiers = [...normalizedClaim.matchAll(V3_IDENTIFIER_PATTERN)].map(([value]) => value);
  // Day numbers in written dates ("20 de marzo") and percentages are not amounts to look up in the facts.
  const amounts = extractAmounts(claim).filter(({ index }) => !DATE_OR_PERCENT_AFTER.test(normalizedClaim.slice(index).replace(/^\$?\s?/u, ""))).map(({ value }) => value);
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
