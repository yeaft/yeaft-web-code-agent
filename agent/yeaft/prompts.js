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
import { DEFAULT_VPS } from './vp/seed-defaults.js';

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
  return getTemplate('planInstruction', normalizePromptLanguage(language));
}

// ─── Prompt Templates (hardcoded fallbacks) ──────────────────────

const PROMPTS = {
  en: {
    identity: 'No VP soul is active for this turn. Participate in the current session with grounded, evidence-based answers and preserve the user\'s context.',
    date: (d) => `Date: ${d}`,
    dream: 'You are in dream mode. Reflect on past conversations and consolidate memories.',
    tools: (names) => `Available tools: ${names}`,
    // DESIGN-PROMPT §3 ④ — Active Scope header
    activeScopeHeader: '## active_scope',
    multiVpRoutingHeader: '## multi_vp_routing',
    sessionAnnouncementHeader: '[Session Announcement]',
    // Project-doc (CLAUDE.md / AGENTS.md) header + one-liner intro. Both
    // filenames are recognized: CLAUDE.md is this project's convention,
    // AGENTS.md is the cross-tool convention (Codex / OpenAI Codex CLI).
    projectDocHeader: '[Project Doc]',
    projectDocIntro:
      'The user keeps project-level instructions and context in `CLAUDE.md` or `AGENTS.md` at the session working directory. Treat the content below as authoritative project context — coding conventions, task guidance, workflow rules, etc.',
  },
  zh: {
    identity: '当前回合没有激活 VP soul。你在当前 session 中参与协作，回答要基于证据，并保持用户上下文。',
    date: (d) => `日期：${d}`,
    dream: '你处于梦境模式。回顾过去的对话，整理和巩固记忆。',
    tools: (names) => `可用工具：${names}`,
    // DESIGN-PROMPT §3 ④ — Active Scope header
    activeScopeHeader: '## active_scope',
    multiVpRoutingHeader: '## multi_vp_routing',
    sessionAnnouncementHeader: '[会话公告]',
    // 项目文档块：CLAUDE.md / AGENTS.md（与 Codex 通用命名兼容）。
    projectDocHeader: '[项目文档]',
    projectDocIntro:
      '用户把项目级的说明和上下文记录在 session 工作目录下的 `CLAUDE.md` 或 `AGENTS.md` 中。下面的内容是权威的项目上下文 —— 编码规范、任务指导、工作流约定等，请遵循它来工作。',
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

  // ─── 1.5  Session Announcement (CLAUDE.md-style shared prefix) ───
  // When a session has set an announcement, every VP in the session sees it
  // near the top of the system prompt — before tools, memory, mode-specific
  // instructions. Empty/whitespace = no block emitted.
  const annText = (typeof sessionAnnouncement === 'string') ? sessionAnnouncement.trim() : '';
  if (annText) {
    parts.push(`${lang.sessionAnnouncementHeader || '[Session Announcement]'}\n${annText}`);
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

  // Persona is the IDENTITY layer (not an overlay). Do not prepend a
  // generic assistant identity here: the VP soul body is the source of truth.
  // `role` is intentionally not rendered as a second identity line; stock VPs
  // carry bilingual, role-aware soul text in role.md.
  const soulHeading = effectiveLang === 'zh' ? '## 灵魂' : '## Soul';
  const lines = [`# ${name}`, '', soulHeading];
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

function normalizePersonaBodyForMatch(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function selectMigratedStockPersonaBody(vpPersona, body, effectiveLang) {
  const vpId = typeof vpPersona?.vpId === 'string' ? vpPersona.vpId.trim() : '';
  const persistedBody = normalizePersonaBodyForMatch(body);
  if (!vpId || !persistedBody) return null;

  const stock = DEFAULT_VPS.find(vp => vp.vpId === vpId);
  if (!stock) return null;

  const acceptedBodies = [
    stock.legacyPersonaEn,
    stock.legacyPersona,
    stock.personaEn,
    ...(Array.isArray(stock.legacyPersonas) ? stock.legacyPersonas : []),
  ]
    .map(normalizePersonaBodyForMatch)
    .filter(Boolean);

  if (!acceptedBodies.includes(persistedBody)) return null;
  const selected = effectiveLang === 'zh' ? stock.personaZh : stock.personaEn;
  return normalizePersonaBodyForMatch(selected) || null;
}

function selectVpPersonaBody(vpPersona, effectiveLang) {
  const body = typeof vpPersona.persona === 'string' ? vpPersona.persona.trim() : '';

  // role.md persona is the canonical soul. Exact stock legacy bodies are mapped
  // to the current authored source so old seeded role.md files do not leak
  // bilingual/English souls into localized system prompts before top-up runs.
  if (body) {
    const migratedStockBody = selectMigratedStockPersonaBody(vpPersona, body, effectiveLang);
    if (migratedStockBody) return migratedStockBody;

    if (body.includes('<!-- lang:')) {
      const selected = extractExactLangSection(body, effectiveLang);
      return selected !== null ? selected : body;
    }
    return body;
  }

  return '';
}



function renderActiveScope(activeScope, lang) {
  if (!activeScope || typeof activeScope !== 'object') return '';

  const lines = [];
  const session = typeof activeScope.sessionId === 'string' && activeScope.sessionId.trim()
    ? activeScope.sessionId.trim()
    : '';
  if (session) lines.push(`session_id: ${session}`);

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
  return normalizeSessionMemberIds(members).join(', ');
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

