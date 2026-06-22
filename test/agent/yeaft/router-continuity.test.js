import { describe, expect, it } from 'vitest';
import { stripMetaForWire } from '../../../agent/yeaft/router/continuity.js';

describe('router continuity metadata', () => {
  it('strips engine-private metadata before provider wire payloads', () => {
    const clean = { role: 'user', content: 'hello' };
    const dirty = {
      role: 'assistant',
      content: 'tool result kept',
      toolCalls: [{ id: 'call_1', name: 'Glob', input: { pattern: '**/*.js' } }],
      _meta: { routerPlan: { vpId: 'vp-linus' } },
      _runtimeTurnId: 'turn_1',
      _partialTurn: true,
    };

    const messages = [clean, dirty];
    const out = stripMetaForWire(messages);

    expect(out).not.toBe(messages);
    expect(out[0]).toBe(clean);
    expect(out[1]).toEqual({
      role: 'assistant',
      content: 'tool result kept',
      toolCalls: [{ id: 'call_1', name: 'Glob', input: { pattern: '**/*.js' } }],
    });
    expect(out[1]._meta).toBeUndefined();
    expect(out[1]._runtimeTurnId).toBeUndefined();
    expect(out[1]._partialTurn).toBeUndefined();
  });

  it('returns the original array when there is no private metadata', () => {
    const messages = [{ role: 'user', content: 'plain' }];

    expect(stripMetaForWire(messages)).toBe(messages);
  });
});
