// test/web/turn-intent-injection.test.js
import { describe, it, expect } from 'vitest';
import { deriveTurnIntent } from '../../web/stores/helpers/turn-intent.js';

// This test pins the contract that MessageList.turnGroups will use to stamp
// `intent` onto every assistant-turn it builds. It does not mount Vue.
// When MessageList is later refactored to delegate turn building to a pure
// helper (`web/stores/helpers/turn-groups.js` already exists for the typing-
// placeholder rule), this test should be promoted to call that helper and
// assert the field is present on every output assistant-turn.
describe('turn-intent injection contract', () => {
  it('stamps feature intent on a turn whose vpId:turnId matches a feature preview', () => {
    const turn = { type: 'assistant-turn', speakerVpId: 'jobs', turnId: 't1' };
    const map = { 'jobs:t1': { intent: 'feature', preview: 'building auth...' } };
    expect(deriveTurnIntent(turn, map)).toBe('feature');
  });

  it('leaves intent at quick for a turn with no matching preview (Track-A pending/failed)', () => {
    const turn = { type: 'assistant-turn', speakerVpId: 'jobs', turnId: 't1' };
    expect(deriveTurnIntent(turn, {})).toBe('quick');
  });

  it('leaves intent at quick for chat-mode turns without VP attribution', () => {
    const turn = { type: 'assistant-turn', speakerVpId: null, turnId: null };
    const map = { 'jobs:t1': { intent: 'feature' } };
    expect(deriveTurnIntent(turn, map)).toBe('quick');
  });
});
