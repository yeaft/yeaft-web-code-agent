import { describe, expect, it } from 'vitest';
import { buildRouterPrompt, buildWorkerPrompt, renderLayerASummaries } from '../../../agent/yeaft/prompts.js';

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

function promptFor(vpPersona, language = 'zh-CN', extra = {}) {
  return buildWorkerPrompt({ language, includeShape: false, toolNames: ['FileRead'], vpPersona, ...extra });
}

describe('worker prompt language selection', () => {
  it('uses localized Chinese soul instead of the seeded English Omni block', () => {
    const prompt = workerPrompt('zh-CN');

    expect(prompt).toContain('# 全能助手 — 全能助手');
    expect(prompt).toContain('## Soul');
    expect(prompt).toContain('### 人物特点');
    expect(prompt).toContain('你是 Omni，一个负责需求分析、目标澄清、流程推进和团队协调的 VP。');
    expect(prompt).toContain('### 用户通常期待你完成');
    expect(prompt).toContain('## 任务回复');
    expect(prompt).toContain('完成后只汇报改了什么、验证了什么、风险或下一步');
    expect(prompt).not.toContain('You are Omni Assistant / 全能助手');
    expect(prompt).not.toContain('Cross-domain synthesis: handle writing, coding');
    expect(prompt).not.toContain('## Core Principles');
  });

  it('keeps English prompts English for English configuration', () => {
    const prompt = workerPrompt('en');

    expect(prompt).toContain('# Omni Assistant — All-Purpose Assistant');
    expect(prompt).toContain('## Soul');
    expect(prompt).toContain('### Traits');
    expect(prompt).toContain('You are Omni, a VP focused on requirement analysis');
    expect(prompt).toContain('## Task Replies');
    expect(prompt).toContain('after completing work, report only what changed, what was verified, and any risk or next step.');
    expect(prompt).not.toContain('你是 Omni，一个负责需求分析');
    expect(prompt).not.toContain('## 任务回复');
  });

  it('adds concise task reply guidance to non-persona prompts in both languages', () => {
    const zhPrompt = buildWorkerPrompt({ language: 'zh', includeShape: false });
    const enPrompt = buildWorkerPrompt({ language: 'en', includeShape: false });

    expect(zhPrompt).toContain('完成后只汇报：改了什么、验证了什么、风险或下一步');
    expect(enPrompt).toContain('after completing work, report only: what changed, what was verified, and any risk or next step');
  });

  it('renders minimal Linus persona as a full Chinese soul without Yeaft fallback identity', () => {
    const prompt = promptFor({ vpId: 'linus', displayName: 'Linus', role: 'developer' }, 'zh-CN');

    expect(prompt).toContain('# Linus — developer');
    expect(prompt).toContain('你是 Linus，developer。请以 Linus 的思考方式理解问题');
    expect(prompt).toContain('## Soul');
    expect(prompt).toContain('### 人物特点');
    expect(prompt).toContain('### 擅长的事情');
    expect(prompt).toContain('### 解决问题的方式');
    expect(prompt).toContain('### 用户通常期待你完成');
    expect(prompt).toContain('### 回答风格');
    expect(prompt).not.toContain('# Yeaft');
    expect(prompt).not.toContain('你是 Yeaft');
  });

  it('renders built-in Omni, Linus, and Martin fallback souls in both languages', () => {
    for (const vpId of ['omni', 'linus', 'martin']) {
      const zhPrompt = promptFor({ vpId, displayName: vpId }, 'zh-CN');
      const enPrompt = promptFor({ vpId, displayName: vpId }, 'en');

      expect(zhPrompt).toContain('## Soul');
      expect(zhPrompt).toContain('### 人物特点');
      expect(zhPrompt).toContain('### 用户通常期待你完成');
      expect(zhPrompt).not.toContain('### Traits');
      expect(enPrompt).toContain('## Soul');
      expect(enPrompt).toContain('### Traits');
      expect(enPrompt).toContain('### What Users Expect You To Do');
    }
  });

  it('renders structured soul fields when configured', () => {
    const prompt = promptFor({
      vpId: 'designer',
      displayName: 'Designer',
      traitsZh: ['重视用户路径'],
      strengthsZh: ['界面信息架构'],
      problemSolvingZh: '先澄清主任务，再做布局取舍。',
      expectedTasksZh: ['输出设计建议'],
      answerStyleZh: '简洁、具体。',
      avoidZh: ['不要引入新组件库'],
    }, 'zh-CN');

    expect(prompt).toContain('### 人物特点');
    expect(prompt).toContain('- 重视用户路径');
    expect(prompt).toContain('### 避免');
    expect(prompt).toContain('- 不要引入新组件库');
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

  it('keeps genuinely Chinese unmarked persona bodies in Chinese prompts', () => {
    const prompt = buildWorkerPrompt({
      language: 'zh-CN',
      includeShape: false,
      vpPersona: {
        vpId: 'architect',
        displayNameZh: '架构师',
        persona: '你是架构师，擅长边界划分和长期维护。',
      },
    });

    expect(prompt).toContain('你是架构师，擅长边界划分和长期维护。');
  });

  it('keeps English unmarked persona bodies in English prompts', () => {
    const prompt = buildWorkerPrompt({
      language: 'en',
      includeShape: false,
      vpPersona: {
        vpId: 'architect',
        displayName: 'Architect',
        persona: 'You are an architect focused on boundaries and maintainability.',
      },
    });

    expect(prompt).toContain('You are an architect focused on boundaries and maintainability.');
  });

  it('keeps search guidance in tool guidance instead of common rules', () => {
    const prompt = workerPrompt('en');
    const coreStart = prompt.indexOf('## Core Principles');
    const toolStart = prompt.indexOf('# Tool Usage Guidance');
    const commonRules = prompt.slice(coreStart, toolStart);
    const toolGuidance = prompt.slice(toolStart);

    expect(commonRules).not.toContain('## Search and Navigation');
    expect(commonRules).not.toContain('## Search Strategy');
    expect(toolGuidance).toContain('## Search Strategy');
    expect(toolGuidance).toContain('If you already know the file path');
  });

  it('does not inject unified mode while keeping tool guidance', () => {
    const prompt = workerPrompt('zh-CN');

    expect(prompt).not.toContain('统一模式');
    expect(prompt).not.toContain('Unified Mode');
    expect(prompt).not.toContain('你是一个持续伴随的 AI 伙伴');
    expect(prompt).toContain('# 工具使用指引');
  });

  it('does not repeat VP identity in core principles', () => {
    const prompt = promptFor({ vpId: 'linus', displayName: 'Linus', role: 'developer' }, 'zh-CN');
    const coreStart = prompt.indexOf('## 核心原则');
    const taskStart = prompt.indexOf('## 任务回复');
    const corePrinciples = prompt.slice(coreStart, taskStart);

    expect(corePrinciples).not.toContain('你是 Linus');
    expect(corePrinciples).not.toContain('你是 Yeaft');
  });

  it('renders session announcement labels without legacy group terminology', () => {
    const zhPrompt = promptFor({ vpId: 'linus', displayName: 'Linus' }, 'zh-CN', {
      sessionAnnouncement: '请保持 PR 流程。',
    });
    const enPrompt = promptFor({ vpId: 'linus', displayName: 'Linus' }, 'en', {
      sessionAnnouncement: 'Keep the PR workflow.',
    });

    expect(zhPrompt).toContain('[会话公告]');
    expect(zhPrompt).not.toContain('[群组公告]');
    expect(enPrompt).toContain('[Session Announcement]');
    expect(enPrompt).not.toContain('[Group Announcement]');
  });

  it('renders Layer-A session summaries without legacy group labels', () => {
    const zhBlock = renderLayerASummaries({ user: '用户', group: '旧 key 内容', vp: 'VP' }, 'zh-CN');
    const enBlock = renderLayerASummaries({ user: 'user', group: 'legacy key body', vp: 'vp' }, 'en');

    expect(zhBlock).toContain('## 会话总结\n旧 key 内容');
    expect(zhBlock).not.toContain('## 群组总结');
    expect(enBlock).toContain('## summary_session\nlegacy key body');
    expect(enBlock).not.toContain('## summary_group');
  });

  it('renders router prompt session summaries without legacy group labels', () => {
    const prompt = buildRouterPrompt({
      language: 'zh-CN',
      includeShape: false,
      summaries: { group: '旧 key 内容' },
    });

    expect(prompt).toContain('## 会话总结');
    expect(prompt).not.toContain('## 群组总结');
    expect(prompt).not.toContain('summary_group');
  });
});
