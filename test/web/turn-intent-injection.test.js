// test/web/turn-intent-injection.test.js
import { describe, it, expect } from 'vitest';
import { deriveTurnIntent } from '../../web/stores/helpers/turn-intent.js';
import { appendTypingPlaceholders } from '../../web/stores/helpers/typing-placeholders.js';

// MessageList stamps `intent` onto every assistant-turn it produces. There
// are two code paths that produce assistant-turns:
//   1. The inline aggregator inside MessageList.turnGroups (handled by
//      finishTurn — see commit 38226e29).
//   2. appendTypingPlaceholders in typing-placeholders.js (handled by
//      hard-coding intent='quick' on the placeholder literal).
//
// This test pins both paths so a future refactor that drops `intent`
// from either site fails fast.
describe('turn-intent injection contract', () => {
  it('finishTurn-style: deriveTurnIntent stamps feature when preview matches', () => {
    const turn = { type: 'assistant-turn', speakerVpId: 'jobs', turnId: 't1' };
    const map = { 'jobs:t1': { intent: 'feature', preview: 'building auth...' } };
    expect(deriveTurnIntent(turn, map)).toBe('feature');
  });

  it('finishTurn-style: deriveTurnIntent leaves quick when preview missing', () => {
    const turn = { type: 'assistant-turn', speakerVpId: 'jobs', turnId: 't1' };
    expect(deriveTurnIntent(turn, {})).toBe('quick');
  });

  it('finishTurn-style: chat-mode turn (no VP attribution) stays quick', () => {
    const turn = { type: 'assistant-turn', speakerVpId: null, turnId: null };
    const map = { 'jobs:t1': { intent: 'feature' } };
    expect(deriveTurnIntent(turn, map)).toBe('quick');
  });

  it('typing-placeholder path: appendTypingPlaceholders stamps intent=quick', () => {
    const items = [];
    appendTypingPlaceholders(items, ['jobs'], {});
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('assistant-turn');
    expect(items[0].speakerVpId).toBe('jobs');
    expect(items[0].intent).toBe('quick');
  });

  it('typing-placeholder path: every synthesised placeholder carries intent', () => {
    const items = [];
    appendTypingPlaceholders(items, ['jobs', 'wozniak'], {});
    expect(items.length).toBe(2);
    for (const item of items) {
      expect(item.intent).toBe('quick');
    }
  });
});
