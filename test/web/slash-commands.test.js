import { describe, it, expect } from 'vitest';
import { getCommandDescription, getCommandGroup } from '../../web/utils/slash-commands.js';

describe('slash command utilities', () => {
  it('groups Yeaft-native skill commands as skills', () => {
    expect(getCommandGroup('/skill:review-code')).toBe('skill');
  });

  it('uses dynamic descriptions for Yeaft-native skill commands', () => {
    expect(getCommandDescription('/skill:review-code', {
      'skill:review-code': 'Review code with Yeaft skill',
    })).toBe('Review code with Yeaft skill');
  });
});
