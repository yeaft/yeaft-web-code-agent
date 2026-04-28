/**
 * memory/scope-tree.js — DESIGN.md Phase 2 (scoped memory tree).
 *
 * Implements the path-keyed scope tree described in DESIGN.md §2:
 *
 *   ~/.yeaft/memory/
 *     user/
 *       summary.md          — paragraph synopsis (Layer A)
 *       index.md            — markdown table, path-keyed
 *       entries/<yyyy-mm-dd>-<slug>.md
 *     groups/<groupId>/    — same shape
 *     vp/<vpId>/           — same shape
 *     features/<featureId>/ — same shape, plus archive/
 *
 * This module is concerned ONLY with on-disk shape + atomic writes. It does
 * NOT do any LLM work (extraction, summarisation, dream maintenance) — those
 * are higher layers (compact-orchestrator, dream).
 *
 * Atomicity contract:
 *   - Every write goes via `.tmp` + rename to avoid torn reads. A reader
 *     mid-rename sees either the old or the new file, never half of either.
 *   - `createEntry()` opens with `O_EXCL` so concurrent producers cannot
 *     clobber a slug collision; the second writer surfaces `slug_exists`.
 *   - `index.md` is rewritten in full (markdown table). Partial-row append
 *     would leave a torn header on crash; the whole file is small enough
 *     that full rewrite + atomic rename is fine.
 *
 * Concurrency rules (DESIGN.md §9.1):
 *   - Two workers writing different entries to the same scope are safe —
 *     they write to different files, then each updates index.md via the
 *     atomic rename. Last writer wins for the index; both entries are
 *     present on disk regardless.
 *   - `summary.md` written via the same atomic rename. Workers reading it
 *     mid-write see either the previous or the next paragraph.
 *
 * Path discipline:
 *   - All scope paths returned by helpers are filesystem-relative paths
 *     ROOTED at the memory dir, e.g. `groups/eng/entries/2026-04-21-foo.md`.
 *     This matches DESIGN.md §1.2.1 — paths self-document.
 */

import {
  promises as fsp,
  existsSync,
  mkdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

/** Default memory root. Tests override via `opts.root`. */
export const DEFAULT_MEMORY_ROOT = join(homedir(), '.yeaft', 'memory');

/** @typedef {'user'|'group'|'vp'|'feature'} ScopeKind */
/** @typedef {{kind: ScopeKind, id?: string}} Scope */

/**
 * Compute the scope's path segment relative to the memory root.
 * `user/`, `groups/<id>/`, `vp/<id>/`, `features/<id>/`.
 *
 * @param {Scope} scope
 * @returns {string}
 */
export function scopeDir(scope) {
  if (!scope || typeof scope !== 'object') {
    throw new Error('scopeDir: scope is required');
  }
  switch (scope.kind) {
    case 'user':
      return 'user';
    case 'group':
      if (!scope.id) throw new Error('scopeDir: group scope requires id');
      return `groups/${scope.id}`;
    case 'vp':
      if (!scope.id) throw new Error('scopeDir: vp scope requires id');
      return `vp/${scope.id}`;
    case 'feature':
      if (!scope.id) throw new Error('scopeDir: feature scope requires id');
      return `features/${scope.id}`;
    default:
      throw new Error(`scopeDir: unknown kind ${JSON.stringify(scope.kind)}`);
  }
}

/**
 * Atomic write: temp-file + rename. Creates parent directories on demand.
 * The rename is atomic on POSIX filesystems for paths on the same mount.
 *
 * @param {string} absPath
 * @param {string} content
 */
async function atomicWrite(absPath, content) {
  await fsp.mkdir(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, absPath);
}

/**
 * Slugify a free-form title for use in a filename. Lowercase, ASCII letters
 * + digits + dash. Empty / pathological input returns `entry`.
 *
 * @param {string} title
 * @returns {string}
 */
export function slugify(title) {
  const raw = (title || '')
    .toString()
    .toLowerCase()
    .normalize('NFKD')
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[̀-ͯ]/g, '') // strip combining marks
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return raw || 'entry';
}

/**
 * Format a Date as `yyyy-mm-dd` in UTC. Used in entry filenames.
 *
 * @param {Date} [d=new Date()]
 * @returns {string}
 */
export function isoDate(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Compute the canonical entry path for a (scope, title, date) triple.
 *
 * @param {Scope} scope
 * @param {string} title
 * @param {Date} [date]
 * @returns {string} relative to memory root
 */
export function entryPathFor(scope, title, date) {
  return `${scopeDir(scope)}/entries/${isoDate(date)}-${slugify(title)}.md`;
}

// ─── frontmatter ───────────────────────────────────────────────

/**
 * Render YAML-ish frontmatter. Keys in deterministic order; string values
 * are JSON-stringified to handle quotes / newlines safely; arrays render as
 * `key: [a, b]`. Unknown values are skipped.
 *
 * @param {Record<string,*>} fm
 * @returns {string}
 */
function renderFrontmatter(fm) {
  if (!fm || typeof fm !== 'object') return '';
  const order = ['title', 'kind', 'tags', 'source', 'createdAt', 'updatedAt'];
  const seen = new Set();
  const lines = ['---'];
  for (const key of order) {
    if (!(key in fm)) continue;
    seen.add(key);
    lines.push(renderFmLine(key, fm[key]));
  }
  for (const key of Object.keys(fm)) {
    if (seen.has(key)) continue;
    lines.push(renderFmLine(key, fm[key]));
  }
  lines.push('---');
  return lines.filter(Boolean).join('\n');
}

function renderFmLine(key, value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    const items = value.map(v => (typeof v === 'string' ? v : JSON.stringify(v)));
    return `${key}: [${items.join(', ')}]`;
  }
  if (typeof value === 'string') {
    // Quote when it contains anything non-trivial.
    if (/^[\w\-./:]+$/.test(value)) return `${key}: ${value}`;
    return `${key}: ${JSON.stringify(value)}`;
  }
  return `${key}: ${JSON.stringify(value)}`;
}

/**
 * Parse the frontmatter block from a markdown body. Returns `{frontmatter,
 * body}`; missing frontmatter ⇒ `frontmatter = {}` and `body` is the input.
 * Best-effort parser — accepts the lines this module emits and a few common
 * variants. Does NOT pull in a YAML dep.
 *
 * @param {string} content
 * @returns {{ frontmatter: Record<string,*>, body: string }}
 */
export function parseEntry(content) {
  if (typeof content !== 'string' || !content.startsWith('---')) {
    return { frontmatter: {}, body: content || '' };
  }
  const end = content.indexOf('\n---', 4);
  if (end === -1) return { frontmatter: {}, body: content };
  const fmText = content.slice(4, end).trim();
  const body = content.slice(end + 4).replace(/^\n+/, '');
  const fm = {};
  for (const rawLine of fmText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    fm[key] = parseFmValue(rest);
  }
  return { frontmatter: fm, body };
}

function parseFmValue(rest) {
  if (rest === '') return '';
  if (rest.startsWith('[') && rest.endsWith(']')) {
    const inner = rest.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(s => {
      const t = s.trim();
      if (t.startsWith('"') && t.endsWith('"')) {
        try { return JSON.parse(t); } catch { return t; }
      }
      return t;
    });
  }
  if (rest.startsWith('"') && rest.endsWith('"')) {
    try { return JSON.parse(rest); } catch { return rest.slice(1, -1); }
  }
  return rest;
}

// ─── entries ───────────────────────────────────────────────────

/**
 * Create a new entry under (scope, title). Fails with `slug_exists` if the
 * computed path already exists. Returns the relative path written.
 *
 * @param {{
 *   scope: Scope,
 *   title: string,
 *   body: string,
 *   tags?: string[],
 *   kind?: string,
 *   source?: string,
 *   date?: Date,
 *   root?: string,
 * }} args
 * @returns {Promise<{ path: string, abs: string }>}
 */
export async function createEntry(args) {
  const { scope, title, body, tags, kind, source, date, root = DEFAULT_MEMORY_ROOT } = args;
  if (!title || typeof title !== 'string') throw new Error('createEntry: title required');
  if (typeof body !== 'string') throw new Error('createEntry: body required (string)');
  const rel = entryPathFor(scope, title, date);
  const abs = join(root, rel);
  await fsp.mkdir(dirname(abs), { recursive: true });
  const fm = renderFrontmatter({
    title,
    kind: kind || 'note',
    tags: Array.isArray(tags) && tags.length ? tags : undefined,
    source: source || undefined,
    createdAt: isoDate(date),
    updatedAt: isoDate(date),
  });
  const content = `${fm}\n\n${body.trim()}\n`;
  // O_EXCL — fail loudly on slug collision (DESIGN.md §9.1 atomicity).
  let handle;
  try {
    handle = await fsp.open(abs, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const e = new Error('slug_exists');
      e.code = 'slug_exists';
      e.path = rel;
      throw e;
    }
    throw err;
  }
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  return { path: rel, abs };
}

/**
 * Read an entry by its relative path; returns `null` if missing. Throws
 * `acl_blocked` when the caller's `currentVpId` is given and the path is
 * `vp/<other>/...` — the only hard ACL boundary.
 *
 * @param {string} relPath
 * @param {{ root?: string, currentVpId?: string }} [opts]
 * @returns {Promise<{ frontmatter: Record<string,*>, body: string, path: string } | null>}
 */
export async function readEntry(relPath, opts = {}) {
  const { root = DEFAULT_MEMORY_ROOT, currentVpId } = opts;
  if (!relPath || typeof relPath !== 'string') throw new Error('readEntry: relPath required');
  if (currentVpId && isVpForeign(relPath, currentVpId)) {
    const e = new Error('acl_blocked');
    e.code = 'acl_blocked';
    e.path = relPath;
    throw e;
  }
  const abs = join(root, relPath);
  let raw;
  try {
    raw = await fsp.readFile(abs, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const { frontmatter, body } = parseEntry(raw);
  return { frontmatter, body: body.replace(/\n+$/, ''), path: relPath };
}

/**
 * @returns {boolean} true iff `relPath` is `vp/<other>/...` (other ≠ currentVpId).
 */
export function isVpForeign(relPath, currentVpId) {
  if (!relPath || !currentVpId) return false;
  const m = /^vp\/([^/]+)\//.exec(relPath);
  if (!m) return false;
  return m[1] !== currentVpId;
}

// ─── index.md ──────────────────────────────────────────────────

/**
 * Index row schema. `path` is the canonical, scope-rooted relative path.
 * `updated` is YYYY-MM-DD UTC. `tags` is a comma-joined string for the
 * markdown column; arrays are accepted as input and normalised.
 *
 * @typedef {{
 *   path: string,
 *   title: string,
 *   tags?: string | string[],
 *   kind?: string,
 *   updated?: string,
 * }} IndexRow
 */

/**
 * Render the markdown table for `index.md` in a scope. Reverse-chronological
 * — newest `updated` first — matching DESIGN.md §9.3 ("append on top").
 *
 * @param {Scope} scope
 * @param {IndexRow[]} rows
 * @returns {string}
 */
export function renderIndex(scope, rows) {
  const dir = scopeDir(scope);
  const sorted = [...(rows || [])].sort((a, b) => {
    const ax = (b.updated || '').localeCompare(a.updated || '');
    return ax !== 0 ? ax : (a.path || '').localeCompare(b.path || '');
  });
  const lines = [
    `# index — ${dir}`,
    '',
    '| path | title | tags | kind | updated |',
    '| ---- | ----- | ---- | ---- | ------- |',
  ];
  for (const r of sorted) {
    const path = (r.path || '').replace(/\|/g, '\\|');
    const title = (r.title || '').replace(/\|/g, '\\|');
    const tags = Array.isArray(r.tags) ? r.tags.join(',') : (r.tags || '');
    const kind = r.kind || '';
    const updated = r.updated || '';
    lines.push(`| ${path} | ${title} | ${tags} | ${kind} | ${updated} |`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Parse `index.md` markdown table back into an array of rows. Tolerates
 * extra whitespace, missing optional columns, and the index header line.
 * Unknown / malformed lines are skipped silently.
 *
 * @param {string} content
 * @returns {IndexRow[]}
 */
export function parseIndex(content) {
  if (typeof content !== 'string' || !content) return [];
  const out = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    if (/^\|\s*-+/.test(line)) continue; // separator row
    const cols = line.split('|').slice(1, -1).map(s => s.trim());
    if (cols.length < 2) continue;
    const [path, title, tags = '', kind = '', updated = ''] = cols;
    if (!path || path === 'path') continue; // header row
    out.push({
      path,
      title,
      tags: tags ? tags.split(',').map(s => s.trim()).filter(Boolean) : [],
      kind: kind || undefined,
      updated: updated || undefined,
    });
  }
  return out;
}

/**
 * Read `index.md` for a scope and return the parsed rows. Missing index
 * returns `[]` (cold-start scope).
 *
 * @param {Scope} scope
 * @param {{ root?: string }} [opts]
 * @returns {Promise<IndexRow[]>}
 */
export async function readIndex(scope, opts = {}) {
  const { root = DEFAULT_MEMORY_ROOT } = opts;
  const abs = join(root, scopeDir(scope), 'index.md');
  let raw;
  try { raw = await fsp.readFile(abs, 'utf8'); }
  catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  return parseIndex(raw);
}

/**
 * Atomically rewrite `index.md` for a scope.
 *
 * @param {Scope} scope
 * @param {IndexRow[]} rows
 * @param {{ root?: string }} [opts]
 */
export async function writeIndex(scope, rows, opts = {}) {
  const { root = DEFAULT_MEMORY_ROOT } = opts;
  const abs = join(root, scopeDir(scope), 'index.md');
  await atomicWrite(abs, renderIndex(scope, rows));
}

/**
 * Upsert a single row keyed by `path`. Existing row with the same path is
 * replaced; otherwise the row is prepended (kept in reverse-chronological
 * order via `renderIndex`'s sort). Returns the updated row list.
 *
 * @param {Scope} scope
 * @param {IndexRow} row
 * @param {{ root?: string }} [opts]
 * @returns {Promise<IndexRow[]>}
 */
export async function upsertIndexRow(scope, row, opts = {}) {
  if (!row || !row.path) throw new Error('upsertIndexRow: row.path required');
  const rows = await readIndex(scope, opts);
  const filtered = rows.filter(r => r.path !== row.path);
  filtered.unshift(row);
  await writeIndex(scope, filtered, opts);
  return filtered;
}

/**
 * Cap the rows surfaced to the router (DESIGN.md §9.3). Reverse-chrono;
 * default K = 200. Caller passes the merged set; we trim and return.
 *
 * @param {IndexRow[]} rows
 * @param {number} [k=200]
 * @returns {IndexRow[]}
 */
export function capIndexRows(rows, k = 200) {
  if (!Array.isArray(rows)) return [];
  if (rows.length <= k) return rows.slice();
  return rows.slice(0, k);
}

// ─── summary.md ────────────────────────────────────────────────

/**
 * Read the scope's `summary.md`. Empty / missing → ''.
 *
 * @param {Scope} scope
 * @param {{ root?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function readSummary(scope, opts = {}) {
  const { root = DEFAULT_MEMORY_ROOT } = opts;
  const abs = join(root, scopeDir(scope), 'summary.md');
  try { return (await fsp.readFile(abs, 'utf8')).trim(); }
  catch (err) {
    if (err && err.code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Atomically rewrite the scope's `summary.md`. The body is trimmed; empty
 * input writes an empty file (callers that wanted "delete summary" can use
 * `fs.unlink` directly — we don't surface that here).
 *
 * @param {Scope} scope
 * @param {string} body
 * @param {{ root?: string }} [opts]
 */
export async function writeSummary(scope, body, opts = {}) {
  const { root = DEFAULT_MEMORY_ROOT } = opts;
  const abs = join(root, scopeDir(scope), 'summary.md');
  await atomicWrite(abs, `${(body || '').trim()}\n`);
}

// ─── ensure scope on disk ──────────────────────────────────────

/**
 * Best-effort: ensure the scope's directory and an empty `entries/` exist.
 * Idempotent. Use at boot or on first write to avoid ENOENT cascades.
 *
 * @param {Scope} scope
 * @param {{ root?: string }} [opts]
 */
export function ensureScopeSync(scope, opts = {}) {
  const { root = DEFAULT_MEMORY_ROOT } = opts;
  const dir = join(root, scopeDir(scope));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const entries = join(dir, 'entries');
  if (!existsSync(entries)) mkdirSync(entries, { recursive: true });
}
