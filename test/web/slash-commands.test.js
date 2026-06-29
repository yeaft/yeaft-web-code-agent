import { describe, it, expect } from 'vitest';
import { buildGroupedCommands, getCommandDescription, getCommandGroup, resolveDynamicSlashCommands } from '../../web/utils/slash-commands.js';

describe('slash command utilities', () => {
  it('groups Yeaft skill commands as skills', () => {
    expect(getCommandGroup('/review-code', { 'review-code': 'Review code with Yeaft skill' }, new Set(['review-code']))).toBe('skill');
    expect(getCommandGroup('/yeaft-skills:review-code')).toBe('skill');
    expect(getCommandGroup('/skill:review-code')).toBe('skill');
    expect(getCommandGroup('/project-review')).toBe('project');
  });

  it('uses dynamic descriptions for Yeaft skill commands', () => {
    expect(getCommandDescription('/review-code', {
      'review-code': 'Review code with Yeaft skill',
    })).toBe('Review code with Yeaft skill');
    expect(getCommandDescription('/yeaft-skills:review-code', {
      'yeaft-skills:review-code': 'Review code with Yeaft skill',
    })).toBe('Review code with Yeaft skill');
    expect(getCommandDescription('/skill:review-code', {
      'skill:review-code': 'Review code with Yeaft skill',
    })).toBe('Review code with Yeaft skill');
  });

  it('keeps bare Yeaft skills in the Skills autocomplete group', () => {
    const groups = buildGroupedCommands([
      { cmd: '/review-code', desc: 'Review code with Yeaft skill' },
      { cmd: '/update-config', desc: 'Update config' },
      { cmd: '/compact', desc: 'Compact context' },
    ], { 'review-code': 'Review code with Yeaft skill' }, ['/review-code']);

    expect(groups.map(g => [g.label, g.items.map(i => i.cmd)])).toEqual([
      ['Skills', ['/review-code']],
      ['Commands', ['/update-config']],
      ['Built-in', ['/compact']],
    ]);
  });

  it('does not classify stale bare descriptions as visible skills', () => {
    const groups = buildGroupedCommands([
      { cmd: '/review-code', desc: 'Review code with Yeaft skill' },
    ], { 'review-code': 'Review code with Yeaft skill' }, []);

    expect(groups.map(g => [g.label, g.items.map(i => i.cmd)])).toEqual([
      ['Commands', ['/review-code']],
    ]);
  });

  it('merges conversation, agent, and preload dynamic command sources', () => {
    const store = {
      slashCommandsMap: {
        'conv-1': ['project-review'],
        'agent:agent-1': ['code-review', 'project-review'],
        __preload__: ['sprint'],
      },
    };

    expect(resolveDynamicSlashCommands(store, 'conv-1', 'agent-1')).toEqual([
      'project-review',
      'code-review',
      'sprint',
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
