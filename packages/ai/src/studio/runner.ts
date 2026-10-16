/**
 * Runs one AG Studio agent turn: Claude when a key is configured, or a short offline note
 * otherwise. Either way the caller gets Studio events followed by exactly one response, which
 * the API streams to the browser as NDJSON.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeTurnTranslator, toAnthropicParams } from './bridge';
import type { StudioStreamLine, StudioTurnRequest } from './protocol';

export interface StudioRunner {
  /** True when a live model answers. */
  readonly live: boolean;
  run(
    request: StudioTurnRequest,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<StudioStreamLine>;
}

export interface ClaudeStudioRunnerOptions {
  client: Anthropic;
  model: string;
  maxTokens?: number;
}

export class ClaudeStudioRunner implements StudioRunner {
  readonly live = true;
  constructor(private readonly options: ClaudeStudioRunnerOptions) {}

  async *run(
    request: StudioTurnRequest,
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<StudioStreamLine> {
    const translator = new ClaudeTurnTranslator();
    const params = toAnthropicParams(request, this.options.model, this.options.maxTokens);
    try {
      const stream = (await this.options.client.beta.messages.create(
        {
          ...params,
          stream: true,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        } as unknown as Anthropic.Beta.MessageCreateParamsStreaming,
        options.signal ? { signal: options.signal } : undefined,
      )) as AsyncIterable<{ type: string; [key: string]: unknown }>;
      for await (const event of stream) {
        for (const out of translator.push(event)) yield { event: out };
      }
      yield { response: translator.finish() };
    } catch (err) {
      const aborted = options.signal?.aborted;
      yield {
        response: translator.finish({
          code: aborted ? 'cancelled' : 'model_error',
          message: aborted ? 'Cancelled.' : (err as Error).message || 'The model call failed.',
        }),
      };
    }
  }
}

/** Without ANTHROPIC_API_KEY: the report still works; the chat says why the agent can't. */
export class OfflineStudioRunner implements StudioRunner {
  readonly live = false;

  async *run(): AsyncIterable<StudioStreamLine> {
    const messageId = `offline_${Date.now().toString(36)}`;
    const text =
      'The AI analyst needs a Claude API key (ANTHROPIC_API_KEY) on the server. Everything else on this page works without it: the charts, the filters and the Still owed scoreboard.';
    yield { event: { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' } };
    yield { event: { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text } };
    yield { event: { type: 'TEXT_MESSAGE_END', messageId } };
    yield {
      response: {
        id: messageId,
        createdAt: Date.now(),
        status: 'completed',
        output: [
          {
            id: messageId,
            kind: 'output',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'text', text, annotations: [] }],
          },
        ],
      },
    };
  }
}
