import { z } from "zod";
import { ANTHROPIC_MODELS } from "./adapter.js";
import type { AgentPolicy } from "./contracts.js";

export const CONFIGURATION_IDS = ["direct-sonnet", "routed", "no-resource-injection"] as const;
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

export const RESOURCE_VERSION = "operational-resources-v1";
export const PROMPT_VERSION = "agent-prompt-v1";

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

export type AgentConfiguration = {
  id: ConfigurationId;
  executorModel: typeof ANTHROPIC_MODELS.sonnet | typeof ANTHROPIC_MODELS.haiku;
  routerModel?: typeof ANTHROPIC_MODELS.haiku;
  routerTemperature?: 0;
  resources: "injected" | "excluded";
  tools: typeof ALL_TOOLS;
  policy: AgentPolicy;
};

export const AGENT_CONFIGURATIONS: Readonly<Record<ConfigurationId, AgentConfiguration>> = {
  "direct-sonnet": Object.freeze({
    id: "direct-sonnet",
    executorModel: ANTHROPIC_MODELS.sonnet,
    resources: "injected",
    tools: ALL_TOOLS,
    policy: DEFAULT_AGENT_POLICY,
  }),
  routed: Object.freeze({
    id: "routed",
    executorModel: ANTHROPIC_MODELS.haiku,
    routerModel: ANTHROPIC_MODELS.haiku,
    routerTemperature: 0,
    resources: "injected",
    tools: ALL_TOOLS,
    policy: DEFAULT_AGENT_POLICY,
  }),
  "no-resource-injection": Object.freeze({
    id: "no-resource-injection",
    executorModel: ANTHROPIC_MODELS.haiku,
    routerModel: ANTHROPIC_MODELS.haiku,
    routerTemperature: 0,
    resources: "excluded",
    tools: ALL_TOOLS,
    policy: DEFAULT_AGENT_POLICY,
  }),
};

export function modelForRoutedTask(
  complexity: "simple-read-only" | "multi-step" | "recovery" | "simulated-write",
): string {
  return complexity === "simple-read-only" ? ANTHROPIC_MODELS.haiku : ANTHROPIC_MODELS.sonnet;
}
