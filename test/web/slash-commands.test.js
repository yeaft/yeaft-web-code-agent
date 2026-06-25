import { describe, it, expect } from 'vitest';
import { getCommandDescription, getCommandGroup, resolveDynamicSlashCommands } from '../../web/utils/slash-commands.js';

describe('slash command utilities', () => {
  it('groups Yeaft skill commands as skills', () => {
    expect(getCommandGroup('/yeaft-skills:review-code')).toBe('skill');
    expect(getCommandGroup('/skill:review-code')).toBe('skill');
  });

  it('uses dynamic descriptions for Yeaft skill commands', () => {
    expect(getCommandDescription('/yeaft-skills:review-code', {
      'yeaft-skills:review-code': 'Review code with Yeaft skill',
    })).toBe('Review code with Yeaft skill');
    expect(getCommandDescription('/skill:review-code', {
      'skill:review-code': 'Review code with Yeaft skill',
    })).toBe('Review code with Yeaft skill');
  });

  it('merges conversation, agent, and preload dynamic command sources', () => {
    const store = {
      slashCommandsMap: {
        'conv-1': ['yeaft-skills:project-review'],
        'agent:agent-1': ['yeaft-skills:code-review', 'yeaft-skills:project-review'],
        __preload__: ['yeaft-skills:sprint'],
      },
    };

    expect(resolveDynamicSlashCommands(store, 'conv-1', 'agent-1')).toEqual([
      'yeaft-skills:project-review',
      'yeaft-skills:code-review',
      'yeaft-skills:sprint',
    ]);
  });

  it('keeps agent and preload skills visible when the Yeaft conversation list is still empty', () => {
    const store = {
      slashCommandsMap: {
        'conv-1': [],
        'agent:agent-1': ['yeaft-skills:user-skill'],
        __preload__: ['yeaft-skills:bundled-skill'],
      },
    };

    expect(resolveDynamicSlashCommands(store, 'conv-1', 'agent-1')).toEqual([
      'yeaft-skills:user-skill',
      'yeaft-skills:bundled-skill',
    ]);
  });
});
