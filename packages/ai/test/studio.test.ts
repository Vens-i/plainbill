import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  ClaudeStudioRunner,
  ClaudeTurnTranslator,
  OfflineStudioRunner,
  toAnthropicParams,
  type StudioStreamLine,
  type StudioTurnRequest,
} from '../src';

const tools: StudioTurnRequest['tools'] = [
  {
    name: 'view_schema',
    description: 'See the data',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    kind: 'client',
  },
  {
    name: 'web_search',
    description: 'Provider tool',
    parameters: { type: 'object' },
    kind: 'provided',
    provider: { type: 'web_search' },
  },
];

const request = (over: Partial<StudioTurnRequest> = {}): StudioTurnRequest => ({
  instructions: 'You build dashboards.',
  input: [
    {
      kind: 'input',
      type: 'message',
      role: 'user',
      content: [{ type: 'text', text: 'Which payer denied the most?' }],
    },
  ],
  tools,
  responseFormat: { type: 'text' },
  ...over,
});

/** A scripted Claude turn: a tool call, then (on the next turn) text. */
const toolTurn = [
  {
    type: 'message_start',
    message: {
      id: 'msg_1',
      model: 'claude-test',
      usage: { input_tokens: 900, cache_read_input_tokens: 2800 },
    },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'view_schema', input: {} },
  },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '' } },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"table":' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '"denials"}' },
  },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 22 } },
  { type: 'message_stop' },
];

describe('toAnthropicParams', () => {
  it('caches Studio’s instructions, keeps client tools and maps the conversation', () => {
    const params = toAnthropicParams(
      request({
        input: [
          {
            kind: 'input',
            type: 'message',
            role: 'system',
            content: [{ type: 'text', text: 'Page: Practice insights' }],
          },
          ...request().input,
          {
            type: 'function_call',
            callId: 'toolu_1',
            name: 'view_schema',
            arguments: '{"table":"denials"}',
          },
          { type: 'function_call_output', callId: 'toolu_1', output: '{"success":true}' },
          { type: 'reasoning' },
        ],
      }),
      'claude-test',
    );
    expect(params.system).toEqual([
      { type: 'text', text: 'You build dashboards.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Page: Practice insights' },
    ]);
    expect(params.tools!.map((t) => t.name)).toEqual(['view_schema']);
    expect(params.tool_choice).toEqual({ type: 'auto' });
    expect(params.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Which payer denied the most?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'view_schema', input: { table: 'denials' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"success":true}' }],
      },
    ]);
  });

  it('never forces a tool (current models 400 on it): asks for the call in a system message', () => {
    // Studio forces complete_task when a sub-agent answers in text. Sonnet 5.5 / Opus 5.5
    // answer tool_choice "any" or "tool" with: 'tool_choice: type "tool" and "any" are not
    // supported for this model.'
    const required = toAnthropicParams(request({ toolChoice: 'required' }), 'm');
    expect(required.tool_choice).toEqual({ type: 'auto' });
    expect(required.messages.at(-1)).toEqual({
      role: 'system',
      content: 'Respond by calling one of the provided tools, not with text.',
    });
    const named = toAnthropicParams(request({ toolChoice: { name: 'view_schema' } }), 'm');
    expect(named.tool_choice).toEqual({ type: 'auto' });
    expect(named.messages.at(-1)).toEqual({
      role: 'system',
      content: 'Respond by calling the `view_schema` tool now, not with text.',
    });
    // The instruction comes after the conversation, so the cached prefix is unchanged.
    expect(named.messages.slice(0, -1)).toEqual(toAnthropicParams(request(), 'm').messages);
    // An unknown tool name or "auto" adds nothing; "none" maps through.
    expect(
      toAnthropicParams(request({ toolChoice: { name: 'nope' } }), 'm').messages.at(-1)!.role,
    ).toBe('user');
    expect(toAnthropicParams(request({ toolChoice: 'none' }), 'm').tool_choice).toEqual({
      type: 'none',
    });
  });

  it('caches the conversation as well as the instructions', () => {
    expect(toAnthropicParams(request(), 'm').cache_control).toEqual({ type: 'ephemeral' });
  });

  it('maps JSON output', () => {
    const schema = { type: 'object', properties: { title: { type: 'string' } } };
    expect(
      toAnthropicParams(request({ responseFormat: { type: 'json', name: 'plan', schema } }), 'm')
        .output_config,
    ).toEqual({ effort: 'low', format: { type: 'json_schema', schema } });
    expect(toAnthropicParams(request({ tools: [] }), 'm').tool_choice).toBeUndefined();
  });

  it('never starts the conversation with the assistant', () => {
    const params = toAnthropicParams(
      request({
        input: [
          {
            kind: 'output',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi!' }],
          },
          ...request().input,
        ],
      }),
      'm',
    );
    expect(params.messages[0]!.role).toBe('user');
  });
});

describe('ClaudeTurnTranslator', () => {
  it('turns a tool-use stream into Studio events and a function_call output', () => {
    const t = new ClaudeTurnTranslator();
    const events = toolTurn.flatMap((e) => t.push(e));
    expect(events).toEqual([
      {
        type: 'TOOL_CALL_START',
        toolCallId: 'toolu_1',
        toolCallName: 'view_schema',
        parentMessageId: 'msg_1',
      },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'toolu_1', delta: '{"table":' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'toolu_1', delta: '"denials"}' },
      { type: 'TOOL_CALL_END', toolCallId: 'toolu_1' },
    ]);
    const response = t.finish();
    expect(response).toMatchObject({
      id: 'msg_1',
      status: 'completed',
      model: 'claude-test',
      output: [
        {
          type: 'function_call',
          callId: 'toolu_1',
          name: 'view_schema',
          arguments: '{"table":"denials"}',
        },
      ],
      usage: { inputTokens: 900, outputTokens: 22, cachedInputTokens: 2800 },
    });
  });

  it('streams text', () => {
    const t = new ClaudeTurnTranslator();
    const events = [
      { type: 'message_start', message: { id: 'msg_2', usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'UHC ' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'denied the most.' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    ].flatMap((e) => t.push(e));
    expect(events.map((e) => e.type)).toEqual([
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
    ]);
    expect(t.finish().output).toEqual([
      expect.objectContaining({
        type: 'message',
        content: [{ type: 'text', text: 'UHC denied the most.', annotations: [] }],
      }),
    ]);
  });

  it('reports max_tokens as incomplete and refusals as failed', () => {
    const cut = new ClaudeTurnTranslator();
    cut.push({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } });
    expect(cut.finish()).toMatchObject({
      status: 'incomplete',
      incompleteDetails: { reason: 'max_output_tokens' },
    });
    const refused = new ClaudeTurnTranslator();
    refused.push({ type: 'message_delta', delta: { stop_reason: 'refusal' } });
    expect(refused.finish()).toMatchObject({ status: 'failed', error: { code: 'refusal' } });
  });
});

function fakeClient(script: Array<Record<string, unknown>> | Error) {
  const calls: unknown[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: unknown) => {
          calls.push(params);
          if (script instanceof Error) throw script;
          return (async function* () {
            for (const e of script) yield e;
          })();
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

async function collect(stream: AsyncIterable<StudioStreamLine>) {
  const lines: StudioStreamLine[] = [];
  for await (const line of stream) lines.push(line);
  return lines;
}

describe('ClaudeStudioRunner', () => {
  it('streams Studio events, then one response, from a streamed Claude call', async () => {
    const { client, calls } = fakeClient(toolTurn);
    const lines = await collect(
      new ClaudeStudioRunner({ client, model: 'claude-test' }).run(request()),
    );
    expect(lines.filter((l) => 'event' in l)).toHaveLength(4);
    expect(lines.at(-1)).toMatchObject({ response: { status: 'completed' } });
    expect(calls[0]).toMatchObject({
      model: 'claude-test',
      stream: true,
      tool_choice: { type: 'auto' },
    });
  });

  it('turns an API error into a failed response instead of throwing', async () => {
    const { client } = fakeClient(new Error('overloaded'));
    const lines = await collect(new ClaudeStudioRunner({ client, model: 'm' }).run(request()));
    expect(lines).toEqual([
      {
        response: expect.objectContaining({
          status: 'failed',
          error: { code: 'model_error', message: 'overloaded' },
        }),
      },
    ]);
  });
});

describe('OfflineStudioRunner', () => {
  it('explains that the analyst needs a key, as a normal assistant message', async () => {
    const lines = await collect(new OfflineStudioRunner().run());
    expect(lines.map((l) => ('event' in l ? l.event.type : 'response'))).toEqual([
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'response',
    ]);
    expect(JSON.stringify(lines)).toContain('ANTHROPIC_API_KEY');
  });
});
