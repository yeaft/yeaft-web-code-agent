import { describe, expect, it } from 'vitest';
import { messageVpOwner, shouldCloseYeaftVpTurn } from '../../../web/stores/helpers/yeaft-turn-boundary.js';

function groupAssistantTurns(messages) {
  const turns = [];
  let currentTurn = null;
  const finishTurn = () => {
    if (currentTurn) turns.push(currentTurn);
    currentTurn = null;
  };
  const startTurn = () => {
    currentTurn = {
      speakerVpId: null,
      turnId: null,
      isHistory: false,
      messages: [],
      textContent: '',
    };
  };
  const latch = (msg) => {
    if (!currentTurn.speakerVpId && (msg.speakerVpId || msg.vpId)) {
      currentTurn.speakerVpId = msg.speakerVpId || msg.vpId;
    }
    if (!currentTurn.turnId && msg.turnId) currentTurn.turnId = msg.turnId;
    if (msg.isHistory) currentTurn.isHistory = true;
  };

  for (const msg of messages) {
    if (msg.type === 'user') {
      finishTurn();
      continue;
    }
    if (shouldCloseYeaftVpTurn(currentTurn, msg)) finishTurn();
    if (!currentTurn) startTurn();
    latch(msg);
    currentTurn.messages.push(msg);
    if (msg.type === 'assistant') currentTurn.textContent += msg.content || '';
  }
  finishTurn();
  return turns;
}

describe('Yeaft VP turn ownership boundaries', () => {
  it('splits refreshed VP blocks when owner differs even if turnId is shared', () => {
    const currentTurn = { speakerVpId: 'linus', turnId: 'turn-user-1' };

    expect(shouldCloseYeaftVpTurn(currentTurn, {
      type: 'assistant',
      speakerVpId: 'martin',
      turnId: 'turn-user-1',
    })).toBe(true);
  });

  it('keeps same-owner chunks together and still splits same speaker on different live delivery turnIds', () => {
    const currentTurn = { speakerVpId: 'linus', turnId: 'turn-linus-a' };

    expect(shouldCloseYeaftVpTurn(currentTurn, {
      type: 'assistant',
      speakerVpId: 'linus',
      turnId: 'turn-linus-a',
    })).toBe(false);

    expect(shouldCloseYeaftVpTurn(currentTurn, {
      type: 'assistant',
      speakerVpId: 'linus',
      turnId: 'turn-linus-b',
    })).toBe(true);
  });

  it('keeps same-owner history rows together even when partial retries used different runtime turnIds', () => {
    const currentTurn = { speakerVpId: 'omni', turnId: 'runtime-a', isHistory: true };

    expect(shouldCloseYeaftVpTurn(currentTurn, {
      type: 'assistant',
      speakerVpId: 'omni',
      turnId: 'runtime-b',
      isHistory: true,
    })).toBe(false);
  });

  it('groups one visible history reply block across same-speaker runtime turnId churn', () => {
    const turns = groupAssistantTurns([
      { type: 'user', content: 'make report' },
      { type: 'assistant', content: 'Running code quality. ', speakerVpId: 'omni', turnId: 'runtime-a', isHistory: true },
      { type: 'tool-summary', count: 2, speakerVpId: 'omni', turnId: 'runtime-a', isHistory: true },
      { type: 'assistant', content: 'Applying fix. ', speakerVpId: 'omni', turnId: 'runtime-b', isHistory: true },
      { type: 'tool-summary', count: 1, speakerVpId: 'omni', turnId: 'runtime-b', isHistory: true },
      { type: 'assistant', content: 'Done.', speakerVpId: 'omni', turnId: 'runtime-c', isHistory: true },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].textContent).toBe('Running code quality. Applying fix. Done.');
    expect(turns[0].messages.map(m => m.turnId)).toEqual(['runtime-a', 'runtime-a', 'runtime-b', 'runtime-b', 'runtime-c']);
  });

  it('still separates different visible history user turns', () => {
    const turns = groupAssistantTurns([
      { type: 'user', content: 'first' },
      { type: 'assistant', content: 'A', speakerVpId: 'omni', turnId: 'runtime-a', isHistory: true },
      { type: 'user', content: 'second' },
      { type: 'assistant', content: 'B', speakerVpId: 'omni', turnId: 'runtime-b', isHistory: true },
    ]);

    expect(turns).toHaveLength(2);
    expect(turns.map(t => t.textContent)).toEqual(['A', 'B']);
  });

  it('uses message-level speaker attribution before legacy vpId fallback', () => {
    expect(messageVpOwner({ speakerVpId: 'martin', vpId: 'linus' })).toBe('martin');
    expect(messageVpOwner({ vpId: 'linus' })).toBe('linus');
    expect(messageVpOwner({ speakerVpId: '   ', vpId: 'linus' })).toBe('linus');
  });

  it('does not let missing-owner history fallback overwrite explicit owners on later rows', () => {
    const currentTurn = { speakerVpId: '', turnId: 'turn-user-1' };

    expect(shouldCloseYeaftVpTurn(currentTurn, {
      type: 'assistant',
      speakerVpId: 'martin',
      turnId: 'turn-user-1',
    })).toBe(false);

    const martinTurn = { speakerVpId: 'martin', turnId: 'turn-user-1' };
    expect(shouldCloseYeaftVpTurn(martinTurn, {
      type: 'assistant',
      speakerVpId: 'linus',
      turnId: 'turn-user-1',
    })).toBe(true);
  });
});
