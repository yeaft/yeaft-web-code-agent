import { describe, it, expect } from 'vitest';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { buildMergedSkillSlashCommands, buildSkillSlashCommands } from '../../../agent/yeaft/web-bridge.js';

class RecordingAdapter {
  constructor() {
    this.calls = [];
  }

  async *stream(params) {
    this.calls.push(params);
    yield { type: 'text_delta', text: 'ok' };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
}

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

  it('merges global and project skill commands without duplicates', () => {
    const { commands, descriptions } = buildMergedSkillSlashCommands([
      { list: () => [{ name: 'review-code', description: 'Global review' }, { name: 'plan', description: 'Plan' }] },
      { list: () => [{ name: 'review-code', description: 'Project review' }, { name: 'ship', description: 'Ship' }, { name: '', description: 'bad' }] },
    ]);

    expect(commands).toEqual(['skill:plan', 'skill:review-code', 'skill:ship']);
    expect(descriptions['skill:review-code']).toBe('Project review');
  });

  it('injects an explicitly selected skill and strips the command before streaming', async () => {
    const adapter = new RecordingAdapter();
    const skillManager = {
      getPromptContent(name) {
        return name === 'review-code' ? '## Skill: review-code\n\nReview instructions' : '';
      },
      getRelevantPromptContent() {
        throw new Error('explicit skill command must not use relevance matching');
      },
    };
    const engine = new Engine({
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 1024, language: 'en' },
      skillManager,
    });

    const events = [];
    for await (const event of engine.query({ prompt: '/skill:review-code please review this' })) {
      events.push(event);
    }

    expect(events.some(event => event.type === 'turn_end')).toBe(true);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].system).toContain('## Skill: review-code');
    expect(adapter.calls[0].system).toContain('Review instructions');
    expect(adapter.calls[0].messages[0]).toMatchObject({
      role: 'user',
      content: 'please review this',
    });
  });

  it('reports unknown explicit skill commands in the system prompt', async () => {
    const adapter = new RecordingAdapter();
    const skillManager = {
      getPromptContent() { return ''; },
      getRelevantPromptContent() { return ''; },
    };
    const engine = new Engine({
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 1024, language: 'en' },
      skillManager,
    });

    for await (const _event of engine.query({ prompt: '/skill:missing do work' })) {
      // Drain stream.
    }

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].system).toContain('Requested skill "missing" was not found');
    expect(adapter.calls[0].messages[0].content).toBe('do work');
  });
});
