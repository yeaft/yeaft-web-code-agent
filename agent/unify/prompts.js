/**
 * prompts.js — Bilingual system prompt templates
 *
 * Single source of truth for system prompts. Both engine.js and cli.js
 * import buildSystemPrompt() from here. Supports 'en' and 'zh'.
 *
 * Template files from agent/unify/templates/ are loaded once at startup
 * and used to enrich the system prompt beyond the hardcoded fallbacks.
 *
 * Concept layering (DESIGN-PROMPT §3):
 *   ① Identity      — VP persona body (or Yeaft fallback)
 *   ② Rules         — group announcement, date, mode template, tools,
 *                     tool-guidance, skills, common rules
 *   ③ Memory        — single block produced upstream by the AMS render
 *                     outlet and threaded through here as `memoryInjection`
 *   ④ Active Scope  — structured per-turn scope summary
 *                     (feature / group / vp / envelope IDs)
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

  const marker = `<!-- lang:${language} -->`;
  const markerIdx = content.indexOf(marker);

  if (markerIdx === -1) {
    // No marker for this language — if language is 'zh', try 'en' fallback
    if (language === 'zh') {
      const enMarker = '<!-- lang:en -->';
      const enIdx = content.indexOf(enMarker);
      if (enIdx !== -1) {
        // Has en marker but no zh — return en section as fallback
        return extractLangSection(content, 'en');
      }
    }
    // No markers at all — return full content
    if (!content.includes('<!-- lang:')) return content;
    // Has markers but not for this language — fallback to en
    return extractLangSection(content, 'en');
  }

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

// ─── Prompt Templates (hardcoded fallbacks) ──────────────────────

const PROMPTS = {
  en: {
    identity: 'You are Yeaft, a helpful AI assistant.',
    date: (d) => `Date: ${d}`,
    dream: 'You are in dream mode. Reflect on past conversations and consolidate memories.',
    tools: (names) => `Available tools: ${names}`,
    // task-334e — task-context section header (sub-block of Active Scope)
    taskCtxHeader: '## task_ctx',
    taskCtxRelatedHeader: '### related tasks',
    taskCtxSummaryReminder: (min, count) =>
      `💡 ${min}min since last summary (+${count} new messages). Consider calling \`task_summary_post\`.`,
    // DESIGN-PROMPT §3 ④ — Active Scope header
    activeScopeHeader: '## active_scope',
    groupAnnouncementHeader: '[Group Announcement]',
    vpPersonaIntro: (name, role) =>
      `You ARE **${name}**${role ? ` (${role})` : ''}. Speak in the first person as ${name}; do not refer to yourself as "Yeaft" or as a generic AI assistant. The text below is your identity, expertise, and decision style.`,
  },
  zh: {
    identity: '你是 Yeaft，一个有用的 AI 助手。',
    date: (d) => `日期：${d}`,
    dream: '你处于梦境模式。回顾过去的对话，整理和巩固记忆。',
    tools: (names) => `可用工具：${names}`,
    // task-334e — task-context section header (sub-block of Active Scope)
    taskCtxHeader: '## task_ctx',
    taskCtxRelatedHeader: '### 相关任务',
    taskCtxSummaryReminder: (min, count) =>
      `💡 距上次 summary 已过 ${min}min，新增 ${count} 条消息，建议调用 \`task_summary_post\`。`,
    // DESIGN-PROMPT §3 ④ — Active Scope header
    activeScopeHeader: '## active_scope',
    groupAnnouncementHeader: '[群组公告]',
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
 *   ② Rules         — Group announcement, date, mode, tools, guidance, skills
 *   ③ Memory        — Single block produced by the AMS render outlet
 *                     (callers pass it as `memoryInjection`).
 *   ④ Active Scope  — Structured per-turn scope summary
 *                     (feature / group / vp / envelope IDs).
 *   (Task context lives inside Active Scope; the previous standalone
 *    user_profile / core_memory blocks are gone — those signals now
 *    arrive through AMS Resident.)
 *
 * task-334e taskCtx is preserved as a sub-block of Active Scope:
 *   @param {object} [taskCtx] — per-task context
 *   @param {string} [taskCtx.taskId]
 *   @param {string} [taskCtx.currentVpId] — used for ACL + initiator check
 *   @param {string} [taskCtx.initiatorVpId] — task initiator VP id
 *   @param {Array<{body:string, shard?:string}>} [taskCtx.memories] — task-memory top-5
 *   @param {Array<{id:string, title?:string, members?:string[], updatedAt?:number,
 *                  memories?:Array<{body:string, shard?:string}>}>} [taskCtx.relatedTasks]
 *          — related tasks; we take top-3 by updatedAt desc, top-2 mem each,
 *            ACL-gated (members must include currentVpId)
 *   @param {object} [taskCtx.summaryReminder]
 *   @param {number} [taskCtx.summaryReminder.nonSummaryCount] — msgs since last summary
 *   @param {number} [taskCtx.summaryReminder.lastSummaryAt] — epoch ms (0/missing = never)
 *   @param {number} [taskCtx.summaryReminder.now] — override clock (tests), default Date.now()
 *
 *   Active Scope params (DESIGN-PROMPT §3 ④):
 *   @param {object} [activeScope] — structured scope summary for this turn
 *   @param {string|null} [activeScope.featureId]   currently active feature, or null
 *   @param {string} [activeScope.featureTitle]      short title for human display
 *   @param {string} [activeScope.groupId]
 *   @param {string} [activeScope.vpId]
 *   @param {object} [activeScope.envelope]          inbound routing info (sender, intent)
 *
 * @param {{
 *   language?: string,
 *   mode?: string,
 *   toolNames?: string[],
 *   memoryInjection?: string,
 *   skillContent?: string,
 *   taskCtx?: object,
 *   activeScope?: object,
 *   vpPersona?: object,
 *   groupAnnouncement?: string,
 * }} params
 * @returns {string}
 */
export function buildSystemPrompt({
  language = 'en',
  mode,
  toolNames = [],
  memoryInjection,
  skillContent,
  taskCtx,
  activeScope,
  vpPersona,
  groupAnnouncement = '',
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

  // ─── 1.5  Group Announcement (CLAUDE.md-style shared prefix) ───
  // When a group has set an announcement, every VP in the group sees it
  // near the top of the system prompt — before tools, memory, mode-specific
  // instructions. Empty/whitespace = no block emitted.
  const annText = (typeof groupAnnouncement === 'string') ? groupAnnouncement.trim() : '';
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
  // Structured per-turn scope summary. taskCtx is rendered as a
  // sub-block of Active Scope (when supplied), and the new
  // feature/group/vp/envelope identifiers are rendered as a leading
  // line.
  const activeScopeBlock = renderActiveScope(activeScope, lang);
  if (activeScopeBlock) parts.push(activeScopeBlock);

  const taskCtxBlock = renderTaskCtx(taskCtx, lang);
  if (taskCtxBlock) parts.push(taskCtxBlock);

  return parts.join('\n\n');
}

// ─── task-334e helpers ───────────────────────────────────────────

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
  if (effectiveLang === 'zh') {
    // role.md has one persisted persona body today. If that body is Chinese,
    // keep it. If it is English-only (the default seeded VP shape), do not glue
    // it under a Chinese wrapper and produce a half-translated system prompt.
    return hasCjk(body) ? body : '';
  }
  return body;
}

function hasCjk(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(String(text || ''));
}

const DEFAULT_TASK_MEMORY_TOP = 5;
const DEFAULT_RELATED_TASK_TOP = 3;
const DEFAULT_RELATED_TASK_MEMORY_TOP = 2;
// task-334n §Δ31.4 — tightened reminder gate:
//   (a) currentVpId === initiatorVpId
//   (b) task.members.length >= 2  (multi-VP only)
//   (c) nonSummaryCount >= 10  OR  (now - lastSummaryAt) >= 20 min
// 334e's earlier looser gate (3 msgs / 15 min) is preserved as a legacy
// fallback path for callers that never set `summaryReminder.members`.
const SUMMARY_REMINDER_MIN_MESSAGES = 3;
const SUMMARY_REMINDER_MIN_AGE_MS = 15 * 60 * 1000; // 15 minutes (legacy)
const SUMMARY_REMINDER_MIN_TURNS_334N = 10;
const SUMMARY_REMINDER_MIN_AGE_MS_334N = 20 * 60 * 1000; // 20 minutes
const SUMMARY_REMINDER_MIN_MEMBERS_334N = 2;

/**
 * Render `## task_ctx` block. Never throws on malformed input — missing
 * fields degrade to omission. The block is only emitted when at least one
 * of { memories, relatedTasks (post-ACL), summaryReminder } has content.
 */
function renderTaskCtx(taskCtx, lang) {
  if (!taskCtx || typeof taskCtx !== 'object') return '';

  const memLines = renderTaskMemories(taskCtx.memories);
  const relatedLines = renderRelatedTasks(
    taskCtx.relatedTasks,
    taskCtx.currentVpId,
    lang,
    taskCtx.groupId,
  );
  const reminderLine = renderSummaryReminder(taskCtx, lang);

  if (!memLines && !relatedLines && !reminderLine) return '';

  const out = [lang.taskCtxHeader];
  if (taskCtx.taskId) out.push(`taskId: ${taskCtx.taskId}`);
  if (memLines) out.push(memLines);
  if (relatedLines) out.push(relatedLines);
  if (reminderLine) out.push(reminderLine);
  return out.join('\n');
}

/** Render task-memory top-N bodies with `[shard]` prefix, no sourceRef. */
function renderTaskMemories(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return '';
  const lines = [];
  for (const m of memories.slice(0, DEFAULT_TASK_MEMORY_TOP)) {
    const body = typeof m?.body === 'string' ? m.body.trim() : '';
    if (!body) continue;
    const shard = typeof m?.shard === 'string' && m.shard.trim() ? m.shard.trim() : 'general';
    lines.push(`- [${shard}] ${body}`);
  }
  return lines.join('\n');
}

/**
 * Render `### related tasks` sub-block. §Δ31.4 ACL: a related task is only
 * included if `task.members` contains `currentVpId`. Missing `members` is
 * treated as private (excluded) — fail-closed.
 *
 * Ordering: by `updatedAt` desc (undefined treated as 0). Top-3 tasks, top-2
 * memory each.
 */
function renderRelatedTasks(relatedTasks, currentVpId, lang, currentTaskGroupId) {
  if (!Array.isArray(relatedTasks) || relatedTasks.length === 0) return '';
  if (!currentVpId) return ''; // no ACL subject → fail-closed

  const allowed = relatedTasks.filter((t) => {
    if (!t || typeof t !== 'object') return false;
    const members = Array.isArray(t.members) ? t.members : null;
    // task-334n §Δ27.3 — either same-group OR members-intersection grants.
    if (currentTaskGroupId && t.groupId && t.groupId === currentTaskGroupId) {
      return true;
    }
    if (!members) return false; // fail-closed on missing ACL
    return members.includes(currentVpId);
  });
  if (allowed.length === 0) return '';

  // Sort by updatedAt desc; undefined coerces to 0 (i.e. pushed to the end).
  const sorted = allowed
    .slice()
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));

  const out = [lang.taskCtxRelatedHeader];
  for (const t of sorted.slice(0, DEFAULT_RELATED_TASK_TOP)) {
    const title = typeof t.title === 'string' && t.title.trim() ? t.title.trim() : t.id;
    out.push(`- **${t.id}** · ${title}`);
    const mems = Array.isArray(t.memories) ? t.memories : [];
    for (const m of mems.slice(0, DEFAULT_RELATED_TASK_MEMORY_TOP)) {
      const body = typeof m?.body === 'string' ? m.body.trim() : '';
      if (!body) continue;
      const shard = typeof m?.shard === 'string' && m.shard.trim() ? m.shard.trim() : 'general';
      out.push(`  - [${shard}] ${body}`);
    }
  }
  // If every allowed task had zero usable memory, we still keep the header +
  // task list — the related-task identifiers themselves are useful context.
  return out.join('\n');
}

/**
 * Render the summary-reminder line (§Δ27.3).
 *
 * Conditions (ALL must hold):
 *   (a) currentVpId === task.initiatorVpId
 *   (b) summaryReminder.nonSummaryCount ≥ 3
 *   (c) (now - lastSummaryAt) > 15 minutes
 *       (lastSummaryAt == 0 / missing is treated as "never summarized":
 *        only triggers if nonSummaryCount ≥ 3)
 */
function renderSummaryReminder(taskCtx, lang) {
  const r = taskCtx && taskCtx.summaryReminder;
  if (!r || typeof r !== 'object') return '';
  if (!taskCtx.currentVpId || !taskCtx.initiatorVpId) return '';
  if (taskCtx.currentVpId !== taskCtx.initiatorVpId) return '';

  const count = Number(r.nonSummaryCount) || 0;
  const now = Number(r.now) || Date.now();
  const lastAt = Number(r.lastSummaryAt) || 0;
  const ageMs = lastAt > 0 ? now - lastAt : Number.POSITIVE_INFINITY;

  // task-334n §Δ31.4 gate: when `members` is supplied, apply the strict
  // multi-VP / 20min-or-10turn rule. Otherwise keep the legacy 334e gate
  // so pre-334n callers still see reminders under the old thresholds.
  const members = Array.isArray(r.members) ? r.members : null;
  if (members) {
    if (members.length < SUMMARY_REMINDER_MIN_MEMBERS_334N) return '';
    const ageOk = lastAt > 0 && ageMs >= SUMMARY_REMINDER_MIN_AGE_MS_334N;
    const turnsOk = count >= SUMMARY_REMINDER_MIN_TURNS_334N;
    // `never summarised` (lastAt=0) only counts when turnsOk, otherwise we
    // silently wait — aligns with §Δ31.4 "too-soon" reason code.
    if (!ageOk && !turnsOk) return '';
  } else {
    if (count < SUMMARY_REMINDER_MIN_MESSAGES) return '';
    if (lastAt > 0 && ageMs <= SUMMARY_REMINDER_MIN_AGE_MS) return '';
  }

  const minStr = lastAt > 0 ? String(Math.round(ageMs / 60000)) : '—';
  return lang.taskCtxSummaryReminder(minStr, count);
}

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
 *   feature: <featureId> "<title>"   (omitted when null/empty)
 *   group:   <groupId>               (omitted when missing)
 *   vp:      <vpId>                  (omitted when missing)
 *   envelope: from=<sender> intent=<intent>   (omitted when no envelope)
 *
 * Returns '' when the input has no useful field — we don't emit an empty
 * header. featureId is allowed to be `null` (DESIGN-PROMPT §5.1 — T4
 * Scope Tagging is a placeholder; not every turn lives in a feature).
 *
 * @param {object} [activeScope]
 * @param {string|null} [activeScope.featureId]
 * @param {string} [activeScope.featureTitle]
 * @param {string} [activeScope.groupId]
 * @param {string} [activeScope.vpId]
 * @param {object} [activeScope.envelope]   inbound routing summary
 * @param {object} lang
 * @returns {string}
 */
function renderActiveScope(activeScope, lang) {
  if (!activeScope || typeof activeScope !== 'object') return '';

  const lines = [];
  const feature = typeof activeScope.featureId === 'string' && activeScope.featureId.trim()
    ? activeScope.featureId.trim()
    : null;
  if (feature) {
    // Escape embedded `"` in featureTitle so a title like `Onboard "v2"` does
    // not produce a malformed `feature: f1 "Onboard "v2""` line. Titles come
    // from user / agent input — assume nothing.
    const title = typeof activeScope.featureTitle === 'string' && activeScope.featureTitle.trim()
      ? ` "${activeScope.featureTitle.trim().replace(/"/g, '\\"')}"`
      : '';
    lines.push(`feature: ${feature}${title}`);
  }
  const group = typeof activeScope.groupId === 'string' && activeScope.groupId.trim()
    ? activeScope.groupId.trim()
    : '';
  if (group) lines.push(`group: ${group}`);

  const vp = typeof activeScope.vpId === 'string' && activeScope.vpId.trim()
    ? activeScope.vpId.trim()
    : '';
  if (vp) lines.push(`vp: ${vp}`);

  const envLine = renderEnvelopeLine(activeScope.envelope);
  if (envLine) lines.push(`envelope: ${envLine}`);

  if (lines.length === 0) return '';

  return `${lang.activeScopeHeader}\n${lines.join('\n')}`;
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
 * now structured (`activeScope: { featureId, groupId, vpId, envelope }`)
 * and rendered by `buildSystemPrompt` itself. Both pass-through params
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

