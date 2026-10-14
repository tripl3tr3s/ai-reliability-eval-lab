/** Shared helpers for projecting tool results into evidence facts. */

export function getStringPath(value: unknown, path: string): string | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[path];
  return typeof candidate === "string" ? candidate : null;
}

export function flattenFacts(value: unknown, path = "result"): readonly string[] {
  if (value === null) return [`${path} null`];
  if (Array.isArray(value)) return value.flatMap((item, index) => flattenFacts(item, `${path}.${index}`));
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => flattenFacts(item, `${path}.${key}`));
  }
  return [`${path} ${String(value)}`];
}
