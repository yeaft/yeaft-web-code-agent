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

function langSection(source, lang) {
  const marker = `<!-- lang:${lang} -->`;
  const start = source.indexOf(marker);
  if (start === -1) return '';
  const bodyStart = start + marker.length;
  const next = source.indexOf('<!-- lang:', bodyStart);
  return source.slice(bodyStart, next === -1 ? undefined : next);
}

function workerPrompt(language) {
  return buildWorkerPrompt({
    language,
    includeShape: true,
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
  const heading = prompt.includes('## 灵魂') ? '## 灵魂' : '## Soul';
  const start = prompt.indexOf(heading);
  if (start === -1) return '';
  const bodyStart = start + heading.length;
  const nextHeader = prompt.indexOf('\n\n## ', bodyStart + 2);
  return prompt.slice(bodyStart, nextHeader === -1 ? undefined : nextHeader).trim();
}

const STATIC_ZH_PROMPT_FORBIDDEN = [
  'Core Principles',
  'Task Replies',
  'Output Format',
  'Planning Mode',
  'Search Strategy',
  'Tool Usage Guidance',
  'General Rules',
  'File Operations',
  'Search and Navigation',
  '## Soul',
  'You are a',
  'You are in dream mode',
  'Yeaft AI',
  'AI companion',
  'Language policy',
  'Core capabilities',
  'Prefer Chinese',
  'Answering style',
  'VP soul',
  'VP 灵魂',
  'VP 执行回合',
  '其他 VP',
  'session member',
  'the current session',
  'Task Scope',
  'Turn Scope',
  'tool traces',
  'inbound envelope',
  'Prompt Shape',
  'Prompt 结构',
  '## active_scope',
  'session_id:',
  'session_members:',
  'session_topics:',
];

const STATIC_EN_PROMPT_FORBIDDEN = [
  '核心原则',
  '任务回复',
  '输出格式',
  '规划模式',
  '工具使用指南',
  '通用规则',
  '文件操作',
  '搜索与导航',
  '## 灵魂',
  '你是',
  '你处于梦境模式',
];

function expectNotToContainAny(text, forbidden) {
  for (const phrase of forbidden) {
    expect(text, phrase).not.toContain(phrase);
  }
}

const DREAM_PROMPT_CASES = [
  ['triagePass1', { sessionId: 'session_test', topicSummaries: '- active_scope/rendering', conversation: '[]' }],
  ['triagePass2', { description: 'active scope rendering', existingTopics: '- active_scope/rendering' }],
  ['update', { target: 'sessions/session_test', batchHeader: 'batch 1', memoryMd: '', summaryMd: '', sources: '[]' }],
  ['create', { target: 'sessions/session_test', sources: '[]', siblingsBlock: '' }],
  ['extractUser', {}],
  ['extractVp', { vpId: 'linus' }],
  ['extractSession', { sessionId: 'session_test' }],
  ['extractTopic', { topicId: 'active_scope/rendering' }],
  ['summarizeScope', { scope: 'sessions/session_test', segmentCount: 1, tokenBudget: 500, segments: '- test' }],
];

describe('worker prompt language selection', () => {
  it('does not use prompt-time legacy stock migration for old Omni bodies', () => {
    const prompt = workerPrompt('zh-CN');

    expect(prompt).toContain('# 全能助手');
    expect(prompt).not.toContain('# 全能助手 — 全能助手');
    expect(prompt).toContain('## 灵魂');
    expect(prompt).not.toContain('## Soul');
    expect(prompt).toContain('You are Omni Assistant / 全能助手');
    expect(prompt).toContain('Language policy / 语言策略');
    expect(prompt).toContain('Core capabilities / 核心能力');
    expect(prompt).not.toContain('你是 Omni。你始终看着整个会话的形状');
    expect(prompt).toContain('## 任务回复');
    expect(prompt).toContain('完成后只汇报改了什么、验证了什么、风险或下一步');
    expect(prompt).not.toContain('### 人物特点');
    expect(prompt).not.toContain('### Traits');
    expect(prompt).not.toContain('VP soul');
    expect(prompt).not.toContain('VP 灵魂');
    expect(prompt).not.toContain('session member');
    expect(prompt).not.toContain('Task Scope');
    expect(prompt).not.toContain('Turn Scope');
    expect(prompt).not.toContain('tool traces');
    expect(prompt).not.toContain('inbound envelope');
    expect(prompt).not.toContain('Prompt 结构');
    expect(prompt).toContain('# 提示词结构（执行者）');
    expect(prompt).toContain('会话成员的灵魂，以及用户、当前会话、当前会话成员');
    expect(prompt).toContain('当前任务的摘要');
    expect(prompt).toContain('工具调用轨迹');
    expect(prompt).toContain('入站转交消息');
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
    const prompt = buildWorkerPrompt({
      language: 'en',
      includeShape: true,
      toolNames: ['FileRead'],
      vpPersona: DEFAULT_VPS.find(vp => vp.vpId === 'omni'),
    });

    expect(prompt).toContain('# Omni');
    expect(prompt).not.toContain('# Omni — Requirement and Flow Lead');
    expect(prompt).toContain('## Soul');
    expect(prompt).toContain('You are Omni. You keep the whole session in view');
    expect(prompt).not.toContain('You are Omni Assistant / 全能助手');
    expect(prompt).not.toContain('Language policy / 语言策略');
    expect(prompt).not.toContain('Core capabilities / 核心能力');
    expect(prompt).not.toContain('### Traits');
    expect(prompt).toContain('## Task Replies');
    expect(prompt).toContain('after completing work, report only what changed, what was verified, and any risk or next step.');
    expect(prompt).not.toContain('你是 Omni');
    expect(prompt).not.toContain('## 任务回复');
  });

  it('adds concise task reply guidance to non-persona prompts in both languages', () => {
    const zhPrompt = buildWorkerPrompt({ language: 'zh', includeShape: false });
    const enPrompt = buildWorkerPrompt({ language: 'en', includeShape: false });

    expect(zhPrompt).toContain('完成后只汇报改了什么、验证了什么、风险或下一步');
    expect(enPrompt).toContain('after completing work, report only what changed, what was verified, and any risk or next step');
  });

  it('adds readable output-format guidance to persona and fallback prompts', () => {
    const personaZhPrompt = workerPrompt('zh-CN');
    const personaEnPrompt = workerPrompt('en');
    const fallbackZhPrompt = buildWorkerPrompt({ language: 'zh', includeShape: false });
    const fallbackEnPrompt = buildWorkerPrompt({ language: 'en', includeShape: false });

    for (const prompt of [personaEnPrompt, fallbackEnPrompt]) {
      expect(prompt).toContain('## Communicating With the User');
      expect(prompt).toContain('User-facing text is for a person, not a console log');
      expect(prompt).toContain('group related sentences into short paragraphs, usually 2-4 sentences');
      expect(prompt).toContain('Do not wrap ordinary prose, summaries, labels, headings, bullet lists, or single words in fenced code blocks');
      expect(prompt).toContain('use inline code instead of a fenced block');
    }

    expect(fallbackZhPrompt).toContain('你正在当前会话中参与协作');
    expect(fallbackZhPrompt).not.toContain('当前回合没有激活 VP soul');
    expect(fallbackZhPrompt).not.toContain('当前 session');

    for (const prompt of [personaZhPrompt, fallbackZhPrompt]) {
      expect(prompt).toContain('## 和用户沟通');
      expect(prompt).toContain('面向用户的文字是给人读的，不是控制台日志');
      expect(prompt).toContain('把相关句子合成短自然段，通常 2-4 句一段');
      expect(prompt).toContain('不要把普通说明、摘要、标签、标题、列表或单个词包进 fenced code block');
      expect(prompt).toContain('用 inline code，不要用 fenced code block');
    }
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

      expect(zhPrompt).toContain('## 灵魂');
      expect(zhPrompt).not.toContain('## Soul');
      expect(zhPrompt).toContain(vp.personaZh.split('\n')[0]);
      expect(zhPrompt).not.toContain(vp.personaEn.split('\n')[0]);
      for (const phrase of ['You are ', 'Language policy', 'Core capabilities', 'Decision style', 'Good for', 'Bad for', 'Prefer Chinese']) {
        expect(vp.personaZh, `${vp.vpId} zh source leaks ${phrase}`).not.toContain(phrase);
        expect(zhPrompt, `${vp.vpId} zh prompt leaks ${phrase}`).not.toContain(phrase);
      }
      expect(vp.personaZh, `${vp.vpId} zh source has bilingual slash title`).not.toContain(' / ');

      expect(enPrompt).toContain('## Soul');
      expect(enPrompt).not.toContain('## 灵魂');
      expect(enPrompt).toContain(vp.personaEn.split('\n')[0]);
      expect(enPrompt).not.toContain(vp.personaZh.split('\n')[0]);
      for (const phrase of ['你是', '人物特点', '擅长的事情', '解决问题的方式', '用户通常期待', '回答风格', '核心能力']) {
        expect(vp.personaEn, `${vp.vpId} en source leaks ${phrase}`).not.toContain(phrase);
        expect(enPrompt, `${vp.vpId} en prompt leaks ${phrase}`).not.toContain(phrase);
      }
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
    expect(prompt).toContain('## 灵魂');
    expect(prompt).not.toContain('## Soul');
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

  it('keeps static worker prompts localized for zh-CN and en', () => {
    const vp = DEFAULT_VPS.find(item => item.vpId === 'linus');
    const vpPersona = {
      vpId: vp.vpId,
      displayName: vp.displayName,
      persona: vp.persona,
    };
    const common = {
      includeShape: true,
      toolNames: ['FileRead'],
      vpPersona,
      activeScope: {
        sessionId: 'session_test',
        sessionMembers: ['omni', 'linus'],
        sessionTopics: ['active_scope/rendering'],
      },
    };

    const zh = buildWorkerPrompt({ ...common, language: 'zh-CN' });
    const en = buildWorkerPrompt({ ...common, language: 'en' });

    expect(zh).toContain('## 灵魂');
    expect(zh).toContain('## 核心原则');
    expect(zh).toContain('# 工具使用指引');
    expect(zh).toContain('## 当前会话上下文');
    expect(zh).toContain('会话 ID：session_test');
    expect(zh).toContain('会话成员：omni、linus');
    expect(zh).toContain('当前讨论：当前会话上下文的提示词呈现');
    expectNotToContainAny(zh, STATIC_ZH_PROMPT_FORBIDDEN);
    expect(en).toContain('## Soul');
    expect(en).toContain('## Core Principles');
    expect(en).toContain('# Tool Usage Guidance');
    expect(en).toContain('## Current session context');
    expect(en).toContain('Session ID: session_test');
    expect(en).toContain('Session members: omni, linus');
    expect(en).toContain('Current focus: current session context prompt rendering');
    expect(en).not.toContain('## active_scope');
    expectNotToContainAny(en, STATIC_EN_PROMPT_FORBIDDEN);
  });

  it('renders active scope topics as natural session context instead of slugs', () => {
    const prompt = buildWorkerPrompt({
      language: 'zh-CN',
      includeShape: false,
      toolNames: ['FileRead'],
      vpPersona: null,
      activeScope: {
        sessionId: 'session_yeaft-llm_2CX9DGEB',
        sessionMembers: ['omni', 'martin', 'linus'],
        sessionTopics: [
          'Yeaft/OpenAI-Responses',
          'Yeaft/PR-1018-v0.1.999',
          'project/pr-workflow',
          'yeaft/model-config-isolation',
        ],
      },
    });

    expect(prompt).toContain('## 当前会话上下文');
    expect(prompt).toContain('会话 ID：session_yeaft-llm_2CX9DGEB');
    expect(prompt).toContain('会话成员：omni、martin、linus');
    expect(prompt).toContain('当前讨论：Yeaft 的 OpenAI Responses 适配与模型配置');
    expect(prompt).toContain('最近的 PR 修复、review、merge 和 tag 发布流程');
    expect(prompt).toContain('项目的 PR review、merge 和 tag 发布流程');
    expect(prompt).toContain('Yeaft 的模型配置隔离');
    expect(prompt).not.toContain('## active_scope');
    expect(prompt).not.toContain('session_id:');
    expect(prompt).not.toContain('session_members:');
    expect(prompt).not.toContain('session_topics:');
    expect(prompt).not.toContain('Yeaft/PR-1018-v0.1.999');
    expect(prompt).not.toContain('project/pr-workflow');
    expect(prompt).not.toContain('yeaft/model-config-isolation');
  });

  it('uses natural Chinese descriptions for known and unknown session topic slugs', () => {
    const prompt = buildWorkerPrompt({
      language: 'zh-CN',
      includeShape: false,
      toolNames: ['FileRead'],
      vpPersona: null,
      activeScope: {
        sessionId: 'session_topics',
        sessionMembers: ['omni', 'martin', 'linus'],
        sessionTopics: [
          'dream/segments',
          'system-prompt-localization',
          'default-character/prompt-soul',
          'dream/session-extraction',
          'unknown-feature/branch-name',
        ],
      },
    });

    expect(prompt).toContain('梦境记忆片段的抽取与整理');
    expect(prompt).toContain('系统提示词的中英文一致性');
    expect(prompt).toContain('默认角色灵魂提示词的表达方式');
    expect(prompt).toContain('梦境会话记忆的抽取质量');
    expect(prompt).toContain('近期的项目协作事项');
    expect(prompt).not.toContain('dream/segments');
    expect(prompt).not.toContain('system-prompt-localization');
    expect(prompt).not.toContain('default-character/prompt-soul');
    expect(prompt).not.toContain('dream/session-extraction');
    expect(prompt).not.toContain('unknown-feature/branch-name');
    expect(prompt).not.toContain('dreamsegments');
    expect(prompt).not.toContain('systempromptlocalization');
    expect(prompt).not.toContain('defaultcharacterpromptsoul');
    expect(prompt).not.toContain('branchname');
  });

  it('keeps Dream prompt templates localized for zh-CN and en', () => {
    for (const [name, vars] of DREAM_PROMPT_CASES) {
      const zh = renderDreamPrompt(name, vars, { language: 'zh-CN' });
      const en = renderDreamPrompt(name, vars, { language: 'en' });

      expect(zh, name).toContain('语言要求');
      expectNotToContainAny(zh, STATIC_ZH_PROMPT_FORBIDDEN);
      expect(en, name).toContain('Language requirement');
      expectNotToContainAny(en, STATIC_EN_PROMPT_FORBIDDEN);
    }
  });

  it('keeps stock VP souls localized at the authored source', () => {
    for (const vp of DEFAULT_VPS) {
      expect(vp.personaZh, vp.vpId).not.toMatch(/\b(You are|Core capabilities|Decision style|Good for|People come to you)\b/);
      expect(vp.personaEn, vp.vpId).not.toMatch(/[\u4e00-\u9fff]/);
    }
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

  it('keeps English prompt template sections free of Chinese prose', () => {
    const roots = [
      join(process.cwd(), 'agent/yeaft/templates'),
      join(process.cwd(), 'agent/yeaft/dream/prompts'),
    ];
    const files = roots.flatMap(root => listMarkdownFiles(root));

    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      const en = langSection(source, 'en');
      expect(en, file).not.toMatch(/[\u4e00-\u9fff]/);
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
    expect(zh).toContain('最近一段会话对话');
    expect(zh).not.toContain('最近一段 session 对话');
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

  it('renders explicit multi-VP routing guidance with peers and route_forward requirement', () => {
    const zh = buildWorkerPrompt({
      language: 'zh-CN',
      includeShape: false,
      activeScope: {
        sessionId: 'session_1',
        sessionMember: 'linus',
        sessionMembers: ['omni', 'linus', 'martin'],
      },
    });
    const en = buildWorkerPrompt({
      language: 'en',
      includeShape: false,
      activeScope: {
        sessionId: 'session_1',
        sessionMember: 'linus',
        sessionMembers: ['omni', 'linus', 'martin'],
      },
    });

    expect(zh).toContain('## multi_vp_routing');
    expect(zh).toContain('当前 VP: linus');
    expect(zh).toContain('可转发 VP: omni, martin');
    expect(zh).toContain('必须调用 `route_forward`');
    expect(zh).toContain('VP 自己写 @mention 不会触发路由');
    expect(en).toContain('## multi_vp_routing');
    expect(en).toContain('Current VP: linus');
    expect(en).toContain('Forwardable VPs: omni, martin');
    expect(en).toContain('you MUST call `route_forward`');
  });

  it('omits multi-VP routing guidance when there are no peers', () => {
    const prompt = buildWorkerPrompt({
      language: 'en',
      includeShape: false,
      activeScope: {
        sessionId: 'session_1',
        sessionMember: 'linus',
        sessionMembers: ['linus'],
      },
    });

    expect(prompt).not.toContain('## multi_vp_routing');
  });

});
