import { ANTHROPIC_MODEL_CAPABILITIES } from "../adapter.js";
import type { ModelAdapter, ModelCapabilities } from "../contracts.js";

/** Conservative defaults for a model nobody has declared: no temperature, standard output allowance. */
export const GENERIC_CAPABILITIES: ModelCapabilities = Object.freeze({
  provider: "unknown",
  acceptsTemperature: false,
  maxOutputTokensPerCall: 4_096,
  toolCalling: true,
  structuredOutput: "prompt",
});

/** Capabilities of pinned models, keyed by model id. Adding a provider's pinned models means adding its table here. */
const REGISTERED: Readonly<Record<string, ModelCapabilities>> = { ...ANTHROPIC_MODEL_CAPABILITIES };

/**
 * Resolves capabilities for a model: the adapter's own declaration first, then the registry
 * of pinned models (for wrappers and test doubles that do not declare any), then generic defaults.
 */
export function capabilitiesFor(adapter: ModelAdapter, model: string): ModelCapabilities {
  return adapter.capabilities?.(model) ?? REGISTERED[model] ?? GENERIC_CAPABILITIES;
}

/** Wraps `generate` while keeping the inner adapter's capability declaration visible. */
export function wrapAdapter(inner: ModelAdapter, generate: ModelAdapter["generate"]): ModelAdapter {
  return inner.capabilities ? { generate, capabilities: (model) => inner.capabilities!(model) } : { generate };
}
