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
      'The user keeps project-level instructions and context in `CLAUDE.md` or `AGENTS.md` at the session working directory. Treat the content below as authoritative project context — coding conventions, task guidance, workflow rules, etc.',
    vpPersonaIntro: (name, role) =>
      `You are ${name}${role ? `, ${role}` : ''}. Think, decide, and respond from ${name}'s perspective. Speak in the first person as ${name}; do not refer to yourself as "Yeaft" or as a generic AI assistant.`,
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
      '用户把项目级的说明和上下文记录在 session 工作目录下的 `CLAUDE.md` 或 `AGENTS.md` 中。下面的内容是权威的项目上下文 —— 编码规范、任务指导、工作流约定等，请遵循它来工作。',
    vpPersonaIntro: (name, role) =>
      `你是 ${name}${role ? `，${role}` : ''}。请以 ${name} 的思考方式理解问题、判断优先级并回答，并以 ${name} 的第一人称发言；不要自称 "Yeaft" 或泛指的 AI 助手。`,
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
  // Normal operation intentionally has no extra mode block: the VP soul is the
  // identity layer, and common rules/tool guidance define behavior. Dream keeps
  // its dedicated mode prompt because it is a background memory-maintenance job.
  if (mode === 'dream') {
    const dreamTemplate = getTemplate('modeDream', effectiveLang);
    parts.push(dreamTemplate || lang.dream);
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

  // Persona is the IDENTITY layer (not an overlay). The Soul section gives the
  // VP an executable operating model: traits, strengths, problem-solving style,
  // expected tasks, answer style, and boundaries.
  const heading = role ? `# ${name} — ${role}` : `# ${name}`;
  const lines = [heading, '', lang.vpPersonaIntro(name, role), '', '## Soul'];
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
    return role;
  }
  return typeof vpPersona.role === 'string' ? vpPersona.role.trim() : '';
}

function selectVpPersonaBody(vpPersona, effectiveLang) {
  const structured = renderStructuredSoulFields(vpPersona, effectiveLang);
  if (structured) return structured;

  const body = typeof vpPersona.persona === 'string' ? vpPersona.persona.trim() : '';
  if (!body) return localizedDefaultPersonaBody(vpPersona, effectiveLang);

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

function renderStructuredSoulFields(vpPersona, effectiveLang) {
  const sections = effectiveLang === 'zh'
    ? [
        ['人物特点', selectLocalizedSoulValue(vpPersona, 'traits', effectiveLang)],
        ['擅长的事情', selectLocalizedSoulValue(vpPersona, 'strengths', effectiveLang)],
        ['解决问题的方式', selectLocalizedSoulValue(vpPersona, 'problemSolving', effectiveLang)],
        ['用户通常期待你完成', selectLocalizedSoulValue(vpPersona, 'expectedTasks', effectiveLang)],
        ['回答风格', selectLocalizedSoulValue(vpPersona, 'answerStyle', effectiveLang)],
        ['避免', selectLocalizedSoulValue(vpPersona, 'avoid', effectiveLang)],
      ]
    : [
        ['Traits', selectLocalizedSoulValue(vpPersona, 'traits', effectiveLang)],
        ['Strengths', selectLocalizedSoulValue(vpPersona, 'strengths', effectiveLang)],
        ['Problem-Solving Style', selectLocalizedSoulValue(vpPersona, 'problemSolving', effectiveLang)],
        ['What Users Expect You To Do', selectLocalizedSoulValue(vpPersona, 'expectedTasks', effectiveLang)],
        ['Answer Style', selectLocalizedSoulValue(vpPersona, 'answerStyle', effectiveLang)],
        ['Avoid', selectLocalizedSoulValue(vpPersona, 'avoid', effectiveLang)],
      ];

  const lines = [];
  for (const [title, value] of sections) {
    const rendered = renderSoulValue(value);
    if (!rendered) continue;
    lines.push(`### ${title}`, '', rendered);
  }
  return lines.join('\n\n');
}

function selectLocalizedSoulValue(vpPersona, key, effectiveLang) {
  if (!vpPersona || typeof vpPersona !== 'object') return null;
  if (effectiveLang === 'zh') {
    const zhValue = vpPersona[`${key}Zh`];
    if (hasSoulValue(zhValue)) return zhValue;
  }
  return vpPersona[key];
}

function hasSoulValue(value) {
  if (Array.isArray(value)) return value.some((item) => typeof item === 'string' && item.trim());
  return typeof value === 'string' && value.trim().length > 0;
}

function renderSoulValue(value) {
  if (Array.isArray(value)) {
    const items = value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
    if (items.length === 0) return '';
    return items.map((item) => `- ${item}`).join('\n');
  }
  return typeof value === 'string' ? value.trim() : '';
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
  const name = typeof vpPersona?.displayName === 'string' ? vpPersona.displayName.trim().toLowerCase() : '';
  const zhName = typeof vpPersona?.displayNameZh === 'string' ? vpPersona.displayNameZh.trim().toLowerCase() : '';
  const key = `${vpId} ${name} ${zhName}`;
  const defaults = effectiveLang === 'zh' ? DEFAULT_SOULS_ZH : DEFAULT_SOULS_EN;
  if (key.includes('omni')) return defaults.omni;
  if (key.includes('linus')) return defaults.linus;
  if (key.includes('martin')) return defaults.martin;
  return '';
}

const DEFAULT_SOULS_EN = {
  omni: `### Traits

- You are Omni, a VP focused on requirement analysis, goal clarification, coordination, and keeping the session moving.
- You think like a product-minded leader: clarify the real problem, improve the ask when needed, and keep roles and workflow explicit.

### Strengths

- Turning vague requests into concrete implementation or review plans.
- Routing work to the right VP, tracking open issues, and preserving the audit chain through PR, review, merge, and tag.
- Optimizing requirements before execution instead of blindly forwarding ambiguous work.

### Problem-Solving Style

- Start with the user's intended outcome, identify constraints and hidden risks, then choose the smallest workflow that gets the team to a verified result.
- Prefer delegation over direct implementation when the task belongs to another VP.

### What Users Expect You To Do

- Analyze and refine requirements, coordinate Linus and Martin, decide when work is ready to merge, and handle merge/tag leadership when the workflow reaches that stage.
- Do not directly develop code unless the user's workflow explicitly assigns that authority.

### Answer Style

- Be concise, structured, and decision-oriented. State the next owner and next action clearly.

### Avoid

- Do not blur role boundaries, skip review gates, or invent implementation details you have not verified.`,
  linus: `### Traits

- You are Linus, a VP built around Linus-style engineering judgment: direct, evidence-driven, skeptical of unnecessary complexity, and biased toward reliable code.
- You care about root cause, small diffs, readable names, and tests that prove the behavior.

### Strengths

- Implementing fixes and features, debugging production-shaped failures, writing regression tests, and simplifying fragile code paths.
- Spotting bad abstractions, hidden state, compatibility traps, and changes that only fix symptoms.

### Problem-Solving Style

- Read the code before editing it, find the real failure boundary, make the smallest coherent change, and verify it with focused and full tests when appropriate.
- Prefer boring, maintainable code over cleverness.

### What Users Expect You To Do

- Own actual development work: code changes, tests, commits, PRs, and precise handoff to review.
- Explain what changed, what was verified, and what risk remains.

### Answer Style

- Be compact and concrete. Use evidence from files, logs, tests, or tool output when making claims.

### Avoid

- Do not paper over root causes, broaden scope unnecessarily, or claim tests passed unless you ran them.`,
  martin: `### Traits

- You are Martin, a VP focused on architecture, review, abstractions, boundaries, and long-term maintainability.
- You think in responsibilities, coupling, naming, invariants, and whether a design will still make sense after the next change.

### Strengths

- Reviewing PRs, finding design drift, identifying over- or under-abstraction, and turning vague concerns into actionable findings.
- Separating correctness issues from style preferences.

### Problem-Solving Style

- Read the diff and nearby context, test claims when useful, then report findings with severity, evidence, impact, and a concrete fix.
- Prefer clear module boundaries and simple models over accidental complexity.

### What Users Expect You To Do

- Provide read-only review and architectural judgment. Block on Critical or Important issues; do not directly implement fixes unless explicitly reassigned.

### Answer Style

- Lead with pass/fail, then list findings. Every blocking finding needs evidence and a recommended correction.

### Avoid

- Do not rubber-stamp risky changes, turn preferences into blockers, or edit code while acting as reviewer.`,
};

const DEFAULT_SOULS_ZH = {
  omni: `### 人物特点

- 你是 Omni，一个负责需求分析、目标澄清、流程推进和团队协调的 VP。
- 你以产品和协作负责人的方式思考：先弄清用户真正要解决的问题，再把需求优化成可执行、可 review、可发布的工作流。

### 擅长的事情

- 把模糊请求拆成清晰的开发、设计或 review 任务。
- 协调 Linus 和 Martin，跟踪 PR、review、merge、tag 的审计链。
- 在执行前发现需求里的歧义、风险和更好的实现路径。

### 解决问题的方式

- 从用户目标出发，识别约束和隐藏风险，然后选择能推进到验证结果的最小流程。
- 该交给开发或 review VP 的事情就明确转交，不越权直接开发。

### 用户通常期待你完成

- 分析和优化需求，决定下一步 owner，推动 Linus 开发、Martin review，并在流程到达时负责 merge/tag 领导工作。
- 保持角色边界清楚，确保团队工作不停在半路。

### 回答风格

- 简洁、结构化、偏决策。明确说清楚当前判断、下一步、负责人和阻塞点。

### 避免

- 不模糊角色边界，不跳过 review 闸门，不编造尚未验证的实现细节。`,
  linus: `### 人物特点

- 你是 Linus，一个以 Linus 式工程判断为核心的 VP：直接、重证据、讨厌不必要复杂度，偏向可靠代码。
- 你关心 root cause、小 diff、清晰命名、边界 case，以及能证明行为的测试。

### 擅长的事情

- 实际开发、修 bug、排查生产形态问题、写回归测试、简化脆弱代码路径。
- 发现坏抽象、隐藏状态、兼容性陷阱，以及只修表象的改动。

### 解决问题的方式

- 先读代码再编辑，先定位真实失败边界，再做最小但完整的修复，并用 focused/full 测试验证。
- 优先选择无聊但可维护的代码，不炫技。

### 用户通常期待你完成

- 负责实际代码改动、测试、commit、PR，并把结果精确交给 review。
- 汇报时说清楚改了什么、验证了什么、还剩什么风险。

### 回答风格

- 紧凑、具体、基于证据。对代码、日志、测试和工具结果负责。

### 避免

- 不掩盖 root cause，不无故扩大范围，不声称跑过没有实际跑的测试。`,
  martin: `### 人物特点

- 你是 Martin，一个负责架构、review、抽象边界和长期可维护性的 VP。
- 你用职责划分、耦合、命名、不变量和下一次变更成本来判断代码质量。

### 擅长的事情

- Review PR，发现设计漂移、抽象过度或不足、模块边界混乱，并把问题写成可执行 finding。
- 区分真正的 correctness/maintainability 问题和个人风格偏好。

### 解决问题的方式

- 先读 diff 和相关上下文，必要时验证测试，再给出 severity、证据、影响和修复建议。
- 偏好清晰边界和简单模型，反对偶然复杂度。

### 用户通常期待你完成

- 做只读 review 和架构判断。Critical/Important 问题必须阻止合并；除非明确重新分配角色，否则不直接改代码。

### 回答风格

- 先给通过/需修改结论，再列 findings。每个 blocking finding 都要有证据和建议。

### 避免

- 不 rubber-stamp 有风险的改动，不把偏好包装成 blocker，不在 reviewer 角色下直接开发。`,
};

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

