/**
 * memory/store.js — per-scope memory.md + summary.md (Layer-A storage).
 *
 * One pair of files per scope. No shards, no entries/, no index.md, no
 * index.json. The session-memory scope kinds — user, session, session-vp, session-user, session-topic, chat, and chat-vp — share
 * a single shape:
 *
 *   ~/.yeaft/memory/
 *     user/                    memory.md  summary.md
 *     vp/<vpId>/               memory.md  summary.md
 *  *     feature/<featureId>/     memory.md  summary.md
 *     topic/<l1>[/<l2>]/       memory.md  summary.md     (≤ 2 levels)
 *
 * Atomicity contract:
 *   - Every write goes via `.tmp.<rand>` + rename. Renames are atomic on a
 *     single POSIX mount. A reader mid-write sees either the previous file
 *     or the next, never half of either.
 *   - Reading a missing file returns the empty string. The "scope exists"
 *     question is answered by directory presence, not file presence.
 *
 * Concurrency rules:
 *   - Two writers to the same memory.md: last-rename wins. Dream is the only
 *     code path that overwrites memory.md in v2; daily writes append. Append
 *     is a single fs.appendFile call that POSIX guarantees is atomic for
 *     buffers ≤ PIPE_BUF (≥ 4KB on every supported platform), which fits a
 *     single fragment.
 *
 * ACL:
 *   - This module enforces ONE ACL: `vp/<other>` paths are blocked when
 *     `currentVpId` is given and differs from `<other>`. Every other scope
 *     boundary is ACL-free.
 *
 * What this module deliberately does NOT do:
 *   - No frontmatter parsing. memory.md and summary.md are pure markdown;
 *     the dream-state metadata block lives at the file's tail and is read
 *     by `dream/state.js`, not here.
 *   - No LLM calls, no extraction, no summarisation. Pure I/O.
 *
 * Reference: agent/yeaft/memory/DESIGN-H2-AMS.md.
 */

import {
  promises as fsp,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

/** Default memory root. Tests override via `opts.root`. */
export const DEFAULT_MEMORY_ROOT = join(homedir(), '.yeaft', 'memory');

/** Scope kinds recognised by v2 (group-isolated layout). */
export const SCOPE_KINDS = Object.freeze([
  'user',
  'chat',
  'chat-vp',
  'session',
  'session-user',
  'session-vp',
  'session-topic',
]);

/** @typedef {'user'|'chat'|'chat-vp'|'session'|'session-user'|'session-vp'|'session-topic'} ScopeKind */

/**
 * @typedef {Object} Scope
 * @property {ScopeKind} kind
 * @property {string} [id]        — required for session/chat roots and VP ids
 * @property {string} [sessionId] — required for session-* kinds
 * @property {string[]} [path]    — required for *-topic; 1–2 segments
 */

/**
 * Compute a scope's directory path relative to the memory root.
 * Returns POSIX-style separators on every platform — the segments compose
 * by `/` for `path.join()` to normalise per-OS at the I/O boundary.
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
    case 'chat': {
      if (!scope.id) throw new Error('scopeDir: chat scope requires id');
      assertSafeSegment(scope.id, 'chat.id');
      return `chat/${scope.id}`;
    }
    case 'chat-vp': {
      if (!scope.chatId) throw new Error('scopeDir: chat-vp scope requires chatId');
      if (!scope.id) throw new Error('scopeDir: chat-vp scope requires id');
      assertSafeSegment(scope.chatId, 'chat-vp.chatId');
      assertSafeSegment(scope.id, 'chat-vp.id');
      return `chat/${scope.chatId}/vp/${scope.id}`;
    }
    case 'session': {
      if (!scope.id) throw new Error('scopeDir: session scope requires id');
      assertSafeSegment(scope.id, 'session.id');
      return `session/${scope.id}`;
    }
    case 'session-user': {
      if (!scope.sessionId) throw new Error('scopeDir: session-user scope requires sessionId');
      assertSafeSegment(scope.sessionId, 'session-user.sessionId');
      return `session/${scope.sessionId}/user`;
    }
    case 'session-vp': {
      if (!scope.sessionId) throw new Error('scopeDir: session-vp scope requires sessionId');
      if (!scope.id) throw new Error('scopeDir: session-vp scope requires id');
      assertSafeSegment(scope.sessionId, 'session-vp.sessionId');
      assertSafeSegment(scope.id, 'session-vp.id');
      return `session/${scope.sessionId}/vp/${scope.id}`;
    }
    case 'session-topic': {
      if (!scope.sessionId) throw new Error('scopeDir: session-topic scope requires sessionId');
      assertSafeSegment(scope.sessionId, 'session-topic.sessionId');
      const segs = Array.isArray(scope.path) ? scope.path : [];
      if (segs.length === 0 || segs.length > 2) {
        throw new Error('scopeDir: session-topic.path must have 1 or 2 segments');
      }
      for (const s of segs) assertSafeSegment(s, 'session-topic.path');
      return `session/${scope.sessionId}/topic/${segs.join('/')}`;
    }
    default:
      throw new Error(`scopeDir: unknown kind ${JSON.stringify(scope.kind)}`);
  }
}

/**
 * Reject path segments that could escape the scope dir or hit reserved names.
 * Allows letters, digits, underscore, dash, dot — but rejects `.` / `..` and
 * any segment that contains a path separator. Reserved prefix `_` is allowed
 * for system dirs (`_no-group`, `_proposals`) when called from internal sites,
 * but disallowed for user-supplied ids by callers.
 *
 * @param {string} s
 * @param {string} ctx
 */
function assertSafeSegment(s, ctx) {
  if (typeof s !== 'string' || s.length === 0) {
    throw new Error(`scopeDir: ${ctx} must be a non-empty string`);
  }
  if (s === '.' || s === '..') {
    throw new Error(`scopeDir: ${ctx} cannot be "." or ".."`);
  }
  if (/[\\/]/.test(s)) {
    throw new Error(`scopeDir: ${ctx} cannot contain path separators (got ${JSON.stringify(s)})`);
  }
  // Allow CJK + ASCII identifier-ish characters. Tighten over time if needed.
  if (!/^[A-Za-z0-9_\-.一-鿿]+$/.test(s)) {
    throw new Error(`scopeDir: ${ctx} contains disallowed characters: ${JSON.stringify(s)}`);
  }
}

/**
 * Validate topic depth without throwing on the structural-shape errors that
 * `scopeDir` already covers. Returns true iff `kind=topic` and 1 ≤ path ≤ 2.
 *
 * @param {Scope} scope
 * @returns {boolean}
 */
export function isValidTopic(scope) {
  if (!scope || scope.kind !== 'session-topic') return false;
  if (!scope.sessionId || typeof scope.sessionId !== 'string') return false;
  if (!Array.isArray(scope.path)) return false;
  if (scope.path.length < 1 || scope.path.length > 2) return false;
  for (const s of scope.path) {
    if (typeof s !== 'string' || s.length === 0) return false;
    if (s === '.' || s === '..') return false;
    if (/[\\/]/.test(s)) return false;
    if (!/^[A-Za-z0-9_\-.一-鿿]+$/.test(s)) return false;
  }
  return true;
}

// ─── ACL ───────────────────────────────────────────────────────

/**
 * The single ACL: `session/<id>/vp/<other>` is foreign when `currentVpId` is given.
 * Across sessions, every `session/<id>/vp/...` path is foreign by construction
 * (the calling VP only runs inside its own group dir).
 *
 * @param {string} relPath
 * @param {string} currentVpId
 * @returns {boolean}
 */
export function isVpForeign(relPath, currentVpId) {
  if (!relPath || !currentVpId) return false;
  const m = /^(?:chat|session)\/[^/]+\/vp\/([^/]+)(?:\/|$)/.exec(relPath);
  if (!m) return false;
  return m[1] !== currentVpId;
}

function enforceVpAcl(rel, currentVpId) {
  if (currentVpId && isVpForeign(rel, currentVpId)) {
    const e = new Error('acl_blocked');
    e.code = 'acl_blocked';
    e.path = rel;
    throw e;
  }
}

// ─── atomic write ──────────────────────────────────────────────

/**
 * Atomic write: temp + rename. Creates parent directories on demand.
 * @param {string} absPath
 * @param {string} content
 */
async function atomicWrite(absPath, content) {
  await fsp.mkdir(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, absPath);
}

// ─── memory.md ─────────────────────────────────────────────────

/**
 * Read a scope's memory.md. Missing → empty string.
 *
 * @param {Scope} scope
 * @param {{ root?: string, currentVpId?: string, language?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function readMemory(scope, opts = {}) {
  const { root = DEFAULT_MEMORY_ROOT, currentVpId } = opts;
  const rel = `${scopeDir(scope)}/memory.md`;
  enforceVpAcl(rel, currentVpId);
  const abs = join(root, rel);
  try { return await fsp.readFile(abs, 'utf8'); }
  catch (err) {
    if (err && err.code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Atomically rewrite a scope's memory.md.
 *
 * @param {Scope} scope
 * @param {string} content
 * @param {{ root?: string, currentVpId?: string }} [opts]
 */
export async function writeMemory(scope, content, opts = {}) {
  const { root = DEFAULT_MEMORY_ROOT, currentVpId } = opts;
  const rel = `${scopeDir(scope)}/memory.md`;
  enforceVpAcl(rel, currentVpId);
  const abs = join(root, rel);
  await atomicWrite(abs, typeof content === 'string' ? content : '');
}

/**
 * Append to a scope's memory.md. Used by the rare "direct write" path;
 * main flow is dream-driven rewrites.
 *
 * Append is non-atomic with concurrent readers in the strict sense, but a
 * single appendFile of a small buffer is atomic at the kernel level on POSIX
 * — sufficient for fragment-sized appends. Two concurrent appenders may
 * interleave bytes only if both buffers exceed PIPE_BUF; we keep callers in
 * the single-buffer regime.
 *
 * @param {Scope} scope
 * @param {string} chunk
 * @param {{ root?: string, currentVpId?: string }} [opts]
 */
export async function appendMemory(scope, chunk, opts = {}) {
  const { root = DEFAULT_MEMORY_ROOT, currentVpId } = opts;
  const rel = `${scopeDir(scope)}/memory.md`;
  enforceVpAcl(rel, currentVpId);
  const abs = join(root, rel);
  await fsp.mkdir(dirname(abs), { recursive: true });
  const text = typeof chunk === 'string' ? chunk : '';
  if (text.length === 0) return;
  await fsp.appendFile(abs, text, 'utf8');
}

// ─── summary.md ────────────────────────────────────────────────


function summaryFileName(language) {
  const normalized = String(language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  return normalized === 'zh' ? 'summary.zh.md' : 'summary.md';
}

function summaryCandidateRels(scope, language) {
  const dir = scopeDir(scope);
  const primary = `${dir}/${summaryFileName(language)}`;
  const fallback = `${dir}/summary.md`;
  return primary === fallback ? [fallback] : [primary, fallback];
}

/**
 * Read a scope's summary.md (trimmed). Missing → empty string.
 *
 * @param {Scope} scope
 * @param {{ root?: string, currentVpId?: string, language?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function readSummary(scope, opts = {}) {
  const { root = DEFAULT_MEMORY_ROOT, currentVpId, language } = opts;
  for (const rel of summaryCandidateRels(scope, language)) {
    enforceVpAcl(rel, currentVpId);
    const abs = join(root, rel);
    try { return (await fsp.readFile(abs, 'utf8')).trim(); }
    catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
  }
  return '';
}

/**
 * Atomically rewrite a scope's summary.md. Empty body → empty file.
 *
 * @param {Scope} scope
 * @param {string} body
 * @param {{ root?: string, currentVpId?: string, language?: string }} [opts]
 */
export async function writeSummary(scope, body, opts = {}) {
  const { root = DEFAULT_MEMORY_ROOT, currentVpId, language } = opts;
  const rel = `${scopeDir(scope)}/${summaryFileName(language)}`;
  enforceVpAcl(rel, currentVpId);
  const abs = join(root, rel);
  await atomicWrite(abs, `${(body || '').trim()}\n`);
}

/**
 * Seed a scope's summary.md if (and only if) it is missing or empty. Used
 * at create-time for VPs and groups so a fresh session has SOMETHING for
 * `engine.#prepareAms` to pull into the Layer-A resident summary — the
 * earlier behavior of "no summary.md until Dream-v2 runs" left the memory
 * section empty for the entire first session.
 *
 * Intentionally a no-op if a non-empty summary.md already exists, so this
 * is safe to call from any place that creates the scope (VP create, group
 * create, first-session bootstrap) without clobbering Dream-v2's writes.
 *
 * @param {Scope} scope
 * @param {string} body
 * @param {{ root?: string, currentVpId?: string }} [opts]
 * @returns {Promise<boolean>}  true if seeded, false if a non-empty summary already existed
 */
export async function seedSummaryIfMissing(scope, body, opts = {}) {
  const existing = await readSummary(scope, opts);
  if (existing && existing.trim().length > 0) return false;
  await writeSummary(scope, body, opts);
  return true;
}

/**
 * Sync variant of `seedSummaryIfMissing` for synchronous CRUD entry points
 * (vp-crud.js / group-crud.js / seed-default.js). Same idempotency contract:
 * a non-empty existing `summary.md` blocks the seed; missing or empty
 * triggers an atomic write. Failures are converted into thrown errors so
 * the caller can decide whether to swallow (best-effort seed) or surface.
 *
 * NOTE on `opts.root`: callers MUST pass the configured memory root
 * (typically `<yeaftDir>/memory`) so a non-default `yeaftDir` doesn't end
 * up writing under `~/.yeaft/memory/`. The default is provided only for
 * top-of-tree convenience; production code paths thread the root through.
 *
 * @param {Scope} scope
 * @param {string} body
 * @param {{ root?: string }} [opts]
 * @returns {boolean}  true if seeded, false if a non-empty summary already existed
 */
export function seedSummaryIfMissingSync(scope, body, opts = {}) {
  const { root = DEFAULT_MEMORY_ROOT } = opts;
  const rel = `${scopeDir(scope)}/summary.md`;
  const abs = join(root, rel);
  let existing = '';
  if (existsSync(abs)) {
    try { existing = readFileSync(abs, 'utf8').trim(); }
    catch { /* read race — fall through to seed */ }
  }
  if (existing) return false;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${(body || '').trim()}\n`, 'utf8');
  return true;
}

/**
 * Synchronously remove a scope's directory under the memory root. Used by
 * `deleteVp` / `deleteSession` to cascade memory cleanup so a recreate of the
 * same id doesn't see stale `summary.md` / `memory.md` / `segments/` files.
 *
 * Idempotent — missing directory is a no-op.
 *
 * @param {Scope} scope
 * @param {{ root?: string }} [opts]
 */
export function removeScopeDirSync(scope, opts = {}) {
  const { root = DEFAULT_MEMORY_ROOT } = opts;
  const abs = join(root, scopeDir(scope));
  if (!existsSync(abs)) return;
  rmSync(abs, { recursive: true, force: true });
}

// ─── scope discovery ───────────────────────────────────────────

/**
 * Best-effort: ensure a scope's directory exists. Idempotent.
 *
 * @param {Scope} scope
 * @param {{ root?: string }} [opts]
 */
export function ensureScopeSync(scope, opts = {}) {
  const { root = DEFAULT_MEMORY_ROOT } = opts;
  const dir = join(root, scopeDir(scope));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Async variant of ensureScopeSync.
 *
 * @param {Scope} scope
 * @param {{ root?: string }} [opts]
 */
export async function ensureScope(scope, opts = {}) {
  const { root = DEFAULT_MEMORY_ROOT } = opts;
  const dir = join(root, scopeDir(scope));
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * Enumerate all scopes present on disk. Returns Scope shapes that round-trip
 * back through `scopeDir`. Used by Triage to list candidate scopes.
 *
 * Walks shallowly:
 *   user/                                  → { kind: 'user' }
 *   session/<id>/                             → { kind: 'session', id }
 * Skips `.legacy/` and any dotfile / unsafe segment.
 *
 * @param {{ root?: string }} [opts]
 * @returns {Promise<Scope[]>}
 */
export async function listScopes(opts = {}) {
  const { root = DEFAULT_MEMORY_ROOT } = opts;
  const out = [];
  if (!existsSync(root)) return out;

  // user/
  if (existsSync(join(root, 'user'))) out.push({ kind: 'user' });

  // chat/<c>/  and  chat/<c>/vp/<v>/
  const chatRoot = join(root, 'chat');
  let chats;
  try { chats = await fsp.readdir(chatRoot, { withFileTypes: true }); }
  catch (err) {
    if (err && err.code === 'ENOENT') chats = [];
    else throw err;
  }
  for (const cent of chats) {
    if (!cent.isDirectory()) continue;
    if (cent.name.startsWith('.')) continue;
    if (!isSafeId(cent.name)) continue;
    const c = cent.name;
    out.push({ kind: 'chat', id: c });
    const vpDir = join(chatRoot, c, 'vp');
    let vps;
    try { vps = await fsp.readdir(vpDir, { withFileTypes: true }); }
    catch { vps = []; }
    for (const vent of vps) {
      if (!vent.isDirectory()) continue;
      if (!isSafeId(vent.name)) continue;
      out.push({ kind: 'chat-vp', chatId: c, id: vent.name });
    }
  }

  // session/<s>/  and  session/<s>/vp/<v>/
  const sessionRoot = join(root, 'session');
  let sessions;
  try { sessions = await fsp.readdir(sessionRoot, { withFileTypes: true }); }
  catch (err) {
    if (err && err.code === 'ENOENT') sessions = [];
    else throw err;
  }
  for (const sent of sessions) {
    if (!sent.isDirectory()) continue;
    if (sent.name.startsWith('.')) continue;
    if (!isSafeId(sent.name)) continue;
    const s = sent.name;
    out.push({ kind: 'session', id: s });
    if (existsSync(join(sessionRoot, s, 'user'))) {
      out.push({ kind: 'session-user', sessionId: s });
    }

    const vpDir = join(sessionRoot, s, 'vp');
    let vps;
    try { vps = await fsp.readdir(vpDir, { withFileTypes: true }); }
    catch { vps = []; }
    for (const vent of vps) {
      if (!vent.isDirectory()) continue;
      if (!isSafeId(vent.name)) continue;
      out.push({ kind: 'session-vp', sessionId: s, id: vent.name });
    }

    const topicDir = join(sessionRoot, s, 'topic');
    let l1s;
    try { l1s = await fsp.readdir(topicDir, { withFileTypes: true }); }
    catch (err) {
      if (err && err.code === 'ENOENT') l1s = [];
      else throw err;
    }
    for (const l1ent of l1s) {
      if (!l1ent.isDirectory()) continue;
      if (!isSafeId(l1ent.name)) continue;
      out.push({ kind: 'session-topic', sessionId: s, path: [l1ent.name] });
      const l2dir = join(topicDir, l1ent.name);
      let l2s;
      try { l2s = await fsp.readdir(l2dir, { withFileTypes: true }); }
      catch { l2s = []; }
      for (const l2ent of l2s) {
        if (!l2ent.isDirectory()) continue;
        if (!isSafeId(l2ent.name)) continue;
        out.push({ kind: 'session-topic', sessionId: s, path: [l1ent.name, l2ent.name] });
      }
    }
  }

  return out;
}

function isSafeId(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  if (s === '.' || s === '..') return false;
  if (/[\\/]/.test(s)) return false;
  return /^[A-Za-z0-9_\-.一-鿿]+$/.test(s);
}
