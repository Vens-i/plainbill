/**
 * AG Studio ⇄ Claude. AG Studio's agent framework ships no model connection: each turn it hands
 * the app a request (conversation, instructions, tool schemas) and expects streamed events back.
 * This turns that request into Anthropic Messages API parameters, and Claude's stream events
 * into Studio's events plus the turn's final response. Studio runs the tools itself (in the
 * browser, against the dashboard) and sends their results back on the next turn.
 */
import type {
  StudioConversationItem,
  StudioEvent,
  StudioOutputItem,
  StudioTurnRequest,
  StudioTurnResponse,
} from './protocol';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };
type Turn = { role: 'user' | 'assistant'; content: Block[] };
/** A mid-conversation system message carries an operator instruction for this turn. */
type Message = Turn | { role: 'system'; content: string };

function parseArgs(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Studio's conversation as Anthropic messages; system messages are folded into `system`. */
export function toAnthropicMessages(input: StudioConversationItem[]): {
  messages: Turn[];
  extraSystem: string[];
} {
  const messages: Turn[] = [];
  const extraSystem: string[] = [];
  const push = (role: 'user' | 'assistant', block: Block) => {
    const last = messages.at(-1);
    if (last && last.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  for (const item of input) {
    if (item.type === 'message') {
      const text = item.content
        .map((c) => c.text ?? ('refusal' in c ? c.refusal : undefined) ?? '')
        .join(item.kind === 'input' ? '\n' : '')
        .trim();
      if (!text) continue;
      if (item.kind === 'input' && item.role === 'system') extraSystem.push(text);
      else push(item.kind === 'input' ? 'user' : 'assistant', { type: 'text', text });
    } else if (item.type === 'function_call') {
      push('assistant', {
        type: 'tool_use',
        id: item.callId,
        name: item.name,
        input: parseArgs(item.arguments),
      });
    } else if (item.type === 'function_call_output') {
      push('user', { type: 'tool_result', tool_use_id: item.callId, content: item.output });
    }
    // Reasoning items aren't replayed: there is no signature to send back.
  }
  // The API needs the conversation to start with the user.
  while (messages[0]?.role === 'assistant') messages.shift();
  return { messages, extraSystem };
}

export interface AnthropicTurnParams {
  model: string;
  max_tokens: number;
  /** Automatic caching: the conversation so far is cached too, not only the instructions. */
  cache_control: { type: 'ephemeral' };
  system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  messages: Message[];
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  tool_choice?: { type: 'auto' | 'none' };
  output_config?: {
    effort?: 'low' | 'medium' | 'high';
    format?: { type: 'json_schema'; schema: Record<string, unknown> };
  };
}

/** The turn as Messages API parameters. Studio's long instructions are cached. */
export function toAnthropicParams(
  request: StudioTurnRequest,
  model: string,
  maxTokens = 4096,
): AnthropicTurnParams {
  const { messages: turns, extraSystem } = toAnthropicMessages(request.input);
  const messages: Message[] = turns;
  const system: AnthropicTurnParams['system'] = [];
  if (request.instructions?.trim()) {
    system.push({
      type: 'text',
      text: request.instructions,
      cache_control: { type: 'ephemeral' },
    });
  }
  for (const text of extraSystem) system.push({ type: 'text', text });

  const params: AnthropicTurnParams = {
    model,
    max_tokens: maxTokens,
    cache_control: { type: 'ephemeral' },
    system,
    messages,
  };
  const tools = (request.tools ?? [])
    .filter((t) => t.kind !== 'provided')
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters ?? { type: 'object', properties: {} },
    }));
  if (tools.length) {
    params.tools = tools;
    const choice = request.toolChoice;
    params.tool_choice = choice === 'none' ? { type: 'none' } : { type: 'auto' };
    // Current models refuse a forced tool_choice ("any" / "tool" is a 400), so a forced turn
    // (Studio forces complete_task when a sub-agent answers in text) becomes an instruction at
    // the end of the conversation, where it doesn't disturb the cached prefix.
    const forced =
      choice === 'required'
        ? 'Respond by calling one of the provided tools, not with text.'
        : choice && typeof choice === 'object' && tools.some((t) => t.name === choice.name)
          ? `Respond by calling the \`${choice.name}\` tool now, not with text.`
          : null;
    if (forced && messages.at(-1)?.role === 'user')
      messages.push({ role: 'system', content: forced });
  }
  params.output_config = { effort: 'low' };
  if (request.responseFormat?.type === 'json') {
    params.output_config.format = { type: 'json_schema', schema: request.responseFormat.schema };
  }
  return params;
}

interface OpenBlock {
  kind: 'text' | 'tool';
  id: string;
  name?: string;
  buffer: string;
}

/** Feed Claude's raw stream events in order; get Studio's events back. finish() → the response. */
export class ClaudeTurnTranslator {
  private readonly blocks = new Map<number, OpenBlock>();
  private readonly output: StudioOutputItem[] = [];
  private messageId = `msg_${Date.now().toString(36)}`;
  private model: string | undefined;
  private stopReason: string | null = null;
  private inputTokens = 0;
  private cachedTokens = 0;
  private outputTokens = 0;

  push(event: { type: string; [key: string]: unknown }): StudioEvent[] {
    const ev = event as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    switch (ev.type) {
      case 'message_start': {
        this.messageId = ev.message?.id ?? this.messageId;
        this.model = ev.message?.model;
        const usage = ev.message?.usage ?? {};
        this.inputTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        this.cachedTokens = usage.cache_read_input_tokens ?? 0;
        return [];
      }
      case 'content_block_start': {
        const block = ev.content_block ?? {};
        if (block.type === 'text') {
          const id = `${this.messageId}_${ev.index}`;
          this.blocks.set(ev.index, { kind: 'text', id, buffer: block.text ?? '' });
          const start: StudioEvent[] = [
            { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
          ];
          if (block.text)
            start.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: block.text });
          return start;
        }
        if (block.type === 'tool_use') {
          this.blocks.set(ev.index, { kind: 'tool', id: block.id, name: block.name, buffer: '' });
          return [
            {
              type: 'TOOL_CALL_START',
              toolCallId: block.id,
              toolCallName: block.name,
              parentMessageId: this.messageId,
            },
          ];
        }
        return [];
      }
      case 'content_block_delta': {
        const open = this.blocks.get(ev.index);
        if (!open) return [];
        if (ev.delta?.type === 'text_delta' && open.kind === 'text') {
          open.buffer += ev.delta.text;
          return [{ type: 'TEXT_MESSAGE_CONTENT', messageId: open.id, delta: ev.delta.text }];
        }
        if (ev.delta?.type === 'input_json_delta' && open.kind === 'tool') {
          const delta: string = ev.delta.partial_json ?? '';
          open.buffer += delta;
          return delta ? [{ type: 'TOOL_CALL_ARGS', toolCallId: open.id, delta }] : [];
        }
        return [];
      }
      case 'content_block_stop': {
        const open = this.blocks.get(ev.index);
        if (!open) return [];
        this.blocks.delete(ev.index);
        if (open.kind === 'text') {
          this.output.push({
            id: open.id,
            kind: 'output',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'text', text: open.buffer, annotations: [] }],
          });
          return [{ type: 'TEXT_MESSAGE_END', messageId: open.id }];
        }
        this.output.push({
          id: open.id,
          kind: 'output',
          type: 'function_call',
          callId: open.id,
          name: open.name!,
          arguments: open.buffer || '{}',
          status: 'completed',
        });
        return [{ type: 'TOOL_CALL_END', toolCallId: open.id }];
      }
      case 'message_delta':
        this.stopReason = ev.delta?.stop_reason ?? this.stopReason;
        this.outputTokens = ev.usage?.output_tokens ?? this.outputTokens;
        return [];
      default:
        return [];
    }
  }

  finish(error?: { code: string; message: string }): StudioTurnResponse {
    const base = {
      id: this.messageId,
      createdAt: Date.now(),
      output: this.output,
      usage: {
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        ...(this.cachedTokens ? { cachedInputTokens: this.cachedTokens } : {}),
      },
      ...(this.model ? { model: this.model } : {}),
    };
    if (error) return { ...base, status: 'failed', error };
    if (this.stopReason === 'refusal') {
      return {
        ...base,
        status: 'failed',
        error: { code: 'refusal', message: 'The model declined this request.' },
      };
    }
    if (this.stopReason === 'max_tokens') {
      return { ...base, status: 'incomplete', incompleteDetails: { reason: 'max_output_tokens' } };
    }
    return { ...base, status: 'completed' };
  }
}
