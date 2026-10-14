import { z } from "zod";
import type { ModelToolCall } from "../contracts.js";

const AssistantTurnSchema = z.object({
  text: z.string(),
  toolCalls: z.array(z.object({ id: z.string(), name: z.string(), input: z.unknown() })),
});

export interface AssistantTurn {
  readonly text: string;
  readonly toolCalls: readonly ModelToolCall[];
}

/**
 * The runner stores an assistant turn as one JSON string in a normalized message.
 * Adapters decode it with this helper to rebuild provider-native tool-call blocks.
 */
export function encodeAssistantTurn(turn: AssistantTurn): string {
  return JSON.stringify({ text: turn.text, toolCalls: turn.toolCalls });
}

/** Returns null when the content is plain text rather than an encoded turn. */
export function decodeAssistantTurn(content: string): AssistantTurn | null {
  try {
    return AssistantTurnSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}
