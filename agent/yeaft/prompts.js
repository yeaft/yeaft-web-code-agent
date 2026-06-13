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
 * The compact summary, user_profile, and core_memory blocks that used to
 * live inside the system prompt are GONE. Compact summary is now part of
 * the messages timeline; user_profile + core_memory have been folded into
 * AMS Resident.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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
  // Phase 8 wire-up: split-out fragments for the persona-as-identity path.
  // `identityYeaft` ships only when NO VP persona is active. `commonRules`
  // ships every turn (with persona OR with Yeaft identity) — it carries
  // output-format, code-editing, search, and frontend rules that are
  // identity-independent. base.md remains as a back-compat bundle so any
  // external snapshotter / test that reads the file directly keeps working.
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
  return getTemplate('planInstruction', language);
}

// ─── Prompt Templates (hardcoded fallbacks) ──────────────────────

const PROMPTS = {
  en: {
    identity: 'You are Yeaft, a helpful AI assistant.',
    date: (d) => `Date: ${d}`,
    dream: 'You are in dream mode. Reflect on past conversations and consolidate memories.',
    tools: (names) => `Available tools: ${names}`,
    // DESIGN-PROMPT §3 ④ — Active Scope header
    activeScopeHeader: '## active_scope',
    groupAnnouncementHeader: '[Group Announcement]',
    // Project-doc (CLAUDE.md / AGENTS.md) header + one-liner intro. Both
    // filenames are recognized: CLAUDE.md is this project's convention,
    // AGENTS.md is the cross-tool convention (Codex / OpenAI Codex CLI).
    projectDocHeader: '[Project Doc]',
    projectDocIntro:
      'The user keeps project-level instructions and context in `CLAUDE.md` or `AGENTS.md` at the group\'s working directory. Treat the content below as authoritative project context — coding conventions, task guidance, workflow rules, etc.',
    vpPersonaIntro: (name, role) =>
      `You ARE **${name}**${role ? ` (${role})` : ''}. Speak in the first person as ${name}; do not refer to yourself as "Yeaft" or as a generic AI assistant. The text below is your identity, expertise, and decision style.`,
  },
  zh: {
    identity: '你是 Yeaft，一个有用的 AI 助手。',
    date: (d) => `日期：${d}`,
    dream: '你处于梦境模式。回顾过去的对话，整理和巩固记忆。',
    tools: (names) => `可用工具：${names}`,
    // DESIGN-PROMPT §3 ④ — Active Scope header
    activeScopeHeader: '## active_scope',
    groupAnnouncementHeader: '[群组公告]',
    // 项目文档块：CLAUDE.md / AGENTS.md（与 Codex 通用命名兼容）。
    projectDocHeader: '[项目文档]',
    projectDocIntro:
      '用户把项目级的说明和上下文记录在群组工作目录下的 `CLAUDE.md` 或 `AGENTS.md` 中。下面的内容是权威的项目上下文 —— 编码规范、任务指导、工作流约定等，请遵循它来工作。',
    vpPersonaIntro: (name, role) =>
      `你就是 **${name}**${role ? `（${role}）` : ''}。请以 ${name} 的第一人称发言；不要自称 "Yeaft" 或泛指的 AI 助手。下面的文字是你的身份、专业方向与判断风格。`,
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
 *   projectDoc?: string,
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
  projectDoc = '',
} = {}) {
  // Normalize app locales like `zh-CN` to prompt dictionary/template keys.
  const effectiveLang = normalizePromptLanguage(language);
  const lang = PROMPTS[effectiveLang] || PROMPTS.en;

  const parts = [];

  // ─── 1. Core Identity ──────────────────────────────────
  // Phase 8 wire-up: when a VP persona is active, the persona body REPLACES
  // the Yeaft identity block (the LLM is that VP, not Yeaft pretending). When
  // there is no persona, fall back to the legacy Yeaft identity bundle.
  const personaBlock = renderVpPersona(vpPersona, lang, effectiveLang);
  if (personaBlock) {
    parts.push(personaBlock);
    // Common rules (output format, code editing, search, frontend) still
    // apply to every turn, regardless of which VP is speaking.
    const commonRules = getTemplate('commonRules', effectiveLang);
    if (commonRules) parts.push(commonRules);
  } else {
    const baseTemplate = getTemplate('base', effectiveLang);
    if (baseTemplate) {
      parts.push(baseTemplate);
    } else {
      parts.push(lang.identity);
    }
  }

  // ─── 1.4  Project Doc (CLAUDE.md / AGENTS.md from group workDir) ───
  // The group's working-directory may contain a project-level
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

  // ─── 1.5  Session Announcement (CLAUDE.md-style shared prefix) ───
  // When a session has set an announcement, every VP in the session sees it
  // near the top of the system prompt — before tools, memory, mode-specific
  // instructions. Empty/whitespace = no block emitted.
  const annText = (typeof sessionAnnouncement === 'string') ? sessionAnnouncement.trim() : '';
  if (annText) {
    parts.push(`${lang.groupAnnouncementHeader || '[Group Announcement]'}\n${annText}`);
  }

  // ─── 2. Date Metadata ──────────────────────────────────
  parts.push(lang.date(new Date().toISOString().split('T')[0]));

  // ─── 3. Mode-Specific Instructions ─────────────────────
  // task-297: single unified mode for all normal operation.
  // `dream` is retained for background memory maintenance.
  if (mode === 'dream') {
    const dreamTemplate = getTemplate('modeDream', effectiveLang);
    parts.push(dreamTemplate || lang.dream);
  } else {
    const unifiedTemplate = getTemplate('modeUnified', effectiveLang);
    if (unifiedTemplate) {
      parts.push(unifiedTemplate);
    }
  }

  // ─── 4. Tools + Tool Guidance ──────────────────────────
  if (toolNames.length > 0) {
    parts.push(lang.tools(toolNames.join(', ')));

    const toolGuidanceTemplate = getTemplate('toolGuidance', effectiveLang);
    if (toolGuidanceTemplate) {
      parts.push(toolGuidanceTemplate);
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

  return parts.join('\n\n');
}

// ─── helpers ─────────────────────────────────────────────────────

/**
 * Render the `## active_persona` block when the engine is running on
 * behalf of an addressed VP. Accepts `{ displayName, role?, persona }` —
 * `persona` is the body text from the VP's role.md (loaded by the engine
 * via readVp). When `persona` is empty we still emit the intro line so
 * the LLM at least knows whose voice to adopt; if even displayName is
 * missing we omit the whole block (no useful signal).
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
  const role = selectVpPersonaRole(vpPersona, effectiveLang);
  const body = selectVpPersonaBody(vpPersona, effectiveLang);

  // Phase 8 wire-up: persona is now the IDENTITY layer (not an overlay).
  // Emit a `# <name> — <role>` H1 so the prompt opens with the VP's name,
  // matching the legacy Yeaft identity shape but speaking as the VP. The
  // first-person imperative ("you ARE X") replaces the old soft overlay
  // language so the LLM does not slip back into Yeaft voice mid-turn.
  const heading = role ? `# ${name} — ${role}` : `# ${name}`;
  const lines = [heading, '', lang.vpPersonaIntro(name, role)];
  if (body) lines.push('', body);
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

function selectVpPersonaRole(vpPersona, effectiveLang) {
  if (effectiveLang === 'zh') {
    const zhRole = typeof vpPersona.roleZh === 'string' ? vpPersona.roleZh.trim() : '';
    if (zhRole) return zhRole;

    const role = typeof vpPersona.role === 'string' ? vpPersona.role.trim() : '';
    return hasCjk(role) ? role : '';
  }
  return typeof vpPersona.role === 'string' ? vpPersona.role.trim() : '';
}

function selectVpPersonaBody(vpPersona, effectiveLang) {
  const body = typeof vpPersona.persona === 'string' ? vpPersona.persona.trim() : '';
  if (!body) return '';

  if (body.includes('<!-- lang:')) {
    const selected = extractExactLangSection(body, effectiveLang);
    if (selected !== null) return selected;
    return localizedDefaultPersonaBody(vpPersona, effectiveLang);
  }

  if (effectiveLang === 'zh') {
    // role.md historically had one persisted persona body. Keep genuinely
    // Chinese bodies, but do not glue English-only or lightly bilingual seeded
    // personas under a Chinese wrapper. That is how "全能助手" ended up with a
    // Chinese heading followed by a large English behavior contract.
    if (isPrimarilyCjk(body)) return body;
    return localizedDefaultPersonaBody(vpPersona, effectiveLang);
  }

  if (hasCjk(body)) {
    const localized = localizedDefaultPersonaBody(vpPersona, effectiveLang);
    if (localized) return localized;
  }

  return body;
}

function hasCjk(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(String(text || ''));
}

function isPrimarilyCjk(text) {
  const value = String(text || '');
  const cjkCount = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) || []).length;
  if (cjkCount === 0) return false;
  const latinWordCount = (value.match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
  // CJK-heavy prose has many Han characters and few Latin words. Technical
  // terms like API/Markdown/JavaScript are fine; large English paragraphs are
  // not. The threshold is intentionally conservative: mixed seeded personas
  // should fall back to localized defaults instead of leaking English blocks.
  return cjkCount >= latinWordCount * 2;
}

function localizedDefaultPersonaBody(vpPersona, effectiveLang) {
  const vpId = typeof vpPersona?.vpId === 'string' ? vpPersona.vpId.trim().toLowerCase() : '';
  if (effectiveLang === 'zh' && vpId === 'omni') {
    return OMNI_PERSONA_ZH;
  }
  if (effectiveLang === 'en' && vpId === 'omni') {
    return OMNI_PERSONA_EN;
  }
  return '';
}

const OMNI_PERSONA_EN = `You are Omni Assistant, a cross-domain, execution-focused general AI partner.

## Language Policy

- Reply in the current user-configured language; use English for English configuration and Chinese for Chinese configuration.
- If the user explicitly asks to switch language, follow the user's request.

## Core Capabilities

- Cross-domain synthesis: handle writing, coding, product thinking, research, planning, analysis, learning, translation, troubleshooting, and creative work without forcing the user to pick a specialist first.
- Strong execution: when a task needs action, clarify only blocking unknowns, make a short plan, use available tools, produce the deliverable, and verify the result.
- Goal clarification: distinguish the user's real objective from the literal wording; state assumptions when moving forward without perfect information.
- Tool use and verification: inspect files, run commands, search sources, test code, or analyze data when the environment allows it. Never claim work was done unless it was actually done.
- Honest uncertainty: say "I'm not sure" when evidence is missing, then explain how to check.
- Safety boundaries: refuse illegal, dangerous, deceptive, privacy-invasive, or unauthorized requests. For medical, legal, financial, production, or destructive operations, give general guidance and call out risks.

## Decision and Response Style

- Start with the outcome the user needs, then choose the simplest path that can actually be completed and checked.
- Answer simple questions directly; break down and execute complex work.
- After execution tasks, briefly report only what changed, what was verified, and any risk or next step.
- Use concise, structured Markdown; avoid empty praise and false certainty.`;

const OMNI_PERSONA_ZH = `你是全能助手，一个跨领域、偏执行的通用 AI 伙伴。

## 语言策略

- 使用当前用户配置语言回复；中文配置下用中文，英文配置下用英文。
- 用户明确要求切换语言时，按用户要求执行。

## 核心能力

- 跨领域综合：处理写作、代码、产品、研究、规划、分析、学习、翻译、排障和创意任务，不强迫用户先选择专家。
- 强执行：任务需要行动时，只澄清真正阻塞的问题，制定短计划，使用可用工具，交付结果并验证。
- 目标澄清：区分用户真正目标和字面表达；信息不完整但可推进时，说明假设后继续。
- 工具与验证：环境允许时读取文件、运行命令、搜索资料、测试代码或分析数据；没有实际做过的事不要声称做过。
- 诚实不确定：证据不足时说“我不确定”，并说明如何检查。
- 安全边界：拒绝违法、危险、欺骗、侵犯隐私或未授权请求；医疗、法律、金融、生产和破坏性操作只给一般性建议并指出风险。

## 决策与回复风格

- 先给用户需要的结果，再选择能完成且能验证的最简单路径。
- 简单问题直接回答；复杂工作拆步执行。
- 执行类任务完成后只简要汇报：改了什么、验证了什么、风险或下一步。
- 使用简洁、结构化的 Markdown；避免空泛夸奖和假装确定。`;


/**
 * Render `## active_scope` block (DESIGN-PROMPT §3 ④).
 *
 * Active Scope is a structured, deterministic, bounded block telling the
 * LLM what scope the current turn lives in. It is NOT memory; long-form
 * scope content (decisions, history) flows through AMS — Active Scope
 * carries only IDs + tiny labels.
 *
 * Schema:
 *   ## active_scope
 *   session_id:      <sessionId>                    (omitted when missing)
 *   session_member:  <vpId>                         (omitted when missing)
 *   session_members: <vpId>, <vpId>                 (omitted when missing)
 *   session_topics:  <topic>, <topic>               (omitted when missing)
 *   envelope: from=<sender> intent=<intent>         (omitted when no envelope)
 *
 * Returns '' when the input has no useful field — we don't emit an empty
 * header. (`featureId`/`featureTitle` fields were removed 2026-05-13 along
 * with the rest of the Feature system; the JSDoc once described them.)
 *
 * @param {object} [activeScope]
 * @param {string} [activeScope.sessionId]
 * @param {string} [activeScope.sessionMember]
 * @param {string[]} [activeScope.sessionMembers]  current session roster
 * @param {string[]} [activeScope.sessionTopics]   bounded topic labels
 * @param {object} [activeScope.envelope]   inbound routing summary
 * @param {object} lang
 * @returns {string}
 */
function renderActiveScope(activeScope, lang) {
  if (!activeScope || typeof activeScope !== 'object') return '';

  const lines = [];
  const session = typeof activeScope.sessionId === 'string' && activeScope.sessionId.trim()
    ? activeScope.sessionId.trim()
    : '';
  if (session) lines.push(`session_id: ${session}`);

  const sessionMember = firstNonEmptyString(activeScope.sessionMember, activeScope.vpId);
  if (sessionMember) lines.push(`session_member: ${sessionMember}`);

  const membersLine = renderSessionMembersLine(activeScope.sessionMembers || activeScope.members);
  if (membersLine) lines.push(`session_members: ${membersLine}`);

  const topicsLine = renderSessionMembersLine(activeScope.sessionTopics);
  if (topicsLine) lines.push(`session_topics: ${topicsLine}`);

  const envLine = renderEnvelopeLine(activeScope.envelope);
  if (envLine) lines.push(`envelope: ${envLine}`);

  if (lines.length === 0) return '';

  return `${lang.activeScopeHeader}\n${lines.join('\n')}`;
}


function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function renderSessionMembersLine(members) {
  if (!Array.isArray(members)) return '';
  const clean = [];
  const seen = new Set();
  for (const member of members) {
    if (typeof member !== 'string') continue;
    const id = member.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    clean.push(id);
  }
  return clean.join(', ');
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
function renderEnvelopeLine(envelope) {
  if (!envelope || typeof envelope !== 'object') return '';
  const segments = [];
  const fromVp = typeof envelope.fromVpId === 'string' && envelope.fromVpId.trim()
    ? envelope.fromVpId.trim()
    : (typeof envelope.senderVpId === 'string' ? envelope.senderVpId.trim() : '');
  if (fromVp) segments.push(`from=${fromVp}`);
  const fromUser = typeof envelope.fromUserId === 'string' && envelope.fromUserId.trim()
    ? envelope.fromUserId.trim()
    : '';
  if (fromUser) segments.push(`user=${fromUser}`);
  const intent = typeof envelope.intent === 'string' && envelope.intent.trim()
    ? envelope.intent.trim()
    : '';
  if (intent) segments.push(`intent=${intent}`);
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
    group: '## summary_group',
    vp: '## summary_vp',
  },
  zh: {
    user: '## 用户总结',
    group: '## 群组总结',
    vp: '## VP 总结',
  },
};

/**
 * Render Layer A's three rolling summaries (user / group / vp). Each is
 * optional; missing or empty strings are skipped.
 *
 * Used by the Router prompt path only — the Worker prompt path receives
 * the same summaries through AMS Resident (see DESIGN-PROMPT §3 ③) and
 * MUST NOT call this in addition.
 *
 * @param {{user?: string, group?: string, vp?: string}} summaries
 * @param {'en'|'zh'} language
 * @returns {string} concatenated block ('' when nothing to render)
 */
export function renderLayerASummaries(summaries, language = 'en') {
  if (!summaries || typeof summaries !== 'object') return '';
  const effectiveLang = normalizePromptLanguage(language);
  const headers = LAYER_A_HEADERS[effectiveLang] || LAYER_A_HEADERS.en;
  const out = [];
  for (const key of ['user', 'group', 'vp']) {
    const body = typeof summaries[key] === 'string' ? summaries[key].trim() : '';
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
 *   summaries?: {user?: string, group?: string, vp?: string},
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

