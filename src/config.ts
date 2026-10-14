import { z } from "zod";
import { ANTHROPIC_MODEL_ROLES, ANTHROPIC_MODELS } from "./adapter.js";
import type { AgentPolicy, Effort, ModelRoles } from "./contracts.js";

/** Models the published benchmark pins. Other providers supply their own roles through the adapter factory. */
export const DEFAULT_MODEL_ROLES: ModelRoles = ANTHROPIC_MODEL_ROLES;

/** Arms pinned to the legacy Sonnet 5 / Haiku 4.5 benchmark. Their models come from provider roles. */
export const LEGACY_ARMS = ["direct-sonnet", "routed", "no-resource-injection"] as const;
/** Arms that mirror the DISAI_Conta 5.5 lineup. Their models and effort are pinned per arm. */
export const LINEUP_5_5_ARMS = ["prod-routed-5-5", "direct-sonnet-5-5"] as const;
export const CONFIGURATION_IDS = [...LEGACY_ARMS, ...LINEUP_5_5_ARMS] as const;
export type ConfigurationId = (typeof CONFIGURATION_IDS)[number];

export const ALL_TOOLS = [
  "search_documents",
  "get_document",
  "list_payments",
  "match_payment",
  "check_supplier_status",
  "analyze_supplier_network",
  "get_operational_policy",
  "create_follow_up",
] as const;

export const RESOURCE_VERSION = "operational-resources-v2";
export const PROMPT_VERSION = "agent-prompt-v2";
export const LEGACY_RESOURCE_VERSION = "operational-resources-v1";
export const LEGACY_PROMPT_VERSION = "agent-prompt-v1";

export const agentPolicySchema = z.object({
  maxIterations: z.number().int().positive().max(6),
  maxToolCalls: z.number().int().positive().max(8),
  toolTimeoutMs: z.number().int().positive(),
  deadlineMs: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  maxCostUsd: z.number().positive(),
  allowedTools: z.array(z.string()),
});

export const DEFAULT_AGENT_POLICY: AgentPolicy = Object.freeze({
  maxIterations: 6,
  maxToolCalls: 8,
  toolTimeoutMs: 10_000,
  deadlineMs: 120_000,
  maxOutputBytes: 64_000,
  maxTokens: 12_000,
  maxCostUsd: 2,
  allowedTools: ALL_TOOLS,
});

/** Which model runs a role: a provider role (legacy arms) or a pinned model with its effort (5.5 arms). */
export type ModelSlot =
  | { readonly role: keyof ModelRoles }
  | { readonly model: string; readonly effort?: Effort };

export interface ResolvedSlot {
  readonly model: string;
  readonly effort?: Effort;
}

export function resolveSlot(slot: ModelSlot, roles: ModelRoles): ResolvedSlot {
  return "role" in slot ? { model: roles[slot.role] } : slot;
}

/**
 * "complexity-v2": the v2 router labels the task's complexity and simple read-only work goes to the simple executor.
 * "domain-v3": the v3 router labels the fiscal domain, as DISAI_Conta's router does, and advanced domains go to the advanced executor.
 */
export type RouterKind = "complexity-v2" | "domain-v3";

export interface AgentConfiguration {
  readonly id: ConfigurationId;
  readonly executor: ModelSlot;
  /** Complexity routing only: executes simple read-only tasks. */
  readonly simpleExecutor?: ModelSlot;
  /** Domain routing only: executes advanced-tier domains. */
  readonly advancedExecutor?: ModelSlot;
  readonly router?: { readonly kind: RouterKind; readonly slot: ModelSlot };
  readonly resources: "injected" | "excluded";
  readonly tools: typeof ALL_TOOLS;
  readonly policy: AgentPolicy;
}

/**
 * Run-level bounds for adaptive-thinking models. The runner counts input and output tokens of every call,
 * thinking included, and resends the growing history each iteration, so 12 000 tokens would bound runs that
 * made no mistake. Starting values: the v3 smoke run calibrates them before any full run.
 */
export const V3_AGENT_POLICY: AgentPolicy = Object.freeze({
  ...DEFAULT_AGENT_POLICY,
  deadlineMs: 180_000,
  maxTokens: 150_000,
});

const LEGACY_ROUTER = Object.freeze({ kind: "complexity-v2" as const, slot: Object.freeze({ role: "router" as const }) });

const arm = (configuration: AgentConfiguration): AgentConfiguration => Object.freeze(configuration);

export const AGENT_CONFIGURATIONS: Readonly<Record<ConfigurationId, AgentConfiguration>> = {
  "direct-sonnet": arm({
    id: "direct-sonnet",
    executor: { role: "executor" },
    resources: "injected",
    tools: ALL_TOOLS,
    policy: DEFAULT_AGENT_POLICY,
  }),
  routed: arm({
    id: "routed",
    executor: { role: "executor" },
    simpleExecutor: { role: "simpleExecutor" },
    router: LEGACY_ROUTER,
    resources: "injected",
    tools: ALL_TOOLS,
    policy: DEFAULT_AGENT_POLICY,
  }),
  "no-resource-injection": arm({
    id: "no-resource-injection",
    executor: { role: "executor" },
    simpleExecutor: { role: "simpleExecutor" },
    router: LEGACY_ROUTER,
    resources: "excluded",
    tools: ALL_TOOLS,
    policy: DEFAULT_AGENT_POLICY,
  }),
  "prod-routed-5-5": arm({
    id: "prod-routed-5-5",
    executor: { model: ANTHROPIC_MODELS.sonnet55, effort: "medium" },
    advancedExecutor: { model: ANTHROPIC_MODELS.opus55, effort: "high" },
    router: { kind: "domain-v3", slot: { model: ANTHROPIC_MODELS.haiku55, effort: "low" } },
    resources: "injected",
    tools: ALL_TOOLS,
    policy: V3_AGENT_POLICY,
  }),
  "direct-sonnet-5-5": arm({
    id: "direct-sonnet-5-5",
    executor: { model: ANTHROPIC_MODELS.sonnet55, effort: "medium" },
    resources: "injected",
    tools: ALL_TOOLS,
    policy: V3_AGENT_POLICY,
  }),
};

export function modelForRoutedTask(
  complexity: "simple-read-only" | "multi-step" | "recovery" | "simulated-write",
  roles: ModelRoles = DEFAULT_MODEL_ROLES,
): string {
  return complexity === "simple-read-only" ? roles.simpleExecutor : roles.executor;
}
