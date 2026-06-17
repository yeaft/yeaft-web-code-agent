import { describe, expect, it } from 'vitest';
import { messageVpOwner, shouldCloseYeaftVpTurn } from '../../../web/stores/helpers/yeaft-turn-boundary.js';

describe('Yeaft VP turn ownership boundaries', () => {
  it('splits refreshed VP blocks when owner differs even if turnId is shared', () => {
    const currentTurn = { speakerVpId: 'linus', turnId: 'turn-user-1' };

    expect(shouldCloseYeaftVpTurn(currentTurn, {
      type: 'assistant',
      speakerVpId: 'martin',
      turnId: 'turn-user-1',
    })).toBe(true);
  });

  it('keeps same-owner chunks together and still splits same speaker on different delivery turnIds', () => {
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
