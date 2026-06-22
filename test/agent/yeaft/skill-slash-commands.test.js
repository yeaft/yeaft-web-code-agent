import { describe, it, expect } from 'vitest';
import { buildSkillSlashCommands } from '../../../agent/yeaft/web-bridge.js';

describe('Yeaft skill slash commands', () => {
  it('builds slash commands from loaded skill metadata', () => {
    const { commands, descriptions } = buildSkillSlashCommands({
      list: () => [
        { name: 'review-code', description: 'Review code' },
        { name: 'sprint', trigger: 'plan work' },
        { name: '', description: 'bad' },
      ],
    });

    expect(commands).toEqual(['skill:review-code', 'skill:sprint']);
    expect(descriptions).toEqual({
      'skill:review-code': 'Review code',
      'skill:sprint': 'plan work',
    });
  });
});
