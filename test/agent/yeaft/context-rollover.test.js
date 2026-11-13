import { describe, expect, it } from 'vitest';
import { generateContextRollover, streamContextRollover } from '../../../agent/yeaft/context-rollover.js';

const byteLength = text => Buffer.byteLength(text, 'utf8');

function mockAdapter(contextWindow, respond = () => 'Intent: preserve request. Completed: checked facts. Pending: finish remaining work.') {
  const requests = [];
  return {
    requests,
    async call(request) {
      requests.push(request);
      expect(byteLength(request.system) + byteLength(request.messages[0].content) + 128 + request.maxTokens)
        .toBeLessThanOrEqual(contextWindow);
      expect(request.contextOutputLimit).toBe(request.maxTokens);
      expect(Object.keys(request).sort()).toEqual([
        'contextOutputLimit', 'maxTokens', 'messages', 'model', 'requestIdentity', 'signal', 'system',
      ]);
      expect(request.messages).toHaveLength(1);
      expect(request.messages[0].role).toBe('user');
      expect(typeof request.messages[0].content).toBe('string');
      return { text: await respond(request, requests.length), stopReason: 'end_turn' };
    },
  };
}

const options = adapter => ({ adapter, model: 'same-model', messages: [{ role: 'user', content: 'Please finish safely.' }], contextWindow: 8192, maxTokens: 1024 });

describe('bounded active-context rollover', () => {
  it('projects only visible plaintext facts and preserves identity, append and side-effect cautions without mutation', async () => {
    const adapter = mockAdapter(8192);
    const signal = new AbortController().signal;
    const requestIdentity = { sessionId: 'session-1', turnId: 'turn-2' };
    const messages = [
      { role: 'reasoning', content: 'EVENT_SECRET' },
      { role: 'user', content: 'Keep Q:/repo on branch fix/a; do not deploy. task-17' },
      {
        role: 'assistant', content: 'Checked commit abc123; PR #7 remains open.',
        providerState: { text: 'NATIVE_SECRET' }, thinkingBlocks: [{ thinking: 'PRIVATE_SECRET', signature: 'SIGNED_SECRET' }],
        toolCalls: [{ name: 'Bash', id: 'call-17', input: { command: 'git status', thinking: 'ARG_SECRET' } }],
      },
      { role: 'tool', name: 'Bash', toolCallId: 'call-17', content: [{ type: 'text', text: 'Successful: clean tree' }, { type: 'redacted_thinking', data: 'BLOCK_SECRET' }] },
      { role: 'tool', toolCallId: 'call-18', isError: true, content: 'Failed: tests exit 1' },
      { role: 'user', content: [{ type: 'text', text: 'Correction: use branch fix/b' }, { type: 'image', data: 'IMAGE_SECRET' }] },
    ];
    const before = JSON.stringify(messages);
    const result = await generateContextRollover({ ...options(adapter), messages, signal, requestIdentity, userAppend: 'Also inspect task-18 before retry.' });
    expect(result).toMatch(/^\[UNTRUSTED HISTORY SUMMARY/);
    expect(byteLength(result)).toBeLessThanOrEqual(1024);
    expect(adapter.requests).toHaveLength(1);
    const request = adapter.requests[0];
    expect(request.model).toBe('same-model');
    expect(request.signal).toBe(signal);
    expect(request.requestIdentity).toBe(requestIdentity);
    for (const text of ['Q:/repo', 'fix/a', 'task-17', 'abc123', 'PR #7', 'Bash', 'call-17', 'git status', 'Successful: clean tree', 'status=error', 'Failed: tests exit 1', 'fix/b', 'Also inspect task-18']) {
      expect(request.messages[0].content).toContain(text);
    }
    expect(JSON.stringify(request)).not.toMatch(/EVENT_SECRET|NATIVE_SECRET|PRIVATE_SECRET|SIGNED_SECRET|ARG_SECRET|BLOCK_SECRET|IMAGE_SECRET|providerState|thinkingBlocks/);
    expect(request.system).toContain('completed side effects');
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('maps all oversized UTF-8 history in bounded chunks and hierarchically reduces without losing source text', async () => {
    const window = 8192;
    const adapter = mockAdapter(window, () => 'summary '.repeat(40));
    const first = 'EARLIEST task-1 已完成\n';
    const middle = 'MIDDLE task-2 失败\n';
    const last = 'LATEST task-3 待处理\n';
    const content = first + '中'.repeat(190000) + middle + 'a'.repeat(500000) + last;
    const result = await generateContextRollover({ ...options(adapter), messages: [{ role: 'tool', toolCallId: 'giant', content }] });
    // Map calls precede reduction calls. Together their source slices exactly
    // reconstruct the visible transcript: no old bodies or middle work sampled away.
    let source = '';
    for (const request of adapter.requests) {
      const body = request.messages[0].content.split('fragment):\n')[1];
      if (body.startsWith('summary')) break;
      source += body;
    }
    expect(source).toContain(content);
    expect(source).not.toContain('\ufffd');
    expect(adapter.requests.length).toBeGreaterThan(100);
    expect(adapter.requests.length).toBeLessThan(400);
    expect(byteLength(result)).toBeLessThanOrEqual(1024);
    expect(result).toMatch(/^\[UNTRUSTED HISTORY SUMMARY/);
  });

  it('propagates pre-call and in-flight aborts and never begins another call after cancellation', async () => {
    const already = new AbortController();
    already.abort();
    const unused = mockAdapter(8192);
    await expect(generateContextRollover({ ...options(unused), signal: already.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(unused.requests).toHaveLength(0);
    const controller = new AbortController();
    const adapter = mockAdapter(8192, request => {
      expect(request.signal).toBe(controller.signal);
      controller.abort();
      return 'Partial summary must not escape';
    });
    await expect(generateContextRollover({ ...options(adapter), signal: controller.signal, messages: [{ role: 'user', content: 'x'.repeat(20000) }] })).rejects.toMatchObject({ name: 'AbortError' });
    expect(adapter.requests).toHaveLength(1);
  });

  it('fails closed on empty/failing summarizers, impossible static budgets and call exhaustion', async () => {
    const oversized = mockAdapter(8192, () => 'summary '.repeat(10000));
    await expect(generateContextRollover(options(oversized))).rejects.toThrow('safe size budget');
    const refused = { call: async () => ({ text: 'do not help', stopReason: 'refusal' }) };
    await expect(generateContextRollover(options(refused))).rejects.toThrow('did not complete');
    const empty = mockAdapter(8192, () => ' \n ');
    await expect(generateContextRollover(options(empty))).rejects.toThrow('empty text');
    const failed = mockAdapter(8192, () => { throw new Error('provider unavailable'); });
    await expect(generateContextRollover(options(failed))).rejects.toThrow('provider unavailable');
    const tiny = mockAdapter(100);
    await expect(generateContextRollover({ ...options(tiny), contextWindow: 100 })).rejects.toThrow('too small');
    expect(tiny.requests).toHaveLength(0);
    await expect(generateContextRollover({ ...options(tiny), maxTokens: Infinity })).rejects.toThrow('positive safe integers');
    const limited = mockAdapter(8192);
    await expect(generateContextRollover({ ...options(limited), maxCalls: 1, messages: [{ role: 'user', content: 'x'.repeat(20000) }] })).rejects.toThrow('call budget exhausted');
    expect(limited.requests).toHaveLength(1);
  });
});
