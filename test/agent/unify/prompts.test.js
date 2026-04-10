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
    expect(prompt).toContain('You are Yeaft');
    expect(prompt).toContain('Current mode: chat');
    expect(prompt).toContain('Date:');
  });

  it('should build English prompt when language is en', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'chat' });
    expect(prompt).toContain('You are Yeaft, a helpful AI assistant.');
    expect(prompt).toContain('Current mode: chat');
  });

  it('should include work mode instruction in English', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'work' });
    expect(prompt).toContain('You are in work mode');
    expect(prompt).toContain('Break tasks into steps');
  });

  it('should include dream mode instruction in English', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'dream' });
    expect(prompt).toContain('You are in dream mode');
    expect(prompt).toContain('Reflect on past conversations');
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
    expect(prompt).toContain('你是 Yeaft');
    expect(prompt).toContain('当前模式：chat');
    expect(prompt).toContain('日期：');
  });

  it('should include work mode instruction in Chinese', () => {
    const prompt = buildSystemPrompt({ language: 'zh', mode: 'work' });
    expect(prompt).toContain('你处于工作模式');
    expect(prompt).toContain('将任务分解为步骤');
  });

  it('should include dream mode instruction in Chinese', () => {
    const prompt = buildSystemPrompt({ language: 'zh', mode: 'dream' });
    expect(prompt).toContain('你处于梦境模式');
    expect(prompt).toContain('回顾过去的对话');
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
    expect(prompt).toContain('You are Yeaft');
    expect(prompt).not.toContain('你是 Yeaft');
  });

  it('should fallback to English for null language', () => {
    const prompt = buildSystemPrompt({ language: null, mode: 'chat' });
    expect(prompt).toContain('You are Yeaft');
  });

  it('should fallback to English for undefined language', () => {
    const prompt = buildSystemPrompt({ language: undefined, mode: 'chat' });
    expect(prompt).toContain('You are Yeaft');
  });

  // ─── Edge cases ───────────────────────────────────────────────

  it('should not include mode-specific instruction for chat mode', () => {
    const prompt = buildSystemPrompt({ language: 'en', mode: 'chat' });
    expect(prompt).not.toContain('work mode');
    expect(prompt).not.toContain('dream mode');
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
});
