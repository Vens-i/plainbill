/**
 * The slice of AG Studio's agent protocol the Claude bridge speaks (ag-studio's AgLlmRequest,
 * AgAiEvent and AgLlmResponse), written out structurally so this package doesn't depend on
 * the commercial ag-studio package. apps/web passes Studio's request through unchanged and
 * reads these events back.
 */

export type StudioConversationItem =
  | {
      kind: 'input';
      type: 'message';
      role: 'user' | 'system';
      content: Array<{ type: string; text?: string }>;
    }
  | {
      kind: 'output';
      type: 'message';
      role: 'assistant';
      content: Array<{ type: string; text?: string; refusal?: string }>;
    }
  | { type: 'function_call'; callId: string; name: string; arguments: string }
  | { type: 'function_call_output'; callId: string; output: string }
  | { type: 'reasoning' };

export interface StudioToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  kind?: 'client' | 'server' | 'provided';
  provider?: unknown;
}

export interface StudioTurnRequest {
  input: StudioConversationItem[];
  instructions?: string;
  tools?: StudioToolSchema[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  responseFormat?:
    | { type: 'text' }
    | { type: 'json'; name: string; description?: string; schema: Record<string, unknown> };
  model?: { id: string; effort?: string };
}

export type StudioEvent =
  | { type: 'TEXT_MESSAGE_START'; messageId: string; role: 'assistant' }
  | { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string }
  | { type: 'TEXT_MESSAGE_END'; messageId: string }
  | { type: 'TOOL_CALL_START'; toolCallId: string; toolCallName: string; parentMessageId?: string }
  | { type: 'TOOL_CALL_ARGS'; toolCallId: string; delta: string }
  | { type: 'TOOL_CALL_END'; toolCallId: string };

export type StudioOutputItem =
  | {
      id: string;
      kind: 'output';
      type: 'message';
      role: 'assistant';
      status: 'completed';
      content: Array<{ type: 'text'; text: string; annotations: [] }>;
    }
  | {
      id: string;
      kind: 'output';
      type: 'function_call';
      callId: string;
      name: string;
      arguments: string;
      status: 'completed';
    };

export interface StudioTurnResponse {
  id: string;
  createdAt: number;
  status: 'completed' | 'failed' | 'incomplete' | 'cancelled';
  output: StudioOutputItem[];
  error?: { code: string; message: string };
  incompleteDetails?: { reason: 'max_output_tokens' | 'content_filter' };
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  model?: string;
}

/** One line of the NDJSON stream /api/studio/llm sends: events, then exactly one response. */
export type StudioStreamLine = { event: StudioEvent } | { response: StudioTurnResponse };
