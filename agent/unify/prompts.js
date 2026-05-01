/**
 * prompts.js — Bilingual system prompt templates
 *
 * Single source of truth for system prompts. Both engine.js and cli.js
 * import buildSystemPrompt() from here. Supports 'en' and 'zh'.
 *
 * Template files from agent/unify/templates/ are loaded once at startup
 * and used to enrich the system prompt beyond the hardcoded fallbacks.
 *
 * Phase 2 additions:
 *   - Memory section (recalled segments via H2-AMS pre-flow)
 *   - Compact summary section (conversation history summary)
 *
 * Memory injection (H2-AMS):
 *   - `memoryInjection` carries prebuilt FTS-recall text from
 *     `memory/preflow.js` over the relevant scopes (user/group/vp/feature/
 *     global). Engine passes it every turn after preflow runs.
 *
 * Reference: yeaft-unify-system-prompt-budget.md — Static + Dynamic + Context layers
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

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
    memoryHeader: '## User Memory',
    profileHeader: '### User Profile',
    recalledHeader: '### Recalled Memories',
    compactHeader: '## Conversation History Summary',
    // task-334e — new section headers
    taskCtxHeader: '## task_ctx',
    taskCtxRelatedHeader: '### related tasks',
    taskCtxSummaryReminder: (min, count) =>
      `💡 ${min}min since last summary (+${count} new messages). Consider calling \`task_summary_post\`.`,
    userProfileHeader: '## user_profile',
    coreMemoryHeader: '## core_memory',
    coreMemoryMeta: 'To open the original message behind any entry above, call `memory_trace`.',
    vpPersonaIntro: (name, role) =>
      `You ARE **${name}**${role ? ` (${role})` : ''}. Speak in the first person as ${name}; do not refer to yourself as "Yeaft" or as a generic AI assistant. The text below is your identity, expertise, and decision style.`,
  },
  zh: {
    identity: '你是 Yeaft，一个有用的 AI 助手。',
    date: (d) => `日期：${d}`,
    dream: '你处于梦境模式。回顾过去的对话，整理和巩固记忆。',
    tools: (names) => `可用工具：${names}`,
    memoryHeader: '## 用户记忆',
    profileHeader: '### 用户画像',
    recalledHeader: '### 相关记忆',
    compactHeader: '## 对话历史摘要',
    // task-334e — new section headers
    taskCtxHeader: '## task_ctx',
    taskCtxRelatedHeader: '### 相关任务',
    taskCtxSummaryReminder: (min, count) =>
      `💡 距上次 summary 已过 ${min}min，新增 ${count} 条消息，建议调用 \`task_summary_post\`。`,
    userProfileHeader: '## user_profile',
    coreMemoryHeader: '## core_memory',
    coreMemoryMeta: '如需原始 message，调 `memory_trace`。',
    vpPersonaIntro: (name, role) =>
      `你就是 **${name}**${role ? `（${role}）` : ''}。请以 ${name} 的第一人称发言；不要自称 "Yeaft" 或泛指的 AI 助手。下面的文字是你的身份、专业方向与判断风格。`,
  },
};

/** Supported language codes. */
export const SUPPORTED_LANGUAGES = Object.keys(PROMPTS);

/**
 * Build the system prompt for a given language.
 *
 * task-297: chat/work mode distinction was removed. The prompt now always uses
 * the unified mode template. The `mode` param is retained for backward compat
 * — only `mode === 'dream'` triggers the dream-mode template (used by background
 * memory maintenance); all other values fall through to unified mode.
 *
 * Prompt structure:
 *   1. Core identity (from template or fallback)
 *   2. Date metadata
 *   3. Mode-specific behavioral instructions (unified, or dream)
 *   4. Tool list + tool guidance (from template)
 *   5. Skills section
 *   6. Memory section
 *   7. Compact summary section
 *   8. Task context section (task-334e §Δ24.5 + §Δ27.3 + §Δ31.4)
 *   9. User profile section (task-334e §Δ29.3 stub)
 *  10. Core memory section (task-334e §Δ24.5)
 *
 * task-334e params:
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
 *   @param {string} [userProfile] — explicit profile content (334l path);
 *     when omitted we read `~/.yeaft/user/profile.json` `{ content }` as stub.
 *   @param {{ entries?: Array<{body:string, shard?:string}>, max?: number }} [coreMemory]
 *     — recalled memory entries; we render top-7 bodies + meta line.
 *
 *   @param {boolean} [memoryTraceAvailable=false] — feature flag gating the
 *     "call memory_trace" meta line in the core_memory block. Defaults to
 *     false so we don't point VPs at an unimplemented tool (prev-3 Nit-2 /
 *     PM-approved Option A). 334f will flip this to `true` from session.js
 *     once `memory_trace` ships; this slice stays decoupled from session.js.
 *
 * @param {{
 *   language?: string,
 *   mode?: string,
 *   toolNames?: string[],
 *   memory?: { profile?: string, entries?: object[] },
 *   memoryInjection?: string,
 *   compactSummary?: string,
 *   skillContent?: string,
 *   taskCtx?: object,
 *   userProfile?: string,
 *   coreMemory?: object,
 *   memoryTraceAvailable?: boolean,
 * }} params
 * @returns {string}
 */
export function buildSystemPrompt({
  language = 'en',
  mode,
  toolNames = [],
  memory,
  memoryInjection,
  compactSummary,
  skillContent,
  taskCtx,
  userProfile,
  coreMemory,
  memoryTraceAvailable = false,
  vpPersona,
  groupAnnouncement = '',
} = {}) {
  // Fallback to English for unknown languages
  const lang = PROMPTS[language] || PROMPTS.en;
  const effectiveLang = PROMPTS[language] ? language : 'en';

  const parts = [];

  // ─── 1. Core Identity ──────────────────────────────────
  // Phase 8 wire-up: when a VP persona is active, the persona body REPLACES
  // the Yeaft identity block (the LLM is that VP, not Yeaft pretending). When
  // there is no persona, fall back to the legacy Yeaft identity bundle.
  const personaBlock = renderVpPersona(vpPersona, lang);
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
    parts.push(`[Group Announcement]\n${annText}`);
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

  // ─── 6. Memory Section ─────────────────────────────────
  // FTS5 pre-flow recall + AMS snapshot are concatenated upstream by the
  // engine into a single `memoryInjection` block. The legacy entries-based
  // memory.profile / memory.entries shape was retired in the H2-AMS rip.
  if (memoryInjection && memoryInjection.trim()) {
    parts.push(memoryInjection.trim());
  }

  // ─── 7. Compact Summary Section ────────────────────────
  if (compactSummary) {
    parts.push(`${lang.compactHeader}\n${compactSummary}`);
  }

  // ─── 8. Task Context Section (task-334e §Δ24.5 / §Δ27.3 / §Δ31.4) ─
  const taskCtxBlock = renderTaskCtx(taskCtx, lang);
  if (taskCtxBlock) parts.push(taskCtxBlock);

  // ─── 9. User Profile Section (task-334e §Δ29.3 stub) ───
  const profileBlock = renderUserProfile(userProfile, lang);
  if (profileBlock) parts.push(profileBlock);

  // ─── 10. Core Memory Section (task-334e §Δ24.5) ────────
  const coreMemBlock = renderCoreMemory(coreMemory, lang, memoryTraceAvailable);
  if (coreMemBlock) parts.push(coreMemBlock);

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
 * @param {string} [vpPersona.persona]
 * @param {object} lang
 * @returns {string}
 */
function renderVpPersona(vpPersona, lang) {
  if (!vpPersona || typeof vpPersona !== 'object') return '';
  const name = typeof vpPersona.displayName === 'string'
    ? vpPersona.displayName.trim() : '';
  if (!name) return '';
  const role = typeof vpPersona.role === 'string' ? vpPersona.role.trim() : '';
  const body = typeof vpPersona.persona === 'string' ? vpPersona.persona.trim() : '';

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

const DEFAULT_TASK_MEMORY_TOP = 5;
const DEFAULT_RELATED_TASK_TOP = 3;
const DEFAULT_RELATED_TASK_MEMORY_TOP = 2;
const DEFAULT_CORE_MEMORY_TOP = 7;
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
 * Render `## user_profile` block. If the caller passed an explicit string,
 * we use it verbatim (that's the 334l path). Otherwise we stub-read from
 * `~/.yeaft/user/profile.json` (`{ content: "..." }`) per §Δ29.3. Any IO
 * error is swallowed — this is best-effort context, not critical path.
 */
function renderUserProfile(userProfile, lang) {
  let content = '';
  if (typeof userProfile === 'string' && userProfile.trim()) {
    content = userProfile.trim();
  } else if (userProfile == null) {
    content = readUserProfileStub();
  }
  if (!content) return '';
  return `${lang.userProfileHeader}\n${content}`;
}

function readUserProfileStub() {
  try {
    const path = join(homedir(), '.yeaft', 'user', 'profile.json');
    if (!existsSync(path)) return '';
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.content === 'string') return parsed.content.trim();
    return '';
  } catch {
    // File missing, unreadable, malformed JSON, or non-string content.
    // Stub is best-effort — fall through silently.
    return '';
  }
}

/**
 * Render `## core_memory` block with recall top-7 bodies + (optional) meta line.
 *
 * Accepts `{ entries: [{body,shard}], max?: number }`. Never renders
 * `sourceRef`. The "call memory_trace" meta line is gated by
 * `memoryTraceAvailable` (prev-3 Nit-2 / PM-approved Option A): when the
 * `memory_trace` tool is not yet implemented (334f), we omit the meta line
 * entirely so the LLM does not try to call a non-existent tool. 334f will
 * flip the flag to `true` when it wires session.js.
 */
function renderCoreMemory(coreMemory, lang, memoryTraceAvailable) {
  if (!coreMemory || typeof coreMemory !== 'object') return '';
  const entries = Array.isArray(coreMemory.entries) ? coreMemory.entries : [];
  if (entries.length === 0) return '';
  const max = Number.isFinite(coreMemory.max) && coreMemory.max > 0
    ? Math.floor(coreMemory.max)
    : DEFAULT_CORE_MEMORY_TOP;

  const lines = [lang.coreMemoryHeader];
  let shown = 0;
  for (const e of entries) {
    if (shown >= max) break;
    const body = typeof e?.body === 'string' ? e.body.trim() : '';
    if (!body) continue;
    const shard = typeof e?.shard === 'string' && e.shard.trim() ? e.shard.trim() : 'general';
    lines.push(`- [${shard}] ${body}`);
    shown += 1;
  }
  if (shown === 0) return '';
  if (memoryTraceAvailable) {
    lines.push('');
    lines.push(lang.coreMemoryMeta);
  }
  return lines.join('\n');
}

// ─── Phase 1: Worker / Router prompt splits ──────────────────────
//
// DESIGN.md (multi-VP redesign) describes two distinct prompt shapes:
//
//   • Worker prompt — what a VP sees when it executes a turn. Layered as
//     A (identity + summaries) / B (router-preselected memory) / C (task
//     scope) / D (turn scope).
//   • Router prompt — what the per-VP Router sees before it decides
//     plans[]. Identity-summary layer + recent group state, no task /
//     turn-scope detail.
//
// To stay backwards-compatible with existing callers we KEEP
// `buildSystemPrompt` and treat the two new entry points as thin wrappers
// that:
//   1) compose Layer-A summaries (user / group / vp) into the right
//      headed sections, and
//   2) prepend the matching harness/*-shape.md fragment when present.
//
// Subsequent phases will migrate engine.js / router.js to these entry
// points and start filling Layers B / C with the new memory tree. For
// now they exist primarily so tests can pin the contract.

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
 * optional; missing or empty strings are skipped. Headers follow the
 * `## summary_<scope>` convention so Layer-B/C/D headers don't collide.
 *
 * @param {{user?: string, group?: string, vp?: string}} summaries
 * @param {'en'|'zh'} language
 * @returns {string} concatenated block ('' when nothing to render)
 */
export function renderLayerASummaries(summaries, language = 'en') {
  if (!summaries || typeof summaries !== 'object') return '';
  const headers = LAYER_A_HEADERS[language] || LAYER_A_HEADERS.en;
  const out = [];
  for (const key of ['user', 'group', 'vp']) {
    const body = typeof summaries[key] === 'string' ? summaries[key].trim() : '';
    if (!body) continue;
    out.push(`${headers[key]}\n${body}`);
  }
  return out.join('\n\n');
}

/**
 * Worker prompt entry point (DESIGN.md Phase 1).
 *
 * Layered output:
 *   harness/worker-shape   — what each layer means (optional fragment)
 *   Layer A — buildSystemPrompt(...) output (identity + persona + Layer-A
 *             summaries via `summaries`)
 *   Layer B — `preselectedMemory` block (router-supplied)
 *   Layer C — `taskScope` block (active task summary + related-task window)
 *   Layer D — `turnScope` block (inbound envelope, in-flight turn notes)
 *
 * Layers B/C/D are passed in as already-rendered strings so this builder
 * stays free of memory-store / task-store IO. Phase 2/3 will provide the
 * real renderers; for now any caller can stub them.
 *
 * @param {{
 *   language?: 'en'|'zh',
 *   summaries?: {user?: string, group?: string, vp?: string},
 *   preselectedMemory?: string,
 *   taskScope?: string,
 *   turnScope?: string,
 *   includeShape?: boolean,
 *   ...rest: import('./prompts.js').buildSystemPrompt
 * }} params
 * @returns {string}
 */
export function buildWorkerPrompt(params = {}) {
  const {
    language = 'en',
    summaries,
    preselectedMemory,
    taskScope,
    turnScope,
    includeShape = true,
    ...rest
  } = params;

  const parts = [];

  // Optional harness — describes the layered shape.
  if (includeShape) {
    const shape = getTemplate('harnessWorkerShape', language);
    if (shape) parts.push(shape);
  }

  // Layer A — base + persona + summaries.
  const baseBlock = buildSystemPrompt({ ...rest, language });
  if (baseBlock) parts.push(baseBlock);
  const summaryBlock = renderLayerASummaries(summaries, language);
  if (summaryBlock) parts.push(summaryBlock);

  // Layer B — router-preselected memory entries (rendered upstream).
  if (typeof preselectedMemory === 'string' && preselectedMemory.trim()) {
    parts.push(preselectedMemory.trim());
  }

  // Layer C — task scope.
  if (typeof taskScope === 'string' && taskScope.trim()) {
    parts.push(taskScope.trim());
  }

  // Layer D — turn scope (inbound envelope, in-flight turn notes).
  if (typeof turnScope === 'string' && turnScope.trim()) {
    parts.push(turnScope.trim());
  }

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
  const header = language === 'zh' ? '## 上一轮 plan' : '## prior_plan';
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
  const parts = [];

  if (includeShape) {
    const shape = getTemplate('harnessRouterShape', language);
    if (shape) parts.push(shape);
  }

  const summaryBlock = renderLayerASummaries(summaries, language);
  if (summaryBlock) parts.push(summaryBlock);

  const priorBlock = renderPriorPlan(priorPlan, language);
  if (priorBlock) parts.push(priorBlock);

  if (typeof routerContext === 'string' && routerContext.trim()) {
    parts.push(routerContext.trim());
  }

  return parts.join('\n\n');
}

