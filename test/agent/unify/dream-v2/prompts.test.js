import { describe, it, expect } from 'vitest';
import { render, _resetCache } from '../../../../agent/unify/dream-v2/prompts/index.js';

describe('dream-v2 prompts loader', () => {
  it('renders triagePass1 with substituted vars', () => {
    _resetCache();
    const out = render('triagePass1', {
      groupId: 'g-eng',
      topicSummaries: '  - topic/a — x',
      conversation: '[user]\nhi',
    });
    expect(out).toContain('Group: g-eng');
    expect(out).toContain('  - topic/a — x');
    expect(out).toContain('[user]\nhi');
  });

  it('throws on missing template var', () => {
    expect(() => render('triagePass1', { groupId: 'g' })).toThrow(/missing var/);
  });

  it('throws on unknown template name', () => {
    expect(() => render('does-not-exist', {})).toThrow(/unknown template/);
  });

  it('renders update with batchHeader empty when single batch', () => {
    const out = render('update', {
      target: 'user',
      batchHeader: '',
      memoryMd: 'old',
      summaryMd: 'sum',
      sources: '[group/g-eng]',
    });
    expect(out).toContain('Scope: user');
    expect(out).not.toContain('This is batch');
    expect(out).toContain('"""\nold\n"""');
  });

  it('renders create with optional siblingsBlock', () => {
    const out = render('create', {
      target: 'topic/sci/phys',
      sources: '[group/g]',
      siblingsBlock: '',
    });
    expect(out).toContain('topic/sci/phys');
    expect(out).not.toContain('sibling/parent');
  });
});
