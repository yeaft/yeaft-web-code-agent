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
 *   ② Rules         — Session/Project instructions, date, runtime, and skills
 *   ③ Memory        — single block produced upstream by the AMS render
 *                     outlet and threaded through here as `memoryInjection`
 *   ④ Routing       — multi-VP identity and handoff metadata when applicable
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
 *   ② Rules         — Session/Project instructions, date, runtime, and skills
 *   ③ Memory        — Single block produced by the AMS render outlet
 *                     (callers pass it as `memoryInjection`).
 *   ④ Routing       — Multi-VP identity and handoff metadata when applicable
 *
 * Generic Session IDs, inferred topics, active-task labels, and repeated tool
 * guidance are intentionally omitted from the system prompt.
 *
 *   Multi-VP routing params:
 *   @param {object} [activeScope] — routing scope for this turn
 *   @param {string} [activeScope.vpId]              current VP identity
 *   @param {string[]} [activeScope.sessionMembers]  current Session roster
 *
 * @param {{
 *   language?: string,
 *   mode?: string,
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

  // ─── 4. Runtime Platform ─────────────────────────────
  // Tool schemas already carry their operational guidance. Repeating selected
  // tool instructions in the system prompt wastes tokens and can drift from
  // the executable schema, so only platform facts are rendered here.
  const runtimePlatformBlock = renderRuntimePlatformPrompt(runtimePlatform || getRuntimePlatformInfo(), effectiveLang);
  if (runtimePlatformBlock) {
    parts.push(runtimePlatformBlock);
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

  // ─── 7. Multi-VP routing ────────────────────────────────
  // Generic Session IDs, inferred topics, and live task labels are runtime
  // bookkeeping rather than model instructions. Keep only the routing block
  // whose peer identities and RouteForward contract affect model behaviour.
  const multiVpRoutingBlock = renderMultiVpRouting(activeScope, lang);
  if (multiVpRoutingBlock) parts.push(multiVpRoutingBlock);

  return parts.join('\n\n');
}

// ─── helpers ─────────────────────────────────────────────────────

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



function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
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
  const ownId = firstNonEmptyString(activeScope.vpId);
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
//       buildSystemPrompt(...) — ① Identity ② Rules ③ Memory ④ Routing
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
 *   buildSystemPrompt(...)             — ① Identity ② Rules ③ Memory ④ Routing
 *
 * Earlier variants accepted `taskScope` and `turnScope` pass-through
 * strings so callers could append their own scope blocks. That surface is
 * retired. `activeScope` now carries only the VP identity and Session roster
 * needed to render the deterministic multi-VP routing contract.
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

  // Identity + Rules + Memory + Routing (DESIGN-PROMPT §3).
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

