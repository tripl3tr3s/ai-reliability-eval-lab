import type { ToolContext, ToolDefinition } from "../contracts.js";
import type { FaultKind } from "../faults.js";

/** Decides which scheduled fault, if any, a tool invocation receives. */
export type PackFaultResolver = (tool: string, context: ToolContext<unknown>) => FaultKind | null;

/** A tool envelope as the experiment sees it in telemetry, before projection into evidence facts. */
export interface ToolResultView {
  readonly ok?: unknown;
  readonly data?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown; readonly retryable?: unknown };
  readonly idempotency?: { readonly key?: unknown; readonly committed?: unknown; readonly replayed?: unknown };
}

export interface PackPromptInput {
  readonly resources: "injected" | "excluded";
  readonly promptVersion: string;
  readonly resourceVersion: string;
}

/**
 * Everything the experiment needs from a domain: tools and their state, how that state is recorded,
 * how tool results become evidence facts for claim checking, and the system prompt. The core
 * (stats, gate, audit, monitor, providers) never imports a pack.
 */
export interface DomainPack<TState = unknown> {
  readonly id: string;
  createTools(resolveFault?: PackFaultResolver): readonly ToolDefinition<unknown, TState>[];
  createState(): TState;
  /** The raw row's finalState. Dataset `expectedState` paths are evaluated against it. */
  finalState(state: TState): Readonly<Record<string, unknown>>;
  /** True when the same mutation was committed twice. */
  hasDuplicateMutation(finalState: Readonly<Record<string, unknown>>): boolean;
  evidenceFacts(tool: string, input: unknown, result: ToolResultView): readonly string[];
  systemPrompt(input: PackPromptInput): string;
}
