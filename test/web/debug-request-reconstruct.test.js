import { describe, expect, it } from 'vitest';

const { applyDebugRawRequestDelta, reconstructDebugRawRequest } = await import('../../web/components/yeaft-debug-helpers.js');

describe('debug raw request reconstruction', () => {
  it('reconstructs full request bodies from append-only message deltas', () => {
    const first = reconstructDebugRawRequest(null, {
      rawRequestDelta: {
        base: {
          method: 'POST',
          url: 'https://llm.example/v1/responses',
          body: {
            model: 'm',
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
            stream: true,
          },
        },
      },
    });

    const secondDelta = {
      rawRequestDelta: {
        body: {
          messagesFrom: 1,
          messagesAppend: [
            { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"command":"pwd"}' },
            { type: 'function_call_output', call_id: 'call_1', output: '/tmp/project' },
          ],
        },
      },
    };
    const second = reconstructDebugRawRequest(first, secondDelta);
    const secondFromUiLoopShape = reconstructDebugRawRequest(first, secondDelta);

    expect(second).toMatchObject({ method: 'POST', url: 'https://llm.example/v1/responses' });
    expect(second.body.model).toBe('m');
    expect(second.body.stream).toBe(true);
    expect(second.body.input).toHaveLength(3);
    expect(second.body.input[2]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
    expect(secondFromUiLoopShape).toEqual(second);
  });

  it('applies appended messages to Responses input arrays', () => {
    const base = {
      body: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      },
    };

    const next = applyDebugRawRequestDelta(base, {
      body: {
        messagesFrom: 1,
        messagesAppend: [{ type: 'function_call_output', call_id: 'call_1', output: 'ok' }],
      },
    });

    expect(next.body.input).toHaveLength(2);
    expect(next.body.input[1]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
  });
});
