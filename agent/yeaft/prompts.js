/**
 * prompts.js — Bilingual system prompt templates
 *
 * Single source of truth for system prompts. Both engine.js and cli.js
 * import buildSystemPrompt() from here. Supports 'en' and 'zh'.
 *
 * Template files from agent/yeaft/templates/ are loaded once at startup
 * and used to enrich the system prompt beyond the hardcoded fallbacks.
 *
 * Concept layering (DESIGN-PROMPT §3):
 *   ① Identity      — VP persona body (or Yeaft fallback)
 *   ② Rules         — session announcement, date, mode template, tools,
 *                     tool-guidance, skills, common rules
 *   ③ Memory        — single block produced upstream by the AMS render
 *                     outlet and threaded through here as `memoryInjection`
 *   ④ Active Scope  — structured per-turn scope summary
 *                     (session / vp / members / envelope IDs)
 *
 * Long-term semantic context comes only from the AMS Memory outlet. The
 * conversation transcript stays in the messages timeline and is bounded by
 * deterministic per-request history-window trimming.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getRuntimePlatformInfo, renderRuntimePlatformPrompt } from './runtime-platform.js';

// ─── Template Loading (one-time at startup) ──────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, 'templates');

/**
 * Read a template file from the templates/ directory.
 *
 * task-332c F3 — missing-template guard:
 * Required templates MUST be present. If a required template is missing or
 * unreadable, throw a clear error instead of silently degrading to the
 * hardcoded fallback. Silent skip previously hid misconfigured deployments
 * (empty prompts shipped to production), so we now fail fast at load time.
 *
 * Non-required templates (passed with { required: false }) retain the old
 * "return empty string on absence" behavior for optional inclusions.
 *
 * @param {string} name — filename (e.g. 'base.md')
 * @param {{ required?: boolean }} [opts]
 * @returns {string}
 * @throws {Error} when required=true and the file is missing / unreadable / empty
 */
function readTemplate(name, { required = true } = {}) {
  const path = join(TEMPLATES_DIR, name);
  if (!existsSync(path)) {
    if (required) {
      throw new Error(
        `[prompts] Required template missing: ${name} ` +
        `(expected at ${path}). Templates are part of the agent package — ` +
        `check the install or build output.`
      );
    }
    return '';
  }
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch (e) {
    if (required) {
      throw new Error(
        `[prompts] Required template unreadable: ${name} ` +
        `(at ${path}): ${e.message}`
      );
    }
    return '';
  }
  const trimmed = content.trim();
  if (!trimmed && required) {
    throw new Error(
      `[prompts] Required template is empty: ${name} (at ${path}). ` +
      `An empty system prompt template would ship a degenerate prompt to the LLM.`
    );
  }
  return trimmed;
}

/**
 * Extract the section for a given language from a bilingual template.
 * Templates use `<!-- lang:en -->` / `<!-- lang:zh -->` HTML comment markers
 * to delimit language sections. Returns the content between the matching
 * marker and the next marker (or EOF).
 *
 * If no markers exist, returns the full content regardless of language.
 *
 * @param {string} content — full template content
 * @param {string} language — 'en' or 'zh'
 * @returns {string}
 */
function extractLangSection(content, language) {
  if (!content) return '';

  const selected = extractExactLangSection(content, language);
  if (selected !== null) return selected;

  // No marker for this language — if language is 'zh', try 'en' fallback
  if (language === 'zh') {
    const fallback = extractExactLangSection(content, 'en');
    if (fallback !== null) return fallback;
  }

  // No markers at all — return full content
  if (!content.includes('<!-- lang:')) return content;
  // Has markers but not for this language — fallback to en
  return extractExactLangSection(content, 'en') || '';
}

function extractExactLangSection(content, language) {
  if (!content) return null;

  const marker = `<!-- lang:${language} -->`;
  const markerIdx = content.indexOf(marker);
  if (markerIdx === -1) return null;

  // Extract from after the marker to the next <!-- lang: marker or EOF
  const sectionStart = markerIdx + marker.length;
  const nextMarkerIdx = content.indexOf('<!-- lang:', sectionStart);

  if (nextMarkerIdx === -1) {
    // This is the last section — take everything after the marker
    return content.slice(sectionStart).trim();
  }

  return content.slice(sectionStart, nextMarkerIdx).trim();
}

/** Loaded templates — read once at module load time. */
const RAW_TEMPLATES = {
  base: readTemplate('base.md'),
  core: readTemplate('core.md'),
  // base.md and the older split fragments remain packaged for external
  // snapshotters and deployment compatibility. Runtime prompt assembly uses
  // core.md plus scoped guidance instead of concatenating those full bundles.
  identityYeaft: readTemplate('identity-yeaft.md', { required: false }),
  commonRules: readTemplate('common-rules.md', { required: false }),
  modeUnified: readTemplate('mode-unified.md'),
  modeDream: readTemplate('mode-dream.md'),
  toolGuidance: readTemplate('tool-guidance.md'),
  // Phase 1 — DESIGN.md "Migration Plan" harness fragments. Optional so
  // older deployments without the templates still boot; buildWorkerPrompt /
  // buildRouterPrompt callers will simply omit the section.
  harnessWorkerShape: readTemplate('harness/worker-shape.md', { required: false }),
  harnessRouterShape: readTemplate('harness/router-shape.md', { required: false }),
  // Phase 3b — coordinator harness rule for inter-VP forwarding.
  harnessRouterHandoff: readTemplate('harness/router-handoff.md', { required: false }),
  // task — StartPlan tool fallback. The `StartPlan` tool reads this when
  // a VP has no `planInstruction` of its own. Required so a misconfigured
  // install fails fast instead of injecting an empty plan instruction.
  planInstruction: readTemplate('plan-instruction.md'),
};

/**
 * Get a template section for the given language.
 * @param {string} key — template key (e.g. 'base', 'modeChat')
 * @param {string} language — 'en' or 'zh'
 * @returns {string}
 */
function getTemplate(key, language) {
  const raw = RAW_TEMPLATES[key];
  if (!raw) return '';
  return extractLangSection(raw, language);
}

/**
 * Default planning-instruction text returned by the `StartPlan` tool when
 * the active VP has no `planInstruction` override on its role.md frontmatter.
 *
 * Pulled from `templates/plan-instruction.md`. Marked required at load time
 * so a missing template fails fast on agent boot — preferable to silently
 * shipping an empty plan instruction to the LLM.
 *
 * @param {string} [language='en'] — 'en' / 'zh' (uses lang-section markers
 *                                   if the template carries them; falls
 *                                   back to the whole body otherwise).
 * @returns {string}
 */
export function getDefaultPlanInstruction(language = 'en') {
  return getTemplate('planInstruction', normalizePromptLanguage(language));
}

// ─── Prompt Templates (hardcoded fallbacks) ──────────────────────

const PROMPTS = {
  en: {
    identity: 'No VP soul is active for this turn. Participate in the current session with grounded, evidence-based answers and preserve the user\'s context.',
    date: (d) => `Date: ${d}`,
    dream: 'You are in dream mode. Reflect on past conversations and consolidate memories.',
    // DESIGN-PROMPT §3 ④ — current session context block.
    activeScopeHeader: '## Current session context',
    activeScopeSessionIdLabel: 'Session ID',
    activeScopeMembersLabel: 'Session members',
    activeScopeTopicsLabel: 'Current focus',
    activeScopeEnvelopeLabel: 'Handoff',
    multiVpRoutingHeader: '## multi_vp_routing',
    sessionAnnouncementHeader: '[Session Announcement]',
    projectInstructionHeader: '[Project Instruction]',
    projectInstructionIntro: (projectLabel) => projectLabel
      ? `The current Session belongs to Project ${projectLabel}. The unified instruction for this Project is:`
      : 'The current Session belongs to the current Project. The unified instruction for this Project is:',
    workCenterInstructionsHeader: '[Work Center Agent Instructions]',
    workCenterInstructionsIntro: 'These Agent-level instructions apply to every Action in this WorkItem. Follow them unless they conflict with system/tool safety rules, the authoritative project document, or the WorkItem contract.',
    // Project-doc (CLAUDE.md / AGENTS.md) header + one-liner intro. Both
    // filenames are recognized: CLAUDE.md is this project's convention,
    // AGENTS.md is the cross-tool convention (Codex / OpenAI Codex CLI).
    projectDocHeader: '[Project Doc]',
    projectDocIntro:
      'The text below is the authoritative project context selected for this turn. It contains the stable core plus any task- or path-scoped sections that the runtime loaded on demand.',
    promptNoticeHeader: '[Runtime Notice]',
  },
  zh: {
    identity: '你正在当前会话中参与协作。保持用户上下文，回答要基于证据；需要工具时使用工具，但不要把自己没有实际执行过的事说成已经执行。',
    date: (d) => `日期：${d}`,
    dream: '你处于梦境模式。回顾过去的对话，整理和巩固记忆。',
    // DESIGN-PROMPT §3 ④ — 当前会话上下文。
    activeScopeHeader: '## 当前会话上下文',
    activeScopeSessionIdLabel: '会话 ID',
    activeScopeMembersLabel: '会话成员',
    activeScopeTopicsLabel: '当前讨论',
    activeScopeEnvelopeLabel: '转交消息',
    multiVpRoutingHeader: '## multi_vp_routing',
    sessionAnnouncementHeader: '[会话公告]',
    projectInstructionHeader: '[Project 指令]',
    projectInstructionIntro: (projectLabel) => projectLabel
      ? `当前 Session 隶属于 Project ${projectLabel}。当前 Project 的统一 instruction 是：`
      : '当前 Session 隶属于当前 Project。当前 Project 的统一 instruction 是：',
    workCenterInstructionsHeader: '[Work Center Agent 指令]',
    workCenterInstructionsIntro: '这些 Agent 级指令作用于当前 Work Item 的每个 Action。除非与系统/工具安全规则、权威项目文档或 Work Item 契约冲突，否则必须遵循。',
    // 项目文档块：CLAUDE.md / AGENTS.md（与 Codex 通用命名兼容）。
    projectDocHeader: '[项目文档]',
    projectDocIntro:
      '下面是当前 turn 选中的权威项目上下文，包含稳定核心以及 runtime 按任务或路径加载的范围章节。',
    promptNoticeHeader: '[运行时提示]',
  },
};

/** Supported language codes. */
export const SUPPORTED_LANGUAGES = Object.keys(PROMPTS);

/**
 * Return true for Chinese locales. Real app config persists values like
 * `zh-CN`; prompt templates are keyed by the base language (`zh`).
 *
 * @param {string} language
 * @returns {boolean}
 */
export function isZhLanguage(language) {
  return String(language || '').toLowerCase().startsWith('zh');
}

/**
 * Normalize app/user locale to the prompt dictionary key.
 * Protocol identifiers stay English; this only selects visible prose.
 *
 * @param {string} language
 * @returns {'en'|'zh'}
 */
export function normalizePromptLanguage(language) {
  return isZhLanguage(language) ? 'zh' : 'en';
}

/**
 * Build the system prompt for a given language.
 *
 * task-297: chat/work mode distinction was removed. The prompt now always uses
 * the unified mode template. The `mode` param is retained for backward compat
 * — only `mode === 'dream'` triggers the dream-mode template (used by background
 * memory maintenance); all other values fall through to unified mode.
 *
 * Prompt structure (DESIGN-PROMPT §3):
 *   ① Identity      — Core identity (persona or Yeaft fallback)
 *   ② Rules         — Session announcement, date, mode, tools, guidance, skills
 *   ③ Memory        — Single block produced by the AMS render outlet
 *                     (callers pass it as `memoryInjection`).
 *   ④ Active Scope  — Structured per-turn scope summary
 *                     (session / vp / members / envelope IDs).
 *   (The previous standalone user_profile / core_memory blocks are
 *    gone — those signals now arrive through AMS Resident. Task
 *    context (`taskCtx`) was wired into Active Scope by task-334e
 *    but never actually populated by the engine; removed 2026-05-13.)
 *
 *   Active Scope params (DESIGN-PROMPT §3 ④):
 *   @param {object} [activeScope] — structured scope summary for this turn
 *   @param {string} [activeScope.sessionId]
 *   @param {string} [activeScope.sessionMember]
 *   @param {string[]} [activeScope.sessionMembers]  current session roster
 *   @param {string[]} [activeScope.sessionTopics]   bounded topic labels for this session
 *   @param {object} [activeScope.envelope]          inbound routing info (sender, intent)
 *
 * @param {{
 *   language?: string,
 *   mode?: string,
 *   toolNames?: string[],
 *   memoryInjection?: string,
 *   skillContent?: string,
 *   activeScope?: object,
 *   vpPersona?: object,
 *   sessionAnnouncement?: string,
 *   projectInstruction?: string,
 *   projectLabel?: string,
 *   workCenterInstructions?: string,
 *   projectDoc?: string,
 *   promptNotices?: string[],
 * }} params
 * @returns {string}
 */
export function buildSystemPrompt({
  language = 'en',
  mode,
  toolNames = [],
  memoryInjection,
  skillContent,
  activeScope,
  vpPersona,
  sessionAnnouncement = '',
  projectInstruction = '',
  projectLabel = '',
  workCenterInstructions = '',
  projectDoc = '',
  runtimePlatform,
  activeTasks = '',
  promptNotices = [],
} = {}) {
  // Normalize app locales like `zh-CN` to prompt dictionary/template keys.
  const effectiveLang = normalizePromptLanguage(language);
  const lang = PROMPTS[effectiveLang] || PROMPTS.en;

  const parts = [];

  // ─── 1. Stable Core ────────────────────────────────────
  // A VP persona supplies the identity layer when present. The compact core
  // rules stay stable across turns and replace the old full base/common bundle.
  const personaBlock = renderVpPersona(vpPersona, lang, effectiveLang);
  if (personaBlock) parts.push(personaBlock);
  const coreTemplate = getTemplate('core', effectiveLang);
  if (coreTemplate) {
    parts.push(coreTemplate);
  } else if (!personaBlock) {
    parts.push(lang.identity);
  }

  // ─── 1.4  Project Doc (CLAUDE.md / AGENTS.md from session workDir) ───
  // The session working directory may contain a project-level
  // instructions file. The engine resolves "newest of CLAUDE.md vs
  // AGENTS.md by mtime" and threads the resulting text through here.
  // Empty/whitespace = no block emitted. Sits ABOVE the announcement
  // because user-authored project files are higher signal than the
  // group-level announcement (which is typically a short rule).
  const docText = (typeof projectDoc === 'string') ? projectDoc.trim() : '';
  if (docText) {
    const docHeader = lang.projectDocHeader || '[Project Doc]';
    const docIntro = lang.projectDocIntro || '';
    const introLine = docIntro ? `${docIntro}\n\n` : '';
    parts.push(`${docHeader}\n${introLine}${docText}`);
  }

  const projectInstructionText = typeof projectInstruction === 'string' ? projectInstruction.trim() : '';
  if (projectInstructionText) {
    const header = lang.projectInstructionHeader || '[Project Instruction]';
    const normalizedProjectLabel = typeof projectLabel === 'string' ? projectLabel.trim() : '';
    const intro = typeof lang.projectInstructionIntro === 'function'
      ? lang.projectInstructionIntro(normalizedProjectLabel)
      : '';
    parts.push(`${header}\n${intro ? `${intro}\n\n` : ''}${projectInstructionText}`);
  }

  // ─── 1.5  Session Announcement (CLAUDE.md-style shared prefix) ───
  // When a session has set an announcement, every VP in the session sees it
  // near the top of the system prompt — before tools, memory, mode-specific
  // instructions. Empty/whitespace = no block emitted.
  const annText = (typeof sessionAnnouncement === 'string') ? sessionAnnouncement.trim() : '';
  if (annText) {
    parts.push(`${lang.sessionAnnouncementHeader || '[Session Announcement]'}\n${annText}`);
  }

  const workCenterText = (typeof workCenterInstructions === 'string') ? workCenterInstructions.trim() : '';
  if (workCenterText) {
    const header = lang.workCenterInstructionsHeader || '[Work Center Agent Instructions]';
    const intro = lang.workCenterInstructionsIntro || '';
    parts.push(`${header}\n${intro ? `${intro}\n\n` : ''}${workCenterText}`);
  }

  const notices = Array.isArray(promptNotices)
    ? promptNotices.map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean)
    : [];
  if (notices.length > 0) {
    parts.push(`${lang.promptNoticeHeader || '[Runtime Notice]'}\n${notices.join('\n')}`);
  }

  // ─── 2. Date Metadata ──────────────────────────────────
  parts.push(lang.date(new Date().toISOString().split('T')[0]));

  // ─── 3. Mode-Specific Instructions ─────────────────────
  // Normal operation intentionally has no extra mode block: the VP soul is the
  // identity layer, and common rules/tool guidance define behavior. Dream keeps
  // its dedicated mode prompt because it is a background memory-maintenance job.
  if (mode === 'dream') {
    const dreamTemplate = getTemplate('modeDream', effectiveLang);
    parts.push(dreamTemplate || lang.dream);
  }

  // ─── 4. Runtime Platform + Tools + Tool Guidance ──────
  const runtimePlatformBlock = renderRuntimePlatformPrompt(runtimePlatform || getRuntimePlatformInfo(), effectiveLang);
  if (runtimePlatformBlock) {
    parts.push(runtimePlatformBlock);
  }

  if (toolNames.length > 0) {
    const guidance = renderActiveToolGuidance(toolNames, effectiveLang);
    const toolGuidanceTemplate = getTemplate('toolGuidance', effectiveLang);
    if (guidance && toolGuidanceTemplate) {
      parts.push(toolGuidanceTemplate.replace('{{guidance}}', guidance));
    }
  }

  // ─── 5. Skills Section ─────────────────────────────────
  if (skillContent) {
    parts.push(skillContent);
  }

  // ─── 6. Memory Section (DESIGN-PROMPT §3 ③) ────────────
  // The Memory section has a SINGLE render outlet. Callers compose the
  // block upstream by rendering the AMS snapshot (Resident + Recent +
  // OnDemand) and passing the result here as `memoryInjection`. The
  // legacy multi-path injection (FTS-formatted + AMS snapshot +
  // renderLayerASummaries + renderUserProfile + renderCoreMemory) was
  // retired in DESIGN-PROMPT v1: it produced 2-3× duplicated content
  // for the same `summary.md` payload.
  if (memoryInjection && memoryInjection.trim()) {
    parts.push(memoryInjection.trim());
  }

  // ─── 7. Active Scope (DESIGN-PROMPT §3 ④) ──────────────
  // Structured per-turn scope summary. The group/vp/envelope identifiers
  // are rendered as a leading line. (Per-task taskCtx sub-block was
  // never wired and is removed 2026-05-13.)
  const activeScopeBlock = renderActiveScope(activeScope, lang);
  if (activeScopeBlock) parts.push(activeScopeBlock);

  const activeTaskText = typeof activeTasks === 'string' ? activeTasks.trim() : '';
  if (activeTaskText) parts.push(activeTaskText);

  const multiVpRoutingBlock = renderMultiVpRouting(activeScope, lang);
  if (multiVpRoutingBlock) parts.push(multiVpRoutingBlock);

  return parts.join('\n\n');
}

// ─── helpers ─────────────────────────────────────────────────────

const TOOL_GUIDANCE_GROUPS = Object.freeze([
  {
    tools: ['DiscoverTools'],
    en: 'If the visible tools do not clearly cover the request, use `DiscoverTools` with the user goal before concluding that a capability is unavailable. If the target is absent from a page, follow `next_cursor` until found or the hidden directory is exhausted. If `restart_required` is true, restart without a cursor because the registered directory changed.',
    zh: '如果可见工具不能明确覆盖请求，应先按用户目标调用 `DiscoverTools`。若当前页没有目标，应按 `next_cursor` 继续翻页，直到找到或隐藏目录耗尽后，才能判断某项能力不可用。如果 `restart_required` 为 true，说明注册目录已变化，应丢弃游标重新开始。',
  },
  {
    tools: ['FileRead', 'FileWrite', 'FileEdit', 'Glob', 'Grep', 'ListDir', 'ApplyPatch', 'NotebookEdit'],
    en: 'Read existing files before editing. Use dedicated file/search tools instead of shell search or `sed -i`; make small, reviewable edits. Parallelize only proven-independent reads under the accuracy-first rule above.',
    zh: '编辑前先读现有文件。文件搜索和修改优先使用专用工具，不用 shell 搜索或 `sed -i`；改动保持小而可审查。只有明确满足上述准确性优先判据的读取才可并行。',
  },
  {
    tools: ['Bash'],
    en: 'Use non-interactive, deterministic shell commands, set reasonable timeouts, quote paths with spaces, and do not run destructive operations without authorization.',
    zh: 'Shell 命令保持非交互、确定性并设置合理 timeout；包含空格的路径要引用，未经授权不要执行破坏性操作。',
  },
  {
    tools: ['TodoWrite'],
    en: 'For non-trivial multi-step work, write a brief visible plan and call `TodoWrite` in the same assistant response as the first necessary work-tool call only when its arguments and safety do not depend on another result. Start with the smallest such call; do not speculative-batch the investigation or stop after planning unless user input genuinely blocks the first step.',
    zh: '非平凡多步骤任务先写简短可见计划。只有第一个工作工具调用已经确定有必要，且其参数和安全性都不依赖其他结果时，才在同一个 assistant response 中把它与 `TodoWrite` 一起发出；先执行满足条件的最小调用，不要推测性批量展开调查。只有用户信息确实阻塞第一步时才在规划后停下。',
  },
  {
    tools: ['SpawnAgent', 'PromptAgent', 'WaitAgent', 'CloseAgent', 'ListAgents'],
    en: 'Delegate only independent, bounded work. Keep ownership in the parent. After PromptAgent queues follow-up work, call WaitAgent in the same parent turn and collect the reply before ending. If a bounded wait times out, wait again with a larger bound unless the agent is stale/stalled. Relay the reply or continue the dependent work, then close the sub-agent when it is no longer needed.',
    zh: '只委派边界清晰且独立的工作。父级保留任务所有权。PromptAgent 排队后续工作后，必须在同一个父级 turn 调用 WaitAgent 并拿到回复再结束；有界等待超时后，除非 Agent 已 stale/stalled，否则使用更大上限继续等待；随后转述结果或继续依赖该结果的工作，不再需要时关闭子 Agent。',
  },
  {
    tools: ['ListTasks', 'ReadTaskLog', 'CancelTask'],
    en: 'Treat background tasks as live execution state, not memory facts. Inspect status or logs before retrying or cancelling work.',
    zh: '后台任务是实时执行状态，不是记忆事实。重试或取消前先检查状态或日志。',
  },
  {
    tools: ['RouteForward'],
    en: 'Use `RouteForward` for explicit VP-to-VP handoff; writing an @mention in ordinary text does not dispatch another VP.',
    zh: '显式 VP 转交必须使用 `RouteForward`；普通文本中的 @mention 不会调度另一个 VP。',
  },
  {
    tools: ['CreateWorkItem'],
    en: 'Use `CreateWorkItem` only for goals that need durable cross-turn coordination, recovery, review, waiting, or retry.',
    zh: '只有目标需要跨 turn 持久协调、恢复、评审、等待或重试时才使用 `CreateWorkItem`。',
  },
]);

function renderActiveToolGuidance(toolNames, language) {
  const active = new Set(Array.isArray(toolNames) ? toolNames : []);
  const lines = [];
  if (active.size > 0) {
    lines.push(language === 'zh'
      ? '- 准确性优先：先用能解决当前未知的最小定向调用。只有每个调用都已经确定有必要，且其参数和安全性都不依赖同批其他结果时，才在一个响应中发出多个工具调用；否则串行执行。不要推测性扇出、重复成功的读取/搜索，也不要默认抓取多个来源；先检查证据，再决定是否扩展。'
      : '- Accuracy first: start with the smallest targeted call that can resolve the current uncertainty. Issue multiple tool calls in one response only when every call is already necessary and its arguments and safety do not depend on another call\'s result. Otherwise run them sequentially. Do not fan out speculatively, repeat a successful read/search, or fetch multiple sources by default; inspect evidence before expanding.');
  }
  for (const group of TOOL_GUIDANCE_GROUPS) {
    if (!group.tools.some(name => active.has(name))) continue;
    lines.push(`- ${language === 'zh' ? group.zh : group.en}`);
  }
  return lines.join('\n');
}

/**
 * Render the VP identity block when the engine is running on behalf of an
 * addressed VP. The `persona` body from role.md is the only soul source;
 * frontmatter fields such as role/traits are metadata and must not synthesize
 * a second identity layer. If `persona` is empty, render only the heading.
 *
 * @param {object} vpPersona
 * @param {string} vpPersona.displayName
 * @param {string} [vpPersona.role]
 * @param {string} [vpPersona.roleZh]
 * @param {string} [vpPersona.persona]
 * @param {object} lang
 * @param {'en'|'zh'} effectiveLang
 * @returns {string}
 */
function renderVpPersona(vpPersona, lang, effectiveLang = 'en') {
  if (!vpPersona || typeof vpPersona !== 'object') return '';
  const name = selectVpPersonaName(vpPersona, effectiveLang);
  if (!name) return '';
  const body = selectVpPersonaBody(vpPersona, effectiveLang);
  const runtimePreamble = typeof vpPersona.runtimePreamble === 'string'
    ? vpPersona.runtimePreamble.trim() : '';

  // Persona is the IDENTITY layer (not an overlay). Do not prepend a
  // generic assistant identity here: the VP soul body is the source of truth.
  // `role` is intentionally not rendered as a second identity line; stock VPs
  // carry bilingual, role-aware soul text in role.md.
  const soulHeading = effectiveLang === 'zh' ? '## 灵魂' : '## Soul';
  const lines = [`# ${name}`, '', soulHeading];
  if (body) lines.push('', body);
  if (runtimePreamble) lines.push('', runtimePreamble);
  return lines.join('\n');
}

function selectVpPersonaName(vpPersona, effectiveLang) {
  if (effectiveLang === 'zh') {
    const zhName = typeof vpPersona.displayNameZh === 'string'
      ? vpPersona.displayNameZh.trim() : '';
    if (zhName) return zhName;
  }
  return typeof vpPersona.displayName === 'string' ? vpPersona.displayName.trim() : '';
}

function selectVpPersonaBody(vpPersona, effectiveLang) {
  const body = typeof vpPersona.persona === 'string' ? vpPersona.persona.trim() : '';

  // role.md is the canonical soul source. Stock legacy migration belongs in
  // seed-topup, not in prompt rendering; prompt rendering should only select
  // authored language sections when they are present.
  if (body && body.includes('<!-- lang:')) {
    const selected = extractExactLangSection(body, effectiveLang);
    return selected !== null ? selected : body;
  }
  return body;
}



function renderActiveScope(activeScope, lang) {
  if (!activeScope || typeof activeScope !== 'object') return '';

  const isZh = lang === PROMPTS.zh;
  const separator = isZh ? '：' : ': ';
  const lines = [];
  const session = typeof activeScope.sessionId === 'string' && activeScope.sessionId.trim()
    ? activeScope.sessionId.trim()
    : '';
  if (session) lines.push(`${lang.activeScopeSessionIdLabel}${separator}${session}`);

  const membersLine = renderSessionMembersLine(activeScope.sessionMembers || activeScope.members, isZh);
  if (membersLine) lines.push(`${lang.activeScopeMembersLabel}${separator}${membersLine}`);

  const topicsLine = renderSessionTopicsLine(activeScope.sessionTopics, isZh);
  if (topicsLine) lines.push(`${lang.activeScopeTopicsLabel}${separator}${topicsLine}`);

  const envLine = renderEnvelopeLine(activeScope.envelope, isZh);
  if (envLine) lines.push(`${lang.activeScopeEnvelopeLabel}${separator}${envLine}`);

  if (lines.length === 0) return '';

  return `${lang.activeScopeHeader}\n${lines.join('\n')}`;
}


function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function renderSessionMembersLine(members, useChineseSeparator = false) {
  return normalizeSessionMemberIds(members).join(useChineseSeparator ? '、' : ', ');
}

function renderSessionTopicsLine(topics, isZh = false) {
  const descriptions = [];
  const seen = new Set();
  for (const topic of normalizeSessionTopicIds(topics)) {
    const description = describeSessionTopic(topic, isZh);
    if (!description || seen.has(description)) continue;
    seen.add(description);
    descriptions.push(description);
  }
  return descriptions.join(isZh ? '；' : '; ');
}

function normalizeSessionTopicIds(topics) {
  if (!Array.isArray(topics)) return [];
  const clean = [];
  const seen = new Set();
  for (const topic of topics) {
    if (typeof topic !== 'string') continue;
    const id = topic.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    clean.push(id);
  }
  return clean;
}

function describeSessionTopic(topic, isZh = false) {
  const normalized = topic.toLowerCase().replace(/[_\s]+/g, '-');

  if (normalized.includes('dream') && normalized.includes('segments')) {
    return isZh
      ? '梦境记忆片段的抽取与整理'
      : 'Dream memory segment extraction and organization';
  }
  if (normalized.includes('dream') && normalized.includes('session') && normalized.includes('extraction')) {
    return isZh
      ? '梦境会话记忆的抽取质量'
      : 'Dream session-memory extraction quality';
  }
  if (normalized.includes('system-prompt') && normalized.includes('localization')) {
    return isZh
      ? '系统提示词的中英文一致性'
      : 'system prompt language localization';
  }
  if (normalized.includes('default-character') && normalized.includes('prompt-soul')) {
    return isZh
      ? '默认角色灵魂提示词的表达方式'
      : 'default persona soul prompt wording';
  }
  if (normalized.includes('prompt') && normalized.includes('soul')) {
    return isZh
      ? '角色灵魂提示词的表达方式'
      : 'persona soul prompt wording';
  }
  if (normalized.includes('openai-responses')) {
    return isZh
      ? 'Yeaft 的 OpenAI Responses 适配与模型配置'
      : 'Yeaft OpenAI Responses adapter and model configuration';
  }
  if (normalized.includes('model-config-isolation')) {
    return isZh
      ? 'Yeaft 的模型配置隔离'
      : 'Yeaft model configuration isolation';
  }
  if (normalized.includes('route-forward') || normalized.includes('handoff')) {
    return isZh
      ? 'Yeaft 的会话路由交接与可见性'
      : 'Yeaft session routing handoff and visibility';
  }
  if (normalized.includes('copilot-cli') || normalized.includes('chat-session')) {
    return isZh
      ? 'Copilot CLI 的聊天会话行为'
      : 'Copilot CLI chat session behavior';
  }
  if (normalized.includes('claude-opus')) {
    return isZh
      ? 'Yeaft 的 Claude Opus 模型接入'
      : 'Yeaft Claude Opus model integration';
  }
  if (normalized.includes('pr-workflow')) {
    return isZh
      ? '项目的 PR review、merge 和 tag 发布流程'
      : 'project PR review, merge, and tag release workflow';
  }
  if (/\bpr[-/]?\d+\b/.test(normalized) || normalized.includes('release') || /v\d+\.\d+\.\d+/.test(normalized)) {
    return isZh
      ? '最近的 PR 修复、review、merge 和 tag 发布流程'
      : 'recent PR fixes, review, merge, and tag release work';
  }
  if (normalized.includes('active-scope')) {
    return isZh
      ? '当前会话上下文的提示词呈现'
      : 'current session context prompt rendering';
  }
  if (normalized.includes('prompt') || normalized.includes('system')) {
    return isZh
      ? '近期的系统提示词调整'
      : humanizeTopicSlug(topic, false) || 'recent system prompt work';
  }
  if (normalized.includes('dream')) {
    return isZh
      ? '近期的 Dream 记忆维护工作'
      : humanizeTopicSlug(topic, false) || 'recent Dream memory work';
  }
  if (normalized.includes('session')) {
    return isZh
      ? '近期的会话上下文调整'
      : humanizeTopicSlug(topic, false) || 'recent session context work';
  }

  if (isZh) return '近期的项目协作事项';
  return humanizeTopicSlug(topic, false) || 'recent session collaboration topics';
}

function humanizeTopicSlug(topic, isZh = false) {
  if (isZh) return '';
  const words = topic
    .replace(/[\/_-]+/g, ' ')
    .replace(/\bv\d+(?:\.\d+)+\b/gi, '')
    .replace(/\bpr\s*\d+\b/gi, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '';

  const normalizedWords = words.map(word => {
    const lower = word.toLowerCase();
    if (lower === 'yeaft') return 'Yeaft';
    if (lower === 'project') return 'project';
    if (lower === 'config') return 'configuration';
    if (lower === 'isolation') return 'isolation';
    if (lower === 'rendering') return 'rendering';
    if (lower === 'workflow') return 'workflow';
    if (lower === 'session') return 'session';
    if (lower === 'context') return 'context';
    return word;
  });

  return normalizedWords.join(' ');
}

function normalizeSessionMemberIds(members) {
  if (!Array.isArray(members)) return [];
  const clean = [];
  const seen = new Set();
  for (const member of members) {
    if (typeof member !== 'string') continue;
    const id = member.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    clean.push(id);
  }
  return clean;
}

function renderMultiVpRouting(activeScope, lang) {
  if (!activeScope || typeof activeScope !== 'object') return '';
  const ownId = firstNonEmptyString(activeScope.sessionMember, activeScope.vpId);
  const members = normalizeSessionMemberIds(activeScope.sessionMembers || activeScope.members);
  const peers = ownId ? members.filter((member) => member !== ownId) : members;
  if (peers.length === 0) return '';

  const header = lang.multiVpRoutingHeader || '## multi_vp_routing';
  if (lang === PROMPTS.zh) {
    return [
      header,
      `当前 VP: ${ownId || 'unknown'}`,
      `可转发 VP: ${peers.join(', ')}`,
      '- 多 VP session 中，先主动感知这些 VP 的职责；不要假装只有你一个人在场。',
      '- 当用户点名其他会话成员、任务明显属于其他会话成员、需要并行协作，或你需要另一个会话成员继续处理时，必须调用 `route_forward`。',
      '- VP 自己写 @mention 不会触发路由；只有 `route_forward` 工具会真正把任务交给目标 VP。',
      '- 如果要多人一起处理，调用 `route_forward`，`to` 可填目标 vpId 或 `all`；`text` 要包含明确任务和必要上下文。',
    ].join('\n');
  }

  return [
    header,
    `Current VP: ${ownId || 'unknown'}`,
    `Forwardable VPs: ${peers.join(', ')}`,
    '- In a multi-VP session, actively notice these peers and their likely responsibilities; do not behave as if you are alone.',
    '- When the user names another VP, the task clearly belongs to another VP, parallel collaboration is needed, or another VP should continue the work, you MUST call `route_forward`.',
    '- VP-written @mentions do not route anything; only the `route_forward` tool performs a real hand-off.',
    '- For multi-person work, call `route_forward` with a target vpId or `all`; include the concrete task and required context in `text`.',
  ].join('\n');
}

/**
 * Render a one-line envelope summary. Pulls the small set of routing
 * fields we surface to the LLM (sender, intent, originating user) and
 * leaves the rest in AMS. Returns '' when the envelope carries no
 * useful signal.
 *
 * @param {object|null|undefined} envelope
 * @returns {string}
 */
function renderEnvelopeLine(envelope, isZh = false) {
  if (!envelope || typeof envelope !== 'object') return '';
  const segments = [];
  const fromVp = typeof envelope.fromVpId === 'string' && envelope.fromVpId.trim()
    ? envelope.fromVpId.trim()
    : (typeof envelope.senderVpId === 'string' ? envelope.senderVpId.trim() : '');
  if (fromVp) segments.push(`${isZh ? '来自' : 'from'}=${fromVp}`);
  const fromUser = typeof envelope.fromUserId === 'string' && envelope.fromUserId.trim()
    ? envelope.fromUserId.trim()
    : '';
  if (fromUser) segments.push(`${isZh ? '用户' : 'user'}=${fromUser}`);
  const intent = typeof envelope.intent === 'string' && envelope.intent.trim()
    ? envelope.intent.trim()
    : '';
  if (intent) segments.push(`${isZh ? '意图' : 'intent'}=${intent}`);
  return segments.join(' ');
}

// ─── Phase 1: Worker / Router prompt splits ──────────────────────
//
// DESIGN.md (multi-VP redesign) describes two distinct prompt shapes:
//
//   • Worker prompt — what a VP sees when it executes a turn. The
//     DESIGN-PROMPT v1 refactor collapsed the previous A/B/C/D layered
//     shape into a single AMS-driven Memory block: AMS Resident now
//     carries Layer-A summaries + UserProfile + CoreMemory, AMS OnDemand
//     carries the per-turn FTS hits. The worker shape that survives is:
//       harness/worker-shape   — optional descriptive metadata
//       buildSystemPrompt(...) — ① Identity ② Rules ③ Memory ④ Active Scope
//       optional taskScope/turnScope — caller-provided pass-through strings
//     `renderLayerASummaries` is no longer called inside the worker prompt
//     because AMS already renders the same summaries — calling both was
//     the duplicate-render bug DESIGN-PROMPT §6.1 #2 set out to fix.
//
//   • Router prompt — what the per-VP Router sees before it decides
//     plans[]. This is a separate, smaller LLM call that does not run
//     AMS, so it still uses `renderLayerASummaries` directly to surface
//     the three Layer-A summaries inline.

const LAYER_A_HEADERS = {
  en: {
    user: '## summary_user',
    session: '## summary_session',
    vp: '## summary_vp',
  },
  zh: {
    user: '## 用户总结',
    session: '## 会话总结',
    vp: '## VP 总结',
  },
};

/**
 * Render Layer A's three rolling summaries (user / session / vp). Each is
 * optional; missing or empty strings are skipped.
 *
 * Used by the Router prompt path only — the Worker prompt path receives
 * the same summaries through AMS Resident (see DESIGN-PROMPT §3 ③) and
 * MUST NOT call this in addition.
 *
 * @param {{user?: string, session?: string, group?: string, vp?: string}} summaries — `group` is a legacy alias for `session`.
 * @param {'en'|'zh'} language
 * @returns {string} concatenated block ('' when nothing to render)
 */
export function renderLayerASummaries(summaries, language = 'en') {
  if (!summaries || typeof summaries !== 'object') return '';
  const effectiveLang = normalizePromptLanguage(language);
  const headers = LAYER_A_HEADERS[effectiveLang] || LAYER_A_HEADERS.en;
  const out = [];
  const sessionSummary = typeof summaries.session === 'string'
    ? summaries.session.trim()
    : (typeof summaries.group === 'string' ? summaries.group.trim() : '');
  const entries = [
    ['user', typeof summaries.user === 'string' ? summaries.user.trim() : ''],
    ['session', sessionSummary],
    ['vp', typeof summaries.vp === 'string' ? summaries.vp.trim() : ''],
  ];
  for (const [key, body] of entries) {
    if (!body) continue;
    out.push(`${headers[key]}\n${body}`);
  }
  return out.join('\n\n');
}

/**
 * Worker prompt entry point.
 *
 * Output sections (DESIGN-PROMPT §3 layered concepts):
 *   harness/worker-shape (optional)   — descriptive metadata
 *   buildSystemPrompt(...)             — ① Identity ② Rules ③ Memory ④ Active Scope
 *
 * Earlier task-322 / task-334e variants accepted `taskScope` and
 * `turnScope` pass-through strings so callers could append their own
 * scope blocks. DESIGN-PROMPT v1 retired that surface — Active Scope is
 * now structured (`activeScope: { sessionId, vpId, envelope }`) and
 * rendered by `buildSystemPrompt` itself. Both pass-through params
 * had zero remaining callers when v1 landed; removing them prevents the
 * "two ways to describe scope" drift §1 set out to eliminate.
 *
 * @param {{
 *   language?: 'en'|'zh',
 *   includeShape?: boolean,
 *   ...rest: import('./prompts.js').buildSystemPrompt
 * }} params
 * @returns {string}
 */
export function buildWorkerPrompt(params = {}) {
  const {
    language = 'en',
    includeShape = true,
    ...rest
  } = params;
  const effectiveLang = normalizePromptLanguage(language);

  const parts = [];

  // Optional harness — describes the layered shape.
  if (includeShape) {
    const shape = getTemplate('harnessWorkerShape', effectiveLang);
    if (shape) parts.push(shape);
  }

  // Identity + Rules + Memory + Active Scope (DESIGN-PROMPT §3).
  const baseBlock = buildSystemPrompt({ ...rest, language: effectiveLang });
  if (baseBlock) parts.push(baseBlock);

  return parts.join('\n\n');
}

/**
 * Render the previous turn's router plan as a `## prior_plan` block, so
 * the router can decide whether to extend it or start fresh
 * (DESIGN.md §9.15). Returns '' when there is no prior plan to render.
 *
 * @param {object|null|undefined} priorPlan
 * @param {'en'|'zh'} [language='en']
 * @returns {string}
 */
export function renderPriorPlan(priorPlan, language = 'en') {
  if (!priorPlan || typeof priorPlan !== 'object') return '';
  const effectiveLang = normalizePromptLanguage(language);
  const header = effectiveLang === 'zh' ? '## 上一轮 plan' : '## prior_plan';
  const lines = [];
  if (priorPlan.vpId) lines.push(`vpId: ${priorPlan.vpId}`);
  const fq = priorPlan.forwardQuery;
  if (fq && (fq.userOriginal || fq.intent)) {
    if (fq.intent) lines.push(`intent: ${fq.intent}`);
    if (fq.userOriginal) lines.push(`userOriginal: ${fq.userOriginal}`);
  }
  const pre = priorPlan.preselect;
  if (pre) {
    if (Array.isArray(pre.memoryPaths) && pre.memoryPaths.length) {
      lines.push(`memoryPaths: ${pre.memoryPaths.join(', ')}`);
    }
    if (Array.isArray(pre.taskIds) && pre.taskIds.length) {
      lines.push(`taskIds: ${pre.taskIds.join(', ')}`);
    }
  }
  if (priorPlan.thinking) lines.push(`thinking: ${priorPlan.thinking}`);
  if (!lines.length) return '';
  return `${header}\n${lines.join('\n')}`;
}

/**
 * Router prompt entry point (DESIGN.md Phase 1).
 *
 * The Router sees identity context (no persona — it speaks as a routing
 * brain, not as any specific VP), the three Layer-A summaries, and a
 * `routerContext` block prepared upstream (group roster, recent turns,
 * pending tasks). Output schema is enforced by the harness fragment.
 *
 * @param {{
 *   language?: 'en'|'zh',
 *   summaries?: {user?: string, session?: string, group?: string, vp?: string},
 *   routerContext?: string,
 *   priorPlan?: object|null,
 *   includeShape?: boolean,
 * }} params
 * @returns {string}
 */
export function buildRouterPrompt(params = {}) {
  const { language = 'en', summaries, routerContext, priorPlan, includeShape = true } = params;
  const effectiveLang = normalizePromptLanguage(language);
  const parts = [];

  if (includeShape) {
    const shape = getTemplate('harnessRouterShape', effectiveLang);
    if (shape) parts.push(shape);
  }

  const summaryBlock = renderLayerASummaries(summaries, effectiveLang);
  if (summaryBlock) parts.push(summaryBlock);

  const priorBlock = renderPriorPlan(priorPlan, effectiveLang);
  if (priorBlock) parts.push(priorBlock);

  if (typeof routerContext === 'string' && routerContext.trim()) {
    parts.push(routerContext.trim());
  }

  return parts.join('\n\n');
}

