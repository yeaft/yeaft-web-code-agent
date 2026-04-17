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
 *   - Memory section (user profile + recalled entries)
 *   - Compact summary section (conversation history summary)
 *
 * task-287 refactor (tool-on-demand memory):
 *   - New `memoryInjection` param carries prebuilt "Memory Index + user
 *     preferences + project header" text (~1.5k tokens). Engine builds this
 *     via memory/layout.buildMemoryInjection() and passes it every turn.
 *   - Legacy `memory={profile,entries}` param still supported for callers
 *     (tests, CLI) that have not migrated.
 *
 * Reference: yeaft-unify-system-prompt-budget.md — Static + Dynamic + Context layers
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─── Template Loading (one-time at startup) ──────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, 'templates');

/**
 * Read a template file from the templates/ directory.
 * Returns empty string if file doesn't exist or can't be read.
 * @param {string} name — filename (e.g. 'base.md')
 * @returns {string}
 */
function readTemplate(name) {
  const path = join(TEMPLATES_DIR, name);
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
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
  modeUnified: readTemplate('mode-unified.md'),
  modeDream: readTemplate('mode-dream.md'),
  toolGuidance: readTemplate('tool-guidance.md'),
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
 *
 * @param {{
 *   language?: string,
 *   mode?: string,
 *   toolNames?: string[],
 *   memory?: { profile?: string, entries?: object[] },
 *   memoryInjection?: string,
 *   compactSummary?: string,
 *   skillContent?: string,
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
} = {}) {
  // Fallback to English for unknown languages
  const lang = PROMPTS[language] || PROMPTS.en;
  const effectiveLang = PROMPTS[language] ? language : 'en';

  const parts = [];

  // ─── 1. Core Identity ──────────────────────────────────
  // Use template if available, otherwise fallback to hardcoded one-liner
  const baseTemplate = getTemplate('base', effectiveLang);
  if (baseTemplate) {
    parts.push(baseTemplate);
  } else {
    parts.push(lang.identity);
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
  if (memoryInjection && memoryInjection.trim()) {
    // New path (task-287): prebuilt injection from memory/layout.buildMemoryInjection()
    // Contains index.md + user-preferences.md + optional project header excerpt.
    parts.push(memoryInjection.trim());
  } else if (memory && (memory.profile || (memory.entries && memory.entries.length > 0))) {
    // Legacy path — kept for callers (tests, CLI) that have not migrated yet.
    const memoryParts = [lang.memoryHeader];

    if (memory.profile) {
      memoryParts.push(`${lang.profileHeader}\n${memory.profile}`);
    }

    if (memory.entries && memory.entries.length > 0) {
      const entryLines = memory.entries.map(e => {
        const tags = (e.tags && e.tags.length > 0) ? ` [${e.tags.join(', ')}]` : '';
        return `- **${e.name}** (${e.kind}): ${e.content}${tags}`;
      });
      memoryParts.push(`${lang.recalledHeader}\n${entryLines.join('\n')}`);
    }

    parts.push(memoryParts.join('\n\n'));
  }

  // ─── 7. Compact Summary Section ────────────────────────
  if (compactSummary) {
    parts.push(`${lang.compactHeader}\n${compactSummary}`);
  }

  return parts.join('\n\n');
}
