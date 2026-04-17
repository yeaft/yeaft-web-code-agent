/**
 * layout.js — New-layout memory file helpers (tool-on-demand model)
 *
 * Directory layout:
 *   ~/.yeaft/memory/
 *     index.md                 — classification catalog (always injected into system prompt)
 *     user-preferences.md      — merged user preferences (default-injected)
 *     entries/*.md             — atomic entries (existing layout, read by memory_query)
 *     by-project/<slug>.md     — per-project narrative summaries
 *     by-topic/<slug>.md       — per-topic narrative summaries
 *     timeline/<YYYY-MM>.md    — monthly narrative digests
 *
 * Design:
 *   - index.md is a single human-readable file listing all classification files
 *     with a one-line summary and entry count per section.
 *   - Aggregate files (by-project / by-topic / timeline) are narrative prose,
 *     not raw entry concat — produced by Dream.
 *   - user-preferences.md is a deduped accumulation of preferences extracted
 *     from conversations.
 *   - Project header match: basename(cwd) is matched against by-project/<slug>.md
 *     filenames (case-insensitive substring match either direction).
 *
 * This module lives alongside store.js; it does NOT replace MemoryStore.
 * Old MEMORY.md / scopes.md continue to exist for backward compatibility
 * but are no longer maintained by Dream after this refactor.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'fs';
import { basename, join } from 'path';
import { isPermissionError } from '../init.js';

// ─── Constants ──────────────────────────────────────────────

/** Classification category dirnames. */
export const CATEGORY_DIRS = ['by-project', 'by-topic', 'timeline'];

/** Classification single-file names living directly under memory/. */
export const SINGLE_FILES = ['index.md', 'user-preferences.md'];

/** Approximate character budget for prompt injection (~1.5k tokens). */
export const PROMPT_INJECTION_CHAR_BUDGET = 6000;

/** Character budget for project header excerpt (~300 tokens). */
export const PROJECT_HEADER_CHAR_BUDGET = 1200;

// ─── Path helpers ───────────────────────────────────────────

/**
 * @param {string} yeaftDir — e.g. ~/.yeaft
 * @returns {string} — absolute path to memory root
 */
export function memoryDir(yeaftDir) {
  return join(yeaftDir, 'memory');
}

/**
 * Ensure the new-layout directory skeleton exists (idempotent).
 * @param {string} yeaftDir
 */
export function ensureLayout(yeaftDir) {
  const root = memoryDir(yeaftDir);
  const dirs = [root, ...CATEGORY_DIRS.map(d => join(root, d)), join(root, 'entries')];
  for (const d of dirs) {
    try {
      if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o755 });
    } catch (err) {
      if (!isPermissionError(err)) throw err;
    }
  }
}

// ─── File I/O ───────────────────────────────────────────────

/**
 * Read a file under memory/ by relative path. Returns '' if missing.
 * @param {string} yeaftDir
 * @param {string} relPath — e.g. 'index.md', 'by-project/foo.md'
 * @returns {string}
 */
export function readMemoryFile(yeaftDir, relPath) {
  const fp = join(memoryDir(yeaftDir), relPath);
  if (!existsSync(fp)) return '';
  try {
    return readFileSync(fp, 'utf8');
  } catch (err) {
    if (isPermissionError(err)) return '';
    throw err;
  }
}

/**
 * Write a file under memory/ by relative path. Creates parent dir if needed.
 * @param {string} yeaftDir
 * @param {string} relPath
 * @param {string} content
 */
export function writeMemoryFile(yeaftDir, relPath, content) {
  ensureLayout(yeaftDir);
  const fp = join(memoryDir(yeaftDir), relPath);
  try {
    writeFileSync(fp, content, { encoding: 'utf8', mode: 0o644 });
  } catch (err) {
    if (!isPermissionError(err)) throw err;
  }
}

/**
 * List all classification files (relative paths) that currently exist.
 * Includes single files (index.md, user-preferences.md) and per-category files.
 *
 * @param {string} yeaftDir
 * @returns {{ path: string, size: number }[]}
 */
export function listClassificationFiles(yeaftDir) {
  const root = memoryDir(yeaftDir);
  const out = [];

  for (const f of SINGLE_FILES) {
    const fp = join(root, f);
    if (existsSync(fp)) {
      try {
        out.push({ path: f, size: statSync(fp).size });
      } catch { /* ignore */ }
    }
  }

  for (const dir of CATEGORY_DIRS) {
    const dp = join(root, dir);
    if (!existsSync(dp)) continue;
    try {
      for (const f of readdirSync(dp)) {
        if (!f.endsWith('.md')) continue;
        const fp = join(dp, f);
        try {
          out.push({ path: `${dir}/${f}`, size: statSync(fp).size });
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  return out;
}

// ─── Project header matching ────────────────────────────────

/**
 * Given a cwd, find the best-matching by-project/<slug>.md filename.
 * Rule: case-insensitive substring match between basename(cwd) and slug
 * (either direction). Returns the first match by sort order, or null.
 *
 * @param {string} yeaftDir
 * @param {string} cwd
 * @returns {string|null} — relative path like 'by-project/claude-web-chat.md', or null
 */
export function findProjectFile(yeaftDir, cwd) {
  if (!cwd) return null;
  const base = basename(cwd).toLowerCase();
  if (!base) return null;

  const dir = join(memoryDir(yeaftDir), 'by-project');
  if (!existsSync(dir)) return null;

  let files;
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  } catch {
    return null;
  }

  for (const f of files) {
    const slug = f.slice(0, -3).toLowerCase();
    if (slug === base) return `by-project/${f}`;
  }
  for (const f of files) {
    const slug = f.slice(0, -3).toLowerCase();
    if (slug.includes(base) || base.includes(slug)) return `by-project/${f}`;
  }

  return null;
}

/**
 * Return the leading excerpt of a file capped at charBudget.
 * Trims to the last complete line boundary to avoid mid-line cutoff.
 *
 * @param {string} text
 * @param {number} charBudget
 * @returns {string}
 */
export function excerpt(text, charBudget) {
  if (!text) return '';
  if (text.length <= charBudget) return text;
  const cut = text.slice(0, charBudget);
  const lastNl = cut.lastIndexOf('\n');
  return lastNl > charBudget * 0.6 ? cut.slice(0, lastNl) : cut;
}

// ─── Index rendering ────────────────────────────────────────

/**
 * Render an auto-generated index.md from the current on-disk layout.
 *
 * Format:
 *   # Memory Index
 *
 *   ## Single files
 *   - user-preferences.md (NNN bytes) — user-written/Dream-merged preferences
 *
 *   ## by-project
 *   - by-project/foo.md (NNN bytes)
 *   - by-project/bar.md (NNN bytes)
 *
 *   ## by-topic ...
 *   ## timeline ...
 *   ## entries
 *   - N atomic entries (use memory_query to search)
 *
 * One-line summaries are pulled from the first non-empty, non-heading line
 * of each file.
 *
 * @param {string} yeaftDir
 * @param {number} entryCount — number of atomic entries (from MemoryStore)
 * @returns {string}
 */
export function renderIndex(yeaftDir, entryCount) {
  const root = memoryDir(yeaftDir);
  const lines = ['# Memory Index', ''];

  // Single files section
  const singleLines = [];
  for (const f of SINGLE_FILES) {
    if (f === 'index.md') continue;
    const fp = join(root, f);
    if (!existsSync(fp)) continue;
    const summary = firstSummary(fp);
    const size = safeSize(fp);
    singleLines.push(`- ${f} (${size} bytes)${summary ? ` — ${summary}` : ''}`);
  }
  if (singleLines.length) {
    lines.push('## Single files', '', ...singleLines, '');
  }

  // Category sections
  for (const cat of CATEGORY_DIRS) {
    const dp = join(root, cat);
    if (!existsSync(dp)) continue;
    let files;
    try {
      files = readdirSync(dp).filter(f => f.endsWith('.md')).sort();
    } catch {
      continue;
    }
    if (!files.length) continue;
    lines.push(`## ${cat}`, '');
    for (const f of files) {
      const fp = join(dp, f);
      const summary = firstSummary(fp);
      const size = safeSize(fp);
      lines.push(`- ${cat}/${f} (${size} bytes)${summary ? ` — ${summary}` : ''}`);
    }
    lines.push('');
  }

  // Entries section (count only — atomic entries are searched via memory_query)
  lines.push('## entries', '', `- ${entryCount} atomic entries (use memory_query to search)`, '');

  lines.push(
    '_Note: use the `memory_search` tool with one or more paths to load a classification',
    'file in full, or `memory_query` to search atomic entries by keywords/tags._',
  );

  return lines.join('\n') + '\n';
}

/**
 * First non-heading non-empty line of a file, trimmed to 120 chars.
 */
function firstSummary(fp) {
  try {
    const raw = readFileSync(fp, 'utf8');
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      if (s.startsWith('#')) continue;
      if (s.startsWith('---')) continue;
      return s.length > 120 ? s.slice(0, 120) + '…' : s;
    }
  } catch { /* ignore */ }
  return '';
}

function safeSize(fp) {
  try {
    return statSync(fp).size;
  } catch {
    return 0;
  }
}

// ─── Prompt injection builder ───────────────────────────────

/**
 * Build the memory section to inject into the system prompt every turn.
 *
 * Content, in order:
 *   1. index.md (full text — auto-regenerated when missing/stale)
 *   2. user-preferences.md (full text)
 *   3. Project header excerpt (first PROJECT_HEADER_CHAR_BUDGET chars of
 *      the matching by-project/<slug>.md, if cwd matches)
 *
 * Total output is capped at PROMPT_INJECTION_CHAR_BUDGET; later sections
 * are dropped first if over budget.
 *
 * @param {{
 *   yeaftDir: string,
 *   cwd?: string,
 *   entryCount?: number,
 *   language?: 'en' | 'zh',
 * }} params
 * @returns {string}
 */
export function buildMemoryInjection({ yeaftDir, cwd, entryCount = 0, language = 'en' }) {
  if (!yeaftDir) return '';

  const heading = language === 'zh' ? '## 记忆索引' : '## Memory Index';
  const prefHeading = language === 'zh' ? '## 用户偏好' : '## User Preferences';
  const projectHeading = language === 'zh' ? '## 当前项目摘要' : '## Current Project Summary';

  let indexText = readMemoryFile(yeaftDir, 'index.md');
  if (!indexText.trim()) {
    // Auto-generate an index on the fly so the LLM always sees something useful.
    indexText = renderIndex(yeaftDir, entryCount);
  }

  const prefText = readMemoryFile(yeaftDir, 'user-preferences.md');

  let projectText = '';
  const projectRel = cwd ? findProjectFile(yeaftDir, cwd) : null;
  if (projectRel) {
    projectText = excerpt(readMemoryFile(yeaftDir, projectRel), PROJECT_HEADER_CHAR_BUDGET);
  }

  const sections = [];
  sections.push(`${heading}\n${indexText.trim()}`);
  if (prefText.trim()) sections.push(`${prefHeading}\n${prefText.trim()}`);
  if (projectText.trim()) sections.push(`${projectHeading} (${projectRel})\n${projectText.trim()}`);

  // Enforce total char budget — drop from the end.
  let combined = sections.join('\n\n');
  while (combined.length > PROMPT_INJECTION_CHAR_BUDGET && sections.length > 1) {
    sections.pop();
    combined = sections.join('\n\n');
  }
  if (combined.length > PROMPT_INJECTION_CHAR_BUDGET) {
    combined = excerpt(combined, PROMPT_INJECTION_CHAR_BUDGET);
  }
  return combined;
}
