import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, SUPPORTED_LANGUAGES } from '../../../agent/unify/prompts.js';

describe('SUPPORTED_LANGUAGES', () => {
  it('should include en and zh', () => {
    expect(SUPPORTED_LANGUAGES).toContain('en');
    expect(SUPPORTED_LANGUAGES).toContain('zh');
  });
});

describe('buildSystemPrompt', () => {
  // ─── English prompts (task-297: single unified mode) ──────────

  it('should build English prompt by default', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Yeaft');
    // task-297: mode line was removed from the prompt
    expect(prompt).not.toContain('Current mode:');
    expect(prompt).toContain('Date:');
  });

  it('should build English prompt when language is en', () => {
    const prompt = buildSystemPrompt({ language: 'en' });
    expect(prompt).toContain('Yeaft');
    // Unified mode content appears for every non-dream call
    expect(prompt).toContain('Unified Mode');
  });

  it('should include unified mode instructions in English', () => {
    const prompt = buildSystemPrompt({ language: 'en' });
    // task-297: unified-mode template replaces chat/work split
    expect(prompt).toContain('Unified Mode');
    expect(prompt).toContain('continuous AI companion');
  });

  it('should include dream mode instruction in English', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'dream' });
    expect(prompt).toContain('Dream Mode');
    expect(prompt.toLowerCase()).toContain('merge');
  });

  it('should include tool names in English', () => {
    const prompt = buildSystemPrompt({
      language: 'en',
      toolNames: ['read_file', 'write_file'],
    });
    expect(prompt).toContain('Available tools: read_file, write_file');
  });

  it('should not include tool section when no tools', () => {
    const prompt = buildSystemPrompt({ language: 'en', toolNames: [] });
    expect(prompt).not.toContain('Available tools');
    expect(prompt).not.toContain('可用工具');
  });

  // ─── Chinese prompts ──────────────────────────────────────────

  it('should build Chinese prompt when language is zh', () => {
    const prompt = buildSystemPrompt({ language: 'zh' });
    expect(prompt).toContain('Yeaft');
    expect(prompt).not.toContain('当前模式：');
    expect(prompt).toContain('日期：');
  });

  it('should include unified mode instruction in Chinese', () => {
    const prompt = buildSystemPrompt({ language: 'zh' });
    expect(prompt).toContain('统一模式');
    expect(prompt).toContain('持续伴随');
  });

  it('should include dream mode instruction in Chinese', () => {
    const prompt = buildSystemPrompt({ language: 'zh', mode: 'dream' });
    expect(prompt).toContain('梦境模式');
    expect(prompt).toContain('合并');
  });

  it('should include tool names in Chinese', () => {
    const prompt = buildSystemPrompt({
      language: 'zh',
      toolNames: ['read_file', 'write_file'],
    });
    expect(prompt).toContain('可用工具：read_file, write_file');
  });

  // ─── Fallback behavior ────────────────────────────────────────

  it('should fallback to English for unknown language', () => {
    const prompt = buildSystemPrompt({ language: 'fr' });
    expect(prompt).toContain('Yeaft');
    expect(prompt).not.toContain('核心原则');
  });

  it('should fallback to English for null language', () => {
    const prompt = buildSystemPrompt({ language: null });
    expect(prompt).toContain('Yeaft');
  });

  it('should fallback to English for undefined language', () => {
    const prompt = buildSystemPrompt({ language: undefined });
    expect(prompt).toContain('Yeaft');
  });

  // ─── Edge cases ───────────────────────────────────────────────

  it('should not include dream mode instructions in unified mode', () => {
    const prompt = buildSystemPrompt({ language: 'en' });
    expect(prompt).not.toContain('Dream Mode');
  });

  it('should not include the old chat/worker mode templates (task-297)', () => {
    const prompt = buildSystemPrompt({ language: 'en' });
    // These files were deleted and must not be referenced.
    expect(prompt).not.toContain('Worker Mode');
    expect(prompt).not.toContain('Chat Mode');
  });

  it('should include today date', () => {
    const prompt = buildSystemPrompt({ language: 'en' });
    const today = new Date().toISOString().split('T')[0];
    expect(prompt).toContain(today);
  });

  it('should separate sections with double newline', () => {
    const prompt = buildSystemPrompt({ language: 'en' });
    const parts = prompt.split('\n\n');
    expect(parts.length).toBeGreaterThanOrEqual(3);
  });

  // ─── Memory injection ─────────────────────────────────────────

  it('should include user profile in memory section', () => {
    const prompt = buildSystemPrompt({
      language: 'en',
      memory: { profile: 'Senior TypeScript developer. Prefers dark mode.' },
    });
    expect(prompt).toContain('## User Memory');
    expect(prompt).toContain('### User Profile');
    expect(prompt).toContain('Senior TypeScript developer');
  });

  it('should include recalled memory entries', () => {
    const prompt = buildSystemPrompt({
      language: 'en',
      memory: {
        entries: [
          { name: 'ts-generics', kind: 'skill', tags: ['typescript'], content: 'TS generics patterns' },
          { name: 'auth-bug', kind: 'lesson', tags: ['auth', 'bugfix'], content: 'Auth null check fix' },
        ],
      },
    });
    expect(prompt).toContain('### Recalled Memories');
    expect(prompt).toContain('ts-generics');
    expect(prompt).toContain('auth-bug');
    expect(prompt).toContain('TS generics patterns');
  });

  it('should include compact summary', () => {
    const prompt = buildSystemPrompt({
      language: 'en',
      compactSummary: 'User discussed TypeScript patterns and auth module bugs.',
    });
    expect(prompt).toContain('## Conversation History Summary');
    expect(prompt).toContain('User discussed TypeScript patterns');
  });

  it('should include memory section in Chinese', () => {
    const prompt = buildSystemPrompt({
      language: 'zh',
      memory: { profile: '高级 TypeScript 开发者' },
    });
    expect(prompt).toContain('## 用户记忆');
    expect(prompt).toContain('### 用户画像');
    expect(prompt).toContain('高级 TypeScript 开发者');
  });

  it('should not include memory section when no memory', () => {
    const prompt = buildSystemPrompt({ language: 'en' });
    expect(prompt).not.toContain('## User Memory');
    expect(prompt).not.toContain('## Conversation History Summary');
  });

  it('should not include memory section when memory is empty', () => {
    const prompt = buildSystemPrompt({
      language: 'en',
      memory: { profile: '', entries: [] },
    });
    expect(prompt).not.toContain('## User Memory');
  });

  // ─── Template-specific tests ──────────────────────────────────

  it('should include rich identity from base.md template', () => {
    const prompt = buildSystemPrompt({ language: 'en' });
    expect(prompt).toContain('Core Principles');
    expect(prompt).toContain('Output Format');
    expect(prompt).toContain('Code Editing Rules');
  });

  it('should include dream mode instructions from mode-dream.md template', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'dream' });
    expect(prompt).toContain('Dream Mode');
    expect(prompt).toContain('Consolidation Priority');
  });

  it('should include tool guidance when tools are provided', () => {
    const prompt = buildSystemPrompt({
      language: 'en',
      toolNames: ['Bash', 'FileRead'],
    });
    expect(prompt).toContain('Tool Usage Guidance');
    expect(prompt).toContain('Error Handling');
  });

  it('should not include tool guidance when no tools', () => {
    const prompt = buildSystemPrompt({ language: 'en', toolNames: [] });
    expect(prompt).not.toContain('Tool Usage Guidance');
  });

  it('should use Chinese sections for zh language', () => {
    const prompt = buildSystemPrompt({ language: 'zh' });
    expect(prompt).toContain('AI 伙伴');
    expect(prompt).toContain('核心原则');
    expect(prompt).not.toContain('Core Principles');
  });

  it('should use Chinese tool guidance for zh language', () => {
    const prompt = buildSystemPrompt({
      language: 'zh',
      toolNames: ['Bash'],
    });
    expect(prompt).toContain('工具使用指引');
    expect(prompt).toContain('错误处理');
  });

  it('should include skill content after tools', () => {
    const prompt = buildSystemPrompt({
      language: 'en',
      toolNames: ['Bash'],
      skillContent: '## Custom Skill\nDo something special.',
    });
    expect(prompt).toContain('## Custom Skill');
    expect(prompt).toContain('Do something special.');
  });

  it('should produce significantly longer prompt than fallback', () => {
    const prompt = buildSystemPrompt({ language: 'en' });
    expect(prompt.length).toBeGreaterThan(500);
  });
});
