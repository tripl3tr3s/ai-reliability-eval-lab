export const FaultKindValues = ['transient', 'timeout', 'rate-limit', 'schema-invalid', 'not-found', 'stale', 'contradiction', 'response-loss-after-write'] as const;
export type FaultKind = (typeof FaultKindValues)[number];

export interface FaultRule { readonly tool: string; readonly invocation: number; readonly kind: FaultKind }

export function deterministicHash(parts: readonly (string | number)[]): number {
  let hash = 2166136261;
  for (const char of parts.join(':')) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

export function scheduledFault(caseId: string, seed: number, tool: string, invocation: number, schedule: readonly FaultRule[]): FaultKind | null {
  void deterministicHash([caseId, seed, tool, invocation]);
  return schedule.find((rule) => rule.tool === tool && rule.invocation === invocation)?.kind ?? null;
}

export function generatedFault(caseId: string, seed: number, tool: string, invocation: number, enabled: readonly FaultKind[]): FaultKind | null {
  if (enabled.length === 0) return null;
  const hash = deterministicHash([caseId, seed, tool, invocation]);
  return hash % 5 === 0 ? enabled[hash % enabled.length] ?? null : null;
}
