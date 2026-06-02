import { describe, it, expect } from 'vitest';
import {
  render, _resetCache, extractTemplateForScope,
} from '../../../../agent/yeaft/dream-v2/prompts/index.js';
import { buildPass1Prompt } from '../../../../agent/yeaft/dream-v2/triage.js';
import { buildUpdatePrompt, buildCreatePrompt } from '../../../../agent/yeaft/dream-v2/apply.js';

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

  it('adds Chinese language instruction for zh dream prompts without renaming JSON keys', () => {
    const out = render('update', {
      target: 'user',
      batchHeader: '',
      memoryMd: 'old',
      summaryMd: 'sum',
      sources: '[group/g-eng]',
    }, { language: 'zh' });
    expect(out).toContain('语言要求：请用中文生成所有自然语言内容');
    expect(out).toContain('JSON key');
    expect(out).toContain('memory_md');
    expect(out).toContain('summary_md');
  });

  it('keeps English language instruction for en dream prompts', () => {
    const out = render('update', {
      target: 'user',
      batchHeader: '',
      memoryMd: 'old',
      summaryMd: 'sum',
      sources: '[group/g-eng]',
    }, { language: 'en' });
    expect(out).toContain('Language requirement: write all natural-language memory content in English');
    expect(out).toContain('memory_md');
    expect(out).not.toContain('语言要求');
  });

  it('builds zh triage prompts with Chinese visible instructions and English protocol keys', () => {
    const out = buildPass1Prompt({
      language: 'zh',
      groupId: 'g-eng',
      topicSummaries: [],
      messages: [{ role: 'user', kind: 'overlap', body: '你好' }],
    });
    expect(out).toContain('语言要求：请用中文生成所有自然语言内容');
    expect(out).toContain('（无）');
    expect(out).toContain('已处理');
    expect(out).toContain('user_profile_signals');
    expect(out).toContain('trivial_only');
  });

  it('builds zh apply prompts but keeps JSON keys unchanged', () => {
    const update = buildUpdatePrompt({
      language: 'zh',
      target: 'user',
      memoryMd: '旧记忆',
      summaryMd: '摘要',
      sources: [{ groupId: 'g', diff: [{ role: 'user', kind: 'overlap', body: '新的事实' }] }],
      batchInfo: { index: 1, total: 2 },
    });
    expect(update).toContain('这是第 1/2 批');
    expect(update).toContain('语言要求：请用中文生成所有自然语言内容');
    expect(update).toContain('memory_md');
    expect(update).toContain('summary_md');
    expect(update).toContain('已处理');

    const create = buildCreatePrompt({
      language: 'zh',
      target: 'topic/auth/jwt',
      sources: [{ groupId: 'g', diff: [{ role: 'user', body: 'JWT 讨论' }] }],
      siblingTopics: [{ path: 'auth/oauth', summary: 'OAuth notes' }],
    });
    expect(create).toContain('语气参考');
    expect(create).toContain('memory_md');
    expect(create).toContain('summary_md');
  });

});

describe('dream-v2 per-scope extract prompts (H2.e)', () => {
  it('extractUser mentions user-scope categories', () => {
    _resetCache();
    const out = render('extractUser', {});
    expect(out).toContain('user');
    expect(out).toMatch(/identity|preferences|habits|goals/i);
    expect(out).toContain('JSON');
  });

  it('extractVp substitutes vpId', () => {
    const out = render('extractVp', { vpId: 'alice' });
    expect(out).toContain('alice');
    expect(out).toMatch(/persona|voice|expertise|interaction/i);
  });

  it('extractGroup substitutes groupId', () => {
    const out = render('extractGroup', { groupId: 'g-eng' });
    expect(out).toContain('g-eng');
    expect(out).toMatch(/purpose|members|conventions/i);
  });

  it('extractTopic substitutes topicId', () => {
    const out = render('extractTopic', { topicId: 'auth/jwt' });
    expect(out).toContain('auth/jwt');
    expect(out).toMatch(/viewpoints|patterns|lessons/i);
  });

  it('summarizeScope substitutes scope/segments/budget', () => {
    const out = render('summarizeScope', {
      scope: 'user',
      segmentCount: '3',
      tokenBudget: '500',
      segments: '- seg_aaa: prefers zsh',
    });
    expect(out).toContain('user');
    expect(out).toContain('500');
    expect(out).toContain('seg_aaa');
  });
});

describe('extractTemplateForScope', () => {
  it('routes user scope', () => {
    expect(extractTemplateForScope('user')).toBe('extractUser');
  });
  it('routes vp/* scope', () => {
    expect(extractTemplateForScope('vp/alice')).toBe('extractVp');
  });
  it('routes group/* scope', () => {
    expect(extractTemplateForScope('group/eng')).toBe('extractGroup');
  });
  it('routes feature/* scope falls back to extractTopic (Feature system removed)', () => {
    expect(extractTemplateForScope('feature/memory-h2')).toBe('extractTopic');
  });
  it('routes topic/* scope', () => {
    expect(extractTemplateForScope('topic/auth/jwt')).toBe('extractTopic');
  });
  it('falls back to extractTopic for unknown scope', () => {
    expect(extractTemplateForScope('weird')).toBe('extractTopic');
    expect(extractTemplateForScope('')).toBe('extractTopic');
    expect(extractTemplateForScope(null)).toBe('extractTopic');
  });
});
