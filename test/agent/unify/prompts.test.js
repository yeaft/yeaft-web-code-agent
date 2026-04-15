import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, SUPPORTED_LANGUAGES } from '../../../agent/unify/prompts.js';

describe('SUPPORTED_LANGUAGES', () => {
  it('should include en and zh', () => {
    expect(SUPPORTED_LANGUAGES).toContain('en');
    expect(SUPPORTED_LANGUAGES).toContain('zh');
  });
});

describe('buildSystemPrompt', () => {
  // ─── English prompts ──────────────────────────────────────────

  it('should build English prompt by default', () => {
    const prompt = buildSystemPrompt();
    // Template-based: should contain Yeaft identity
    expect(prompt).toContain('Yeaft');
    expect(prompt).toContain('Current mode: chat');
    expect(prompt).toContain('Date:');
  });

  it('should build English prompt when language is en', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'chat' });
    // With templates loaded: rich identity from base.md
    expect(prompt).toContain('Yeaft');
    expect(prompt).toContain('Current mode: chat');
  });

  it('should include work mode instruction in English', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'work' });
    // Template-based: mode-worker.md has "Worker Mode" content
    expect(prompt).toContain('Worker Mode');
    // Should contain execution guidance
    expect(prompt).toContain('Execution');
  });

  it('should include dream mode instruction in English', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'dream' });
    // Template-based: mode-dream.md has "Dream Mode" content
    expect(prompt).toContain('Dream Mode');
    // Should contain memory operations guidance
    expect(prompt.toLowerCase()).toContain('merge');
  });

  it('should include tool names in English', () => {
    const prompt = buildSystemPrompt({
      language: 'en',
      mode: 'chat',
      toolNames: ['read_file', 'write_file'],
    });
    expect(prompt).toContain('Available tools: read_file, write_file');
  });

  it('should not include tool section when no tools', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'chat', toolNames: [] });
    expect(prompt).not.toContain('Available tools');
    expect(prompt).not.toContain('可用工具');
  });

  // ─── Chinese prompts ──────────────────────────────────────────

  it('should build Chinese prompt when language is zh', () => {
    const prompt = buildSystemPrompt({ language: 'zh', mode: 'chat' });
    // Template-based: Chinese section from base.md
    expect(prompt).toContain('Yeaft');
    expect(prompt).toContain('当前模式：chat');
    expect(prompt).toContain('日期：');
  });

  it('should include work mode instruction in Chinese', () => {
    const prompt = buildSystemPrompt({ language: 'zh', mode: 'work' });
    // Template-based: Chinese section from mode-worker.md
    expect(prompt).toContain('Worker 模式');
    expect(prompt).toContain('执行');
  });

  it('should include dream mode instruction in Chinese', () => {
    const prompt = buildSystemPrompt({ language: 'zh', mode: 'dream' });
    // Template-based: Chinese section from mode-dream.md
    expect(prompt).toContain('梦境模式');
    expect(prompt).toContain('合并');
  });

  it('should include tool names in Chinese', () => {
    const prompt = buildSystemPrompt({
      language: 'zh',
      mode: 'chat',
      toolNames: ['read_file', 'write_file'],
    });
    expect(prompt).toContain('可用工具：read_file, write_file');
  });

  // ─── Fallback behavior ────────────────────────────────────────

  it('should fallback to English for unknown language', () => {
    const prompt = buildSystemPrompt({ language: 'fr', mode: 'chat' });
    // Fallback to English template
    expect(prompt).toContain('Yeaft');
    // Should NOT contain Chinese identity markers
    expect(prompt).not.toContain('核心原则');
  });

  it('should fallback to English for null language', () => {
    const prompt = buildSystemPrompt({ language: null, mode: 'chat' });
    expect(prompt).toContain('Yeaft');
  });

  it('should fallback to English for undefined language', () => {
    const prompt = buildSystemPrompt({ language: undefined, mode: 'chat' });
    expect(prompt).toContain('Yeaft');
  });

  // ─── Edge cases ───────────────────────────────────────────────

  it('should not include work/dream mode instructions for chat mode', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'chat' });
    // Should not have worker or dream specific content
    expect(prompt).not.toContain('Worker Mode');
    expect(prompt).not.toContain('Dream Mode');
  });

  it('should include today date', () => {
    const prompt = buildSystemPrompt({ language: 'en' });
    const today = new Date().toISOString().split('T')[0];
    expect(prompt).toContain(today);
  });

  it('should separate sections with double newline', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'chat' });
    const parts = prompt.split('\n\n');
    expect(parts.length).toBeGreaterThanOrEqual(3); // identity, mode, date
  });

  // ─── Memory injection (Phase 2) ──────────────────────────────

  it('should include user profile in memory section', () => {
    const prompt = buildSystemPrompt({
      language: 'en',
      mode: 'chat',
      memory: { profile: 'Senior TypeScript developer. Prefers dark mode.' },
    });
    expect(prompt).toContain('## User Memory');
    expect(prompt).toContain('### User Profile');
    expect(prompt).toContain('Senior TypeScript developer');
  });

  it('should include recalled memory entries', () => {
    const prompt = buildSystemPrompt({
      language: 'en',
      mode: 'chat',
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
      mode: 'chat',
      compactSummary: 'User discussed TypeScript patterns and auth module bugs.',
    });
    expect(prompt).toContain('## Conversation History Summary');
    expect(prompt).toContain('User discussed TypeScript patterns');
  });

  it('should include memory section in Chinese', () => {
    const prompt = buildSystemPrompt({
      language: 'zh',
      mode: 'chat',
      memory: { profile: '高级 TypeScript 开发者' },
    });
    expect(prompt).toContain('## 用户记忆');
    expect(prompt).toContain('### 用户画像');
    expect(prompt).toContain('高级 TypeScript 开发者');
  });

  it('should not include memory section when no memory', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'chat' });
    expect(prompt).not.toContain('## User Memory');
    expect(prompt).not.toContain('## Conversation History Summary');
  });

  it('should not include memory section when memory is empty', () => {
    const prompt = buildSystemPrompt({
      language: 'en',
      mode: 'chat',
      memory: { profile: '', entries: [] },
    });
    expect(prompt).not.toContain('## User Memory');
  });

  // ─── Template-specific tests ──────────────────────────────────

  it('should include rich identity from base.md template', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'chat' });
    // base.md contains these specific sections
    expect(prompt).toContain('Core Principles');
    expect(prompt).toContain('Output Format');
    expect(prompt).toContain('Code Editing Rules');
  });

  it('should include chat mode instructions from mode-chat.md template', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'chat' });
    // mode-chat.md has specific content
    expect(prompt).toContain('Chat Mode');
    expect(prompt).toContain('Communication Style');
  });

  it('should include work mode instructions from mode-worker.md template', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'work' });
    expect(prompt).toContain('Worker Mode');
    expect(prompt).toContain('Ownership');
  });

  it('should include dream mode instructions from mode-dream.md template', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'dream' });
    expect(prompt).toContain('Dream Mode');
    expect(prompt).toContain('Consolidation Priority');
  });

  it('should include tool guidance when tools are provided', () => {
    const prompt = buildSystemPrompt({
      language: 'en',
      mode: 'chat',
      toolNames: ['Bash', 'FileRead'],
    });
    // tool-guidance.md content
    expect(prompt).toContain('Tool Usage Guidance');
    expect(prompt).toContain('Error Handling');
  });

  it('should not include tool guidance when no tools', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'chat', toolNames: [] });
    expect(prompt).not.toContain('Tool Usage Guidance');
  });

  it('should use Chinese sections for zh language', () => {
    const prompt = buildSystemPrompt({ language: 'zh', mode: 'chat' });
    expect(prompt).toContain('AI 伙伴');
    expect(prompt).toContain('核心原则');
    // Should NOT contain English section headers
    expect(prompt).not.toContain('Core Principles');
  });

  it('should use Chinese work mode for zh language', () => {
    const prompt = buildSystemPrompt({ language: 'zh', mode: 'work' });
    expect(prompt).toContain('Worker 模式');
    expect(prompt).toContain('所有权');
  });

  it('should use Chinese tool guidance for zh language', () => {
    const prompt = buildSystemPrompt({
      language: 'zh',
      mode: 'chat',
      toolNames: ['Bash'],
    });
    expect(prompt).toContain('工具使用指引');
    expect(prompt).toContain('错误处理');
  });

  it('should include skill content after tools', () => {
    const prompt = buildSystemPrompt({
      language: 'en',
      mode: 'chat',
      toolNames: ['Bash'],
      skillContent: '## Custom Skill\nDo something special.',
    });
    expect(prompt).toContain('## Custom Skill');
    expect(prompt).toContain('Do something special.');
  });

  it('should produce significantly longer prompt than fallback', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'work' });
    // The old prompt was ~150 chars. With templates it should be much richer.
    expect(prompt.length).toBeGreaterThan(500);
  });
});
