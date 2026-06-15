import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { buildRouterPrompt, buildWorkerPrompt, getDefaultPlanInstruction, renderLayerASummaries } from '../../../agent/yeaft/prompts.js';
import { loadPersonas } from '../../../agent/yeaft/personas.js';
import { render as renderDreamPrompt } from '../../../agent/yeaft/dream/prompts/index.js';
import { DEFAULT_VPS } from '../../../agent/yeaft/vp/seed-defaults.js';

const SEEDED_OMNI_PERSONA = `You are Omni Assistant / 全能助手, a cross-domain, execution-focused general AI partner.

Language policy / 语言策略:
- Prefer Chinese when the user writes in Chinese; prefer English when the user writes in English.
- If the conversation is bilingual, mirror the user's latest language unless they ask otherwise.

Core capabilities / 核心能力:
- Cross-domain synthesis: handle writing, coding, product thinking, research, planning, analysis, learning, translation, troubleshooting, and creative work without forcing the user to pick a specialist first.
- Strong execution: when a task needs action, clarify only the blocking unknowns, make a short plan, use available tools, produce the deliverable, and verify the result.`;


function listMarkdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listMarkdownFiles(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

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

function extractSoul(prompt) {
  const start = prompt.indexOf('## Soul');
  if (start === -1) return '';
  const bodyStart = start + '## Soul'.length;
  const nextHeader = prompt.indexOf('\n\n## ', bodyStart + 2);
  return prompt.slice(bodyStart, nextHeader === -1 ? undefined : nextHeader).trim();
}

describe('worker prompt language selection', () => {
  it('does not synthesize localized stock fallback souls for English-only Omni bodies', () => {
    const prompt = workerPrompt('zh-CN');

    expect(prompt).toContain('# 全能助手');
    expect(prompt).not.toContain('# 全能助手 — 全能助手');
    expect(prompt).toContain('## Soul');
    expect(prompt).toContain('You are Omni Assistant / 全能助手');
    expect(prompt).toContain('Cross-domain synthesis: handle writing, coding');
    expect(prompt).toContain('## 任务回复');
    expect(prompt).toContain('完成后只汇报改了什么、验证了什么、风险或下一步');
    expect(prompt).not.toContain('你是 Omni，一个负责需求分析、目标澄清、流程推进和团队协调的 VP。');
    expect(prompt).not.toContain('### 人物特点');
    expect(prompt).not.toContain('### 用户通常期待你完成');
    expect(prompt).not.toContain('## Core Principles');
  });

  it('does not render legacy stock fallback labels for English-only stock roles in Chinese', () => {
    for (const vpId of ['linus', 'omni', 'martin']) {
      const prompt = buildWorkerPrompt({
        language: 'zh-CN',
        includeShape: false,
        vpPersona: {
          vpId,
          displayName: vpId,
          persona: 'English only body',
        },
      });

      const soul = extractSoul(prompt);

      expect(soul).toBe('English only body');
      expect(soul).not.toMatch(/\bVP\b/);
      expect(soul).not.toContain('### 人物特点');
      expect(soul).not.toContain('### 擅长的事情');
      expect(soul).not.toContain('### 解决问题的方式');
      expect(soul).not.toContain('### Traits');
      expect(soul).not.toContain('### Strengths');
    }
  });

  it('keeps English prompts English for English configuration', () => {
    const prompt = workerPrompt('en');

    expect(prompt).toContain('# Omni Assistant');
    expect(prompt).not.toContain('# Omni Assistant — All-Purpose Assistant');
    expect(prompt).toContain('## Soul');
    expect(prompt).toContain('You are Omni Assistant / 全能助手');
    expect(prompt).not.toContain('### Traits');
    expect(prompt).toContain('## Task Replies');
    expect(prompt).toContain('after completing work, report only what changed, what was verified, and any risk or next step.');
    expect(prompt).not.toContain('你是 Omni，一个负责需求分析');
    expect(prompt).not.toContain('## 任务回复');
  });

  it('adds concise task reply guidance to non-persona prompts in both languages', () => {
    const zhPrompt = buildWorkerPrompt({ language: 'zh', includeShape: false });
    const enPrompt = buildWorkerPrompt({ language: 'en', includeShape: false });

    expect(zhPrompt).toContain('完成后只汇报改了什么、验证了什么、风险或下一步');
    expect(enPrompt).toContain('after completing work, report only what changed, what was verified, and any risk or next step');
  });

  it('does not invent a stock Linus soul from only vpId/frontmatter', () => {
    const prompt = promptFor({ vpId: 'linus', displayName: 'Linus', role: 'developer' }, 'zh-CN');

    expect(prompt).toContain('# Linus');
    expect(prompt).not.toContain('# Linus — developer');
    expect(prompt).not.toContain('你是 Linus，developer。请以 Linus 的思考方式理解问题');
    expect(prompt).not.toContain('### 人物特点');
    expect(prompt).not.toContain('### 擅长的事情');
    expect(prompt).not.toContain('### 解决问题的方式');
    expect(prompt).not.toContain('### 用户通常期待你完成');
    expect(prompt).not.toContain('### 回答风格');
    expect(prompt).not.toContain('# Yeaft');
    expect(prompt).not.toContain('你是 Yeaft');
    expect(prompt).not.toContain('Yeaft — AI');
  });

  it('renders all stock VP souls from bilingual role.md persona sections', () => {
    expect(DEFAULT_VPS.length).toBeGreaterThan(20);
    for (const vp of DEFAULT_VPS) {
      expect(vp.persona).toContain('<!-- lang:en -->');
      expect(vp.persona).toContain('<!-- lang:zh -->');
      expect(vp.personaEn).toContain('You are');
      expect(vp.personaZh).toContain('你是');
      expect(vp.roleZh).toBeTruthy();

      const zhPrompt = promptFor(vp, 'zh-CN');
      const enPrompt = promptFor(vp, 'en');

      expect(zhPrompt).toContain('## Soul');
      expect(zhPrompt).toContain(vp.personaZh.split('\n')[0]);
      expect(zhPrompt).not.toContain(vp.personaEn.split('\n')[0]);
      expect(enPrompt).toContain('## Soul');
      expect(enPrompt).toContain(vp.personaEn.split('\n')[0]);
      expect(enPrompt).not.toContain(vp.personaZh.split('\n')[0]);
    }
  });

  it('does not synthesize structured soul fields without an authored persona body', () => {
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

    expect(prompt).toContain('# Designer');
    expect(prompt).toContain('## Soul');
    expect(prompt).not.toContain('### 人物特点');
    expect(prompt).not.toContain('重视用户路径');
    expect(prompt).not.toContain('### 擅长的事情');
    expect(prompt).not.toContain('### 解决问题的方式');
    expect(prompt).not.toContain('### 用户通常期待你完成');
    expect(prompt).not.toContain('### 回答风格');
    expect(prompt).not.toContain('### 避免');
  });

  it('keeps an English-only marked persona instead of inventing a Chinese fallback', () => {
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

    expect(prompt).toContain('# 安全专家');
    expect(prompt).not.toContain('# 安全专家 — 专家');
    expect(prompt).toContain('You are a security expert.');
    expect(prompt).not.toContain('### 人物特点');
  });

  it('keeps a Chinese-only marked persona instead of inventing an English fallback', () => {
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

    expect(prompt).toContain('# Security Expert');
    expect(prompt).not.toContain('# Security Expert — Expert');
    expect(prompt).toContain('你是安全专家。');
    expect(prompt).not.toContain('### Traits');
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

  it('returns localized planning instructions for StartPlan', () => {
    const zh = getDefaultPlanInstruction('zh-CN');
    const en = getDefaultPlanInstruction('en');

    expect(zh).toContain('# 规划模式');
    expect(zh).toContain('你刚进入下面主题的**规划模式**');
    expect(zh).not.toContain('# Planning Mode');
    expect(zh).not.toContain('You have just entered **planning mode**');
    expect(en).toContain('# Planning Mode');
    expect(en).toContain('You have just entered **planning mode**');
    expect(en).not.toContain('# 规划模式');
  });

  it('keeps every prompt template explicitly bilingual', () => {
    const roots = [
      join(process.cwd(), 'agent/yeaft/templates'),
      join(process.cwd(), 'agent/yeaft/dream/prompts'),
    ];
    const files = roots.flatMap(root => listMarkdownFiles(root));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      expect(source, file).toContain('<!-- lang:en -->');
      expect(source, file).toContain('<!-- lang:zh -->');
    }
  });

  it('renders Dream prompts in the requested language without generic Yeaft AI identity', () => {
    const vars = {
      sessionId: 'session_test',
      topicSummaries: '- active_scope/rendering — prompt labels',
      conversation: '[]',
    };
    const zh = renderDreamPrompt('triagePass1', vars, { language: 'zh-CN' });
    const en = renderDreamPrompt('triagePass1', vars, { language: 'en' });

    expect(zh).toContain('语言要求');
    expect(zh).toContain('最近一段 session 对话');
    expect(zh).not.toContain('recent session conversation');
    expect(zh).not.toContain('Yeaft AI companion');
    expect(en).toContain('Language requirement');
    expect(en).toContain('recent session conversation');
    expect(en).not.toContain('Yeaft AI companion');
  });

  it('loads built-in sub-agent personas with bilingual prompt bodies', () => {
    const personas = loadPersonas({ fresh: true });
    for (const id of ['explorer', 'implementer', 'researcher', 'reviewer']) {
      const persona = personas.get(id);
      expect(persona, id).toBeTruthy();
      expect(persona.systemPrompt, id).toContain('<!-- lang:en -->');
      expect(persona.systemPrompt, id).toContain('<!-- lang:zh -->');
    }
  });

});
