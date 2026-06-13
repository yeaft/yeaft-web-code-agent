import { describe, expect, it } from 'vitest';
import { buildWorkerPrompt } from '../../../agent/yeaft/prompts.js';

const SEEDED_OMNI_PERSONA = `You are Omni Assistant / 全能助手, a cross-domain, execution-focused general AI partner.

Language policy / 语言策略:
- Prefer Chinese when the user writes in Chinese; prefer English when the user writes in English.
- If the conversation is bilingual, mirror the user's latest language unless they ask otherwise.

Core capabilities / 核心能力:
- Cross-domain synthesis: handle writing, coding, product thinking, research, planning, analysis, learning, translation, troubleshooting, and creative work without forcing the user to pick a specialist first.
- Strong execution: when a task needs action, clarify only the blocking unknowns, make a short plan, use available tools, produce the deliverable, and verify the result.`;

function workerPrompt(language) {
  return buildWorkerPrompt({
    language,
    includeShape: false,
    toolNames: ['FileRead'],
    vpPersona: {
      vpId: 'omni',
      displayName: 'Omni Assistant',
      displayNameZh: '全能助手',
      role: 'All-Purpose Assistant',
      roleZh: '全能助手',
      persona: SEEDED_OMNI_PERSONA,
    },
  });
}

describe('worker prompt language selection', () => {
  it('uses localized Chinese persona text instead of the seeded English Omni block', () => {
    const prompt = workerPrompt('zh-CN');

    expect(prompt).toContain('# 全能助手 — 全能助手');
    expect(prompt).toContain('你是全能助手，一个跨领域、偏执行的通用 AI 伙伴。');
    expect(prompt).toContain('## 任务回复');
    expect(prompt).toContain('执行类任务完成后只简要汇报：改了什么、验证了什么、风险或下一步。');
    expect(prompt).not.toContain('You are Omni Assistant / 全能助手');
    expect(prompt).not.toContain('Cross-domain synthesis: handle writing, coding');
    expect(prompt).not.toContain('## Core Principles');
  });

  it('keeps English prompts English for English configuration', () => {
    const prompt = workerPrompt('en');

    expect(prompt).toContain('# Omni Assistant — All-Purpose Assistant');
    expect(prompt).toContain('You are Omni Assistant, a cross-domain, execution-focused general AI partner.');
    expect(prompt).toContain('## Task Replies');
    expect(prompt).toContain('After execution tasks, briefly report only what changed, what was verified, and any risk or next step.');
    expect(prompt).not.toContain('你是全能助手，一个跨领域、偏执行的通用 AI 伙伴。');
    expect(prompt).not.toContain('## 任务回复');
  });

  it('adds concise task reply guidance to non-persona prompts in both languages', () => {
    const zhPrompt = buildWorkerPrompt({ language: 'zh', includeShape: false });
    const enPrompt = buildWorkerPrompt({ language: 'en', includeShape: false });

    expect(zhPrompt).toContain('完成后只汇报：改了什么、验证了什么、风险或下一步');
    expect(enPrompt).toContain('After completing work, report only: what changed, what was verified, and any risk or next step');
  });

  it('does not fall back to an English-only marked persona for Chinese prompts', () => {
    const prompt = buildWorkerPrompt({
      language: 'zh-CN',
      includeShape: false,
      vpPersona: {
        vpId: 'security',
        displayNameZh: '安全专家',
        roleZh: '专家',
        persona: '<!-- lang:en -->\nYou are a security expert.\n',
      },
    });

    expect(prompt).toContain('# 安全专家 — 专家');
    expect(prompt).not.toContain('You are a security expert.');
  });

  it('does not fall back to a Chinese-only marked persona for English prompts', () => {
    const prompt = buildWorkerPrompt({
      language: 'en',
      includeShape: false,
      vpPersona: {
        vpId: 'security',
        displayName: 'Security Expert',
        role: 'Expert',
        persona: '<!-- lang:zh -->\n你是安全专家。\n',
      },
    });

    expect(prompt).toContain('# Security Expert — Expert');
    expect(prompt).not.toContain('你是安全专家。');
  });

  it('adds response display rules that reserve fenced code blocks for real code', () => {
    const zhPrompt = buildWorkerPrompt({ language: 'zh', includeShape: false });
    const enPrompt = buildWorkerPrompt({ language: 'en', includeShape: false });

    expect(zhPrompt).toContain('普通说明写成紧凑的自然段');
    expect(zhPrompt).toContain('不要为了展示格式再套一层 fenced code block');
    expect(zhPrompt).toContain('fenced code block 只用于真正的代码、命令、配置、diff、日志');
    expect(zhPrompt).toContain('移动端优先：代码块要少、短、必要');
    expect(zhPrompt).toContain('不要把粗体、inline code 和普通文字拆成多行交替混排');

    expect(enPrompt).toContain('Write normal explanations as compact natural paragraphs');
    expect(enPrompt).toContain('do not wrap Markdown examples in fenced code blocks just to show formatting');
    expect(enPrompt).toContain('Use fenced code blocks only for real code, commands, config, diffs, logs');
    expect(enPrompt).toContain('Keep code blocks short and necessary, especially for mobile readers');
    expect(enPrompt).toContain('Do not alternate bold text, inline code, and plain text across many short lines');
  });

});
