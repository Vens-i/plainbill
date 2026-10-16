/**
 * AG Studio's agent, connected to Claude through our API. Studio ships no model connection: each
 * turn it hands us a request (conversation, instructions, tool schemas) and reads streamed
 * events back. We POST the request to /api/studio/llm, which calls Claude and answers with
 * NDJSON lines: {"event": …} for each streamed event, then one {"response": …}. Studio runs
 * the tools itself, here in the browser, and sends their results back on the next turn.
 */
import type { AgAiEvent, AgLlmAdapter, AgLlmResponse } from 'ag-studio';

export function plainbillClaudeAdapter(endpoint = '/api/studio/llm'): AgLlmAdapter {
  return {
    executeTurn(request, options) {
      const queue: AgAiEvent[] = [];
      let wake: (() => void) | null = null;
      let done = false;
      let resolveComplete!: (r: AgLlmResponse) => void;
      const complete = new Promise<AgLlmResponse>((resolve) => (resolveComplete = resolve));
      const notify = () => {
        wake?.();
        wake = null;
      };
      const fail = (message: string, code = 'adapter_error') => {
        if (done) return;
        resolveComplete({
          id: 'error',
          createdAt: Date.now(),
          output: [],
          status: options?.signal?.aborted ? 'cancelled' : 'failed',
          error: { code, message },
        });
        done = true;
        notify();
      };

      void (async () => {
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
            signal: options?.signal,
          });
          if (!res.ok || !res.body) {
            const body = (await res.json().catch(() => null)) as { message?: string } | null;
            return fail(body?.message ?? `The analyst is unavailable (HTTP ${res.status}).`);
          }
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { value, done: ended } = await reader.read();
            if (ended) break;
            buffer += value;
            let newline: number;
            while ((newline = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (!line) continue;
              const message = JSON.parse(line) as { event?: AgAiEvent; response?: AgLlmResponse };
              if (message.event) {
                queue.push(message.event);
                notify();
              }
              if (message.response) {
                resolveComplete(message.response);
                done = true;
                notify();
              }
            }
          }
          fail('The analyst stopped before finishing.');
        } catch (err) {
          fail(options?.signal?.aborted ? 'Cancelled.' : String(err), 'network_error');
        }
      })();

      const stream = {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length) {
              yield queue.shift()!;
              continue;
            }
            if (done) return;
            await new Promise<void>((resolve) => (wake = resolve));
          }
        },
      };
      return { stream, complete };
    },
  };
}
