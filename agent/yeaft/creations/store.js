import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, extname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeAtomic } from '../storage/atomic.js';
import {
  CREATION_KINDS, MODALITIES, MODALITY_BY_KIND, CREATION_STATUSES, CANON_TYPES, NODE_STATUSES, PROPOSAL_STATUSES, RUN_STATUSES,
  LIMITS, boundedText, decodeBase64, defaultCelestialPlacement, fail, safeId,
} from './constants.js';
import { parseSource, searchTerms, sniffSourceMimeType } from './source-parser.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS creations (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS creation_import_keys (
  import_key TEXT PRIMARY KEY, creation_id TEXT NOT NULL UNIQUE REFERENCES creations ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS creation_sources (
  creation_id TEXT NOT NULL REFERENCES creations ON DELETE CASCADE, id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (creation_id, id));
CREATE TABLE IF NOT EXISTS creation_assets (
  creation_id TEXT NOT NULL REFERENCES creations ON DELETE CASCADE, id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (creation_id, id));
CREATE TABLE IF NOT EXISTS creation_canon (
  creation_id TEXT NOT NULL REFERENCES creations ON DELETE CASCADE, id TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, pinned INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (creation_id, id));
CREATE VIRTUAL TABLE IF NOT EXISTS creation_canon_fts USING fts5(title, body, creation_id UNINDEXED, id UNINDEXED);
CREATE TRIGGER IF NOT EXISTS creation_canon_insert AFTER INSERT ON creation_canon BEGIN
  INSERT INTO creation_canon_fts(rowid,title,body,creation_id,id) VALUES(new.rowid,new.title,new.body,new.creation_id,new.id);
END;
CREATE TRIGGER IF NOT EXISTS creation_canon_remove AFTER DELETE ON creation_canon BEGIN
  DELETE FROM creation_canon_fts WHERE rowid=old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS creation_canon_update AFTER UPDATE ON creation_canon BEGIN
  DELETE FROM creation_canon_fts WHERE rowid=old.rowid;
  INSERT INTO creation_canon_fts(rowid,title,body,creation_id,id) VALUES(new.rowid,new.title,new.body,new.creation_id,new.id);
END;
CREATE TABLE IF NOT EXISTS creation_nodes (
  creation_id TEXT NOT NULL REFERENCES creations ON DELETE CASCADE, id TEXT NOT NULL, parent_id TEXT,
  position INTEGER NOT NULL, current_rev_id TEXT, readable INTEGER NOT NULL, words INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (creation_id, id), FOREIGN KEY (creation_id,parent_id) REFERENCES creation_nodes ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS creation_node_order ON creation_nodes(creation_id,parent_id,position,id);
CREATE TABLE IF NOT EXISTS creation_revisions (
  creation_id TEXT NOT NULL, node_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (creation_id,node_id,id), FOREIGN KEY (creation_id,node_id) REFERENCES creation_nodes ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS creation_proposals (
  creation_id TEXT NOT NULL REFERENCES creations ON DELETE CASCADE, id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (creation_id,id));
CREATE INDEX IF NOT EXISTS creation_proposal_status ON creation_proposals(creation_id,status);
CREATE TABLE IF NOT EXISTS creation_threads (
  creation_id TEXT NOT NULL REFERENCES creations ON DELETE CASCADE, id TEXT NOT NULL,
  scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (creation_id,id), UNIQUE (creation_id,scope_type,scope_id));
CREATE TABLE IF NOT EXISTS creation_messages (
  creation_id TEXT NOT NULL, thread_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (creation_id,thread_id,id), FOREIGN KEY (creation_id,thread_id) REFERENCES creation_threads ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS creation_message_thread ON creation_messages(creation_id,thread_id);
CREATE TABLE IF NOT EXISTS creation_runs (
  creation_id TEXT NOT NULL REFERENCES creations ON DELETE CASCADE, id TEXT NOT NULL,
  status TEXT NOT NULL, boot_id TEXT NOT NULL, lease_epoch INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (creation_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS creation_run_running ON creation_runs(creation_id) WHERE status='running';
`;
const now = () => new Date().toISOString();
const json = value => JSON.stringify(value);
const PAGE_BYTES = 1.5 * 1024 * 1024;
const jsonBytes = value => Buffer.byteLength(json(value));
const clipBytes = (value, max) => {
  const bytes = Buffer.from(value.slice(0, max));
  // Skip an incomplete UTF-8 character at the boundary.
  return new TextDecoder().decode(bytes.subarray(0, max), { stream: true });
};
const nodeFields = node => ({ ...node, sortOrder: node.position, isFolder: node.type === 'folder', batchEligible: node.type === 'unit' && node.status !== 'final' && !node.userEdited });

export function compactProposal({ proposedContent, patch, anchor, summary, ...proposal }) {
  const content = proposedContent ?? patch?.contentMd ?? '';
  return { ...proposal, ...(patch ? { patch: { id: patch.id, title: patch.title, type: patch.type, pinned: patch.pinned } } : {}),
    summary: clipBytes(summary ?? '', 2048), preview: clipBytes(typeof content === 'string' ? content : json(content), 2048) };
}
const data = row => row ? JSON.parse(row.data) : null;
const idFor = input => input == null ? randomUUID() : safeId(input);
const notFound = name => fail('NOT_FOUND', `${name} not found`);
const pick = (value, valid, name) => valid.includes(value) ? value : fail('INVALID_REQUEST', `Invalid ${name}`);
const text = (value, limit, name) => boundedText(value, limit, name);
const title = value => boundedText(value, 512, 'title', { required: true });
const own = (obj, key) => Object.hasOwn(obj, key);
export function boundedList(value, max, name) {
  if (!Array.isArray(value) || value.length > max) fail('INVALID_REQUEST', `Invalid ${name}`);
  return value;
}

function contains(root, path) {
  const rel = relative(root, path);
  return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
function optionalLinkId(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.includes('\0')) fail('INVALID_REQUEST', `Invalid ${name}`);
  const trimmed = value.trim();
  if (trimmed.length > 256) fail('INVALID_REQUEST', `Invalid ${name}`);
  return trimmed || null;
}
function folderPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !value.isWellFormed()) {
    fail('INVALID_REQUEST', 'Invalid rootDir');
  }
  return resolve(value);
}
function existingFolder(value) {
  const path = folderPath(value);
  if (value.length > 4096) fail('INVALID_REQUEST', 'Invalid rootDir');
  let canonical;
  try {
    canonical = fs.realpathSync(path);
    if (!fs.statSync(canonical).isDirectory()) canonical = null;
  } catch { /* missing or inaccessible directory */ }
  if (!canonical || canonical.length > 4096) fail('INVALID_REQUEST', 'rootDir must be an existing directory');
  return canonical;
}
function workspaceName(value, fallback) {
  let name = value.replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').trim().replace(/^\.+|[. ]+$/g, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return clipBytes(name, 180).replace(/[. ]+$/g, '') || fallback;
}
const WORKSPACE_DIRS = ['docs', 'images', 'videos', 'sources'];
const IMAGE_EXT = /^(?:png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?)$/i;
const VIDEO_EXT = /^(?:mp4|webm|mov|mkv|avi|ogv|m4v|mpeg|mpg)$/i;

function contentRecord(value, modality) {
  if (modality === 'markdown_doc' && typeof value !== 'string') fail('INVALID_REQUEST', 'Markdown content must be a string');
  if (typeof value !== 'string' && (!value || typeof value !== 'object')) fail('INVALID_REQUEST', 'Invalid unit content');
  const structured = typeof value !== 'string';
  const encoded = structured ? json(value) : value;
  boundedText(encoded, LIMITS.nodeBytes, 'unit content');
  let words = 0;
  let readable = false;
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') {
      readable ||= !!item.trim();
      words += item.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
    } else if (item && typeof item === 'object') {
      for (const child of Object.values(item)) pending.push(child);
    } else if (typeof item === 'number' || typeof item === 'boolean') readable = true;
  }
  return { encoded, structured, words, readable };
}

const ASSET_TYPES = {
  md: 'text/markdown', json: 'application/json', svg: 'image/svg+xml', html: 'text/html', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};
function validAsset(ext, bytes) {
  switch (ext) {
    case 'md': case 'json': return true; // UTF-8 export buffers, always downloaded.
    case 'svg': return /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(bytes.toString('utf8'));
    case 'html': return /^\s*(?:<!doctype\s+html\b|<[a-z][\w-]*(?:\s|>))/i.test(bytes.toString('utf8'));
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': return sniffSourceMimeType(bytes) === ASSET_TYPES[ext];
    default: return false;
  }
}

export class CreationStore {
  constructor({ yeaftDir, storageRoot, namespaceKey, namespaceBinding, readOnly = false }) {
    if (!yeaftDir) fail('INVALID_REQUEST', 'Missing Agent data directory');
    if (readOnly && storageRoot == null && !fs.existsSync(yeaftDir)) notFound('Creations storage');
    if (!readOnly) fs.mkdirSync(yeaftDir, { recursive: true, mode: 0o700 });
    const base = storageRoot == null ? join(fs.realpathSync(yeaftDir), 'creations') : resolve(storageRoot);
    if (readOnly && !fs.lstatSync(base, { throwIfNoEntry: false })) notFound('Creations storage');
    if (!readOnly) fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(base) !== base) fail('INVALID_PATH', 'Invalid Creations storage directory');
    const root = namespaceKey == null ? base : join(base, `ns-${safeId(namespaceKey)}`);
    if (namespaceKey != null || namespaceBinding != null) {
      const { serverUrl, agentId, ownerId } = namespaceBinding ?? {};
      if (![serverUrl, agentId, ownerId].every(value => typeof value === 'string' && value && !value.includes('\0'))
        || createHash('sha256').update(`${serverUrl}\0${agentId}\0${ownerId}`).digest('hex').slice(0, 24) !== namespaceKey) {
        fail('INVALID_REQUEST', 'Invalid Creations namespace binding');
      }
      if (readOnly && !fs.lstatSync(root, { throwIfNoEntry: false })) notFound('Creations namespace');
      if (!readOnly) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(root) !== root) fail('INVALID_PATH', 'Invalid Creations namespace directory');
      const marker = join(root, '.namespace.json');
      const binding = { serverUrl, agentId, ownerId };
      if (!fs.lstatSync(marker, { throwIfNoEntry: false })) {
        if (readOnly) fail('INVALID_PATH', 'Creations namespace is missing its binding');
        if (fs.readdirSync(root).length) fail('INVALID_PATH', 'Creations namespace is missing its binding');
        try { fs.writeFileSync(marker, json(binding), { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const stat = fs.lstatSync(marker);
      if (!stat.isFile() || stat.size > 32768) fail('INVALID_PATH', 'Invalid Creations namespace marker');
      let saved;
      try { saved = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { /* reject malformed bindings */ }
      if (saved?.serverUrl !== serverUrl || saved?.agentId !== agentId || saved?.ownerId !== ownerId) {
        fail('INVALID_PATH', 'Creations namespace binding does not match');
      }
    }
    this.root = root;
    this.dbPath = join(root, 'creations.db');
    for (const path of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      const stat = fs.lstatSync(path, { throwIfNoEntry: false });
      if (stat && !stat.isFile()) fail('INVALID_PATH', 'Invalid Creations database path');
      if (readOnly && path === this.dbPath && !stat) notFound('Creations database');
    }
    this.db = new DatabaseSync(this.dbPath, { readOnly });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      if (!readOnly) {
        this.db.exec('PRAGMA journal_mode=WAL;');
        this.transaction(() => this.db.exec(SCHEMA));
      }
    } catch (error) { this.db.close(); throw error; }
  }

  close() { this.db.close(); }
  transaction(fn) {
    if (this.tx) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    const tx = this.tx = { rollback: [], afterCommit: [] };
    try {
      const result = fn();
      this.db.exec('COMMIT');
      for (const cleanup of tx.afterCommit) cleanup();
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      for (const cleanup of tx.rollback.reverse()) cleanup();
      throw error;
    } finally { this.tx = null; }
  }
  one(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }

  #path(creationId, ...parts) { return join(this.root, safeId(creationId), ...parts); }
  #directory(path) {
    if (!contains(this.root, path)) fail('INVALID_PATH', 'Invalid Creations file path');
    let current = this.root;
    if (fs.realpathSync(current) !== current) fail('INVALID_PATH', 'Invalid Creations directory');
    for (const part of relative(this.root, path).split(sep)) {
      current = join(current, part);
      fs.mkdirSync(current, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(current) !== current) fail('INVALID_PATH', 'Invalid Creations directory');
    }
  }
  #write(path, bytes) {
    this.#directory(dirname(path));
    if (fs.lstatSync(path, { throwIfNoEntry: false })) fail('CONFLICT', 'Creation file already exists');
    writeAtomic(path, bytes, { mode: 0o600 });
    this.tx.rollback.push(() => {
      this.#remove(path);
      // Clean newly empty directories after a failed multi-record operation.
      for (let dir = dirname(path); contains(this.root, dir); dir = dirname(dir)) {
        try { if (fs.realpathSync(dir) !== dir) break; fs.rmdirSync(dir); } catch { break; }
      }
    });
  }
  #remove(path) {
    // Never follow a substituted ancestor when cleaning a committed deletion.
    try {
      if (fs.realpathSync(dirname(path)) === dirname(path) && contains(this.root, path)) {
        fs.rmSync(path, { recursive: true, force: true });
      }
    } catch { /* unreachable files are not exposed by the database */ }
  }
  #open(creationId, path) {
    const creationRoot = this.#path(creationId);
    let real;
    try { real = fs.realpathSync(path); }
    catch (error) { if (error.code === 'ENOENT') notFound('Creation file'); throw error; }
    if (real !== resolve(path) || !contains(creationRoot, real)) fail('INVALID_PATH', 'Invalid Creations file path');
    const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) fail('INVALID_PATH', 'Creation media must be a regular file');
      // Verify the opened descriptor as well on Linux; ancestors can be
      // replaced between realpath and open even with O_NOFOLLOW.
      if (process.platform === 'linux' && fs.existsSync('/proc/self/fd')
        && fs.readlinkSync(`/proc/self/fd/${fd}`) !== real) fail('INVALID_PATH', 'Creations file changed during open');
      return { fd, size: stat.size };
    } catch (error) { fs.closeSync(fd); throw error; }
  }
  #readBytes(creationId, path, limit) {
    const { fd, size } = this.#open(creationId, path);
    try {
      if (size > limit) fail('LIMIT_EXCEEDED', 'Creation file is too large');
      const result = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const count = fs.readSync(fd, result, offset, size - offset, offset);
        if (!count) break;
        offset += count;
      }
      return result.subarray(0, offset);
    } finally { fs.closeSync(fd); }
  }
  #read(creationId, path, limit) { return this.#readBytes(creationId, path, limit).toString('utf8'); }
  #touch(id) { this.run('UPDATE creations SET updated_at=? WHERE id=?', now(), id); }
  #creation(id) {
    return this.one('SELECT * FROM creations WHERE id=?', safeId(id)) ?? notFound('Creation');
  }
  #summary(row) {
    const counts = this.one(`SELECT COUNT(*) AS unitCount, COALESCE(SUM(readable),0) AS readableUnitCount,
      COALESCE(SUM(words),0) AS wordCount FROM creation_nodes WHERE creation_id=? AND json_extract(data,'$.type')='unit'`, row.id);
    const totals = this.one(`SELECT (SELECT COUNT(*) FROM creation_sources WHERE creation_id=?) AS sourceCount,
      (SELECT COUNT(*) FROM creation_proposals WHERE creation_id=? AND status='pending') AS pendingProposalCount`, row.id, row.id);
    const active = data(this.one(`SELECT data FROM creation_runs WHERE creation_id=? AND status IN ('running','paused')
      ORDER BY status='running' DESC,rowid DESC LIMIT 1`, row.id));
    const { ownsWorkspace, ...rec } = data(row);
    return { ...rec, sessionId: rec.sessionId ?? null, projectId: rec.projectId ?? null, rootDir: rec.rootDir ?? null,
      summary: rec.description || rec.mission || '', celestial: rec.placement, updatedAt: row.updated_at, ...counts, ...totals, hasReadableContent: counts.readableUnitCount > 0,
      activeRunStatus: active?.status ?? null, activeRunProgress: active?.progress?.total > 0 ? active.progress.completed / active.progress.total : null };
  }
  listCreations() { return this.all('SELECT * FROM creations ORDER BY updated_at DESC,id').map(row => this.#summary(row)); }
  getCreation(id) { return this.#summary(this.#creation(id)); }
  createCreation(input) {
    return this.transaction(() => {
      const { importKey } = input;
      if (importKey !== undefined) {
        if (typeof importKey !== 'string' || importKey.length > 128 || !importKey.trim() || importKey.includes('\0')
          || !importKey.isWellFormed()) fail('INVALID_REQUEST', 'Invalid import key');
        const existing = this.one('SELECT creation_id FROM creation_import_keys WHERE import_key=?', importKey);
        if (existing) return { ...this.getCreation(existing.creation_id), deduplicated: true };
      }
      if (input.initializeFolder !== undefined && typeof input.initializeFolder !== 'boolean') {
        fail('INVALID_REQUEST', 'Invalid initializeFolder');
      }
      const id = idFor(input.id);
      const kind = pick(input.kind ?? 'book', CREATION_KINDS, 'creation kind');
      const modality = input.modality ?? MODALITY_BY_KIND[kind];
      if (modality !== MODALITY_BY_KIND[kind]) fail('INVALID_REQUEST', 'Modality does not match creation kind');
      if (this.one('SELECT id FROM creations WHERE id=?', id) || fs.lstatSync(this.#path(id), { throwIfNoEntry: false })) {
        fail('CONFLICT', 'Creation identifier is in use');
      }
      const index = this.one('SELECT COUNT(*) AS count FROM creations').count;
      const createdAt = now();
      const record = this.#creationFields({ id, kind, modality, createdAt, title: 'Untitled creation',
        mission: '', description: '', status: 'draft', readingNodeId: null, readingOffset: 0,
        sessionId: null, projectId: null, rootDir: null, placement: defaultCelestialPlacement(kind, index) }, input);
      if (input.initializeFolder === true && record.rootDir === null) this.#initializeWorkspace(record);
      this.run('INSERT INTO creations VALUES (?,?,?)', id, createdAt, json(record));
      if (importKey !== undefined) this.run('INSERT INTO creation_import_keys VALUES (?,?)', importKey, id);
      return this.getCreation(id);
    });
  }
  #creationFields(record, input) {
    for (const key of ['sessionId', 'projectId']) if (own(input, key)) record[key] = optionalLinkId(input[key], key);
    if (own(input, 'rootDir')) {
      const rootDir = input.rootDir == null ? null : existingFolder(input.rootDir);
      if (rootDir !== record.rootDir) delete record.ownsWorkspace;
      record.rootDir = rootDir;
    }
    if (own(input, 'title')) record.title = title(input.title);
    for (const key of ['mission', 'description']) if (own(input, key)) record[key] = text(input[key], LIMITS.promptBytes, key);
    if (own(input, 'summary') && !own(input, 'description')) record.description = text(input.summary, LIMITS.promptBytes, 'description');
    if (own(input, 'status')) record.status = pick(input.status, CREATION_STATUSES, 'creation status');
    if (own(input, 'readingNodeId')) record.readingNodeId = input.readingNodeId == null ? null : safeId(input.readingNodeId);
    if (own(input, 'readingOffset')) {
      const offset = Number(input.readingOffset);
      if (!Number.isFinite(offset) || offset < 0) fail('INVALID_REQUEST', 'Invalid reading offset');
      record.readingOffset = offset;
    }
    const placement = input.placement ?? input.celestialPlacement ?? input.celestial;
    if (placement != null) {
      if (typeof placement !== 'object' || Array.isArray(placement)) fail('INVALID_REQUEST', 'Invalid celestial placement');
      for (const [key, value] of Object.entries(placement)) {
        if (!own(record.placement, key) || !Number.isFinite(value)) fail('INVALID_REQUEST', 'Invalid celestial placement');
        record.placement[key] = value;
      }
    }
    return record;
  }
  updateCreation(id, patch) {
    return this.transaction(() => {
      const record = this.#creationFields(data(this.#creation(id)), patch);
      this.run('UPDATE creations SET updated_at=?,data=? WHERE id=?', now(), json(record), id);
      return this.getCreation(id);
    });
  }
  deleteCreation(id) {
    return this.transaction(() => {
      const record = data(this.#creation(id));
      if (this.one("SELECT id FROM creation_runs WHERE creation_id=? AND status='running'", id)) fail('BUSY', 'Creation has an active run');
      this.run('DELETE FROM creations WHERE id=?', id);
      this.tx.afterCommit.push(() => this.#remove(this.#path(id)));
      if (record.ownsWorkspace === true && record.rootDir === this.#workspacePath(id)) {
        this.tx.afterCommit.push(() => this.#remove(record.rootDir));
      }
      return { deleted: true, id };
    });
  }

  #workspacePath(id) { return join(this.root, 'workspaces', safeId(id)); }
  #workspaceDirectory(root, path, onCreate) {
    if (path !== root && !contains(root, path)) fail('INVALID_PATH', 'Invalid workspace path');
    let current = root;
    if (fs.realpathSync(current) !== current) fail('INVALID_PATH', 'Invalid workspace root');
    if (path === root) return path;
    for (const part of relative(root, path).split(sep)) {
      current = join(current, part);
      try {
        fs.mkdirSync(current, { mode: 0o700 });
        const created = current;
        const { dev, ino } = fs.lstatSync(created);
        this.tx.rollback.push(() => {
          try {
            if (fs.realpathSync(created) !== created) return;
            const stat = fs.lstatSync(created);
            if (stat.dev === dev && stat.ino === ino) fs.rmdirSync(created);
          } catch { /* not empty or no longer ours */ }
        });
        if (current === path) onCreate?.();
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (!fs.lstatSync(current).isDirectory() || fs.realpathSync(current) !== current) {
        fail('INVALID_PATH', 'Invalid workspace directory');
      }
    }
    return path;
  }
  #writeWorkspaceFile(root, dir, name, bytes, { dedupe = true } = {}) {
    if (!contains(root, dir) && dir !== root) fail('INVALID_PATH', 'Invalid workspace path');
    if (fs.realpathSync(dir) !== dir) fail('INVALID_PATH', 'Invalid workspace directory');
    const path = join(dir, name);
    if (!contains(root, path) || dirname(path) !== dir) fail('INVALID_PATH', 'Invalid workspace filename');
    if (!dedupe && fs.lstatSync(path, { throwIfNoEntry: false })) return;
    const staging = join(dir, `.creation-${randomUUID()}`);
    const ext = extname(name);
    try {
      writeAtomic(staging, bytes, { mode: 0o600 });
      const { dev, ino } = fs.lstatSync(staging);
      for (let index = 1; ; index++) {
        const dest = index === 1 ? path : join(dir, `${name.slice(0, name.length - ext.length)}-${index}${ext}`);
        try {
          // Unlike rename, linking a fully written file will not replace a concurrent writer's file.
          fs.linkSync(staging, dest);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (!dedupe) return;
          continue;
        }
        this.tx.rollback.push(() => {
          try {
            if (fs.realpathSync(dir) !== dir) return;
            const stat = fs.lstatSync(dest);
            if (stat.dev === dev && stat.ino === ino) fs.unlinkSync(dest);
          } catch { /* file no longer reachable */ }
        });
        break;
      }
    } finally {
      try { fs.unlinkSync(staging); } catch { /* staging file may not have been published */ }
    }
  }
  #initializeWorkspace(record, rootDir = null) {
    if (rootDir == null) {
      // Legacy creations store files directly under their ID, including the formerly valid ID "workspaces".
      if (record.id === 'workspaces' || this.one("SELECT id FROM creations WHERE id='workspaces'")) {
        fail('CONFLICT', 'Dedicated workspace storage conflicts with a legacy Creation identifier');
      }
      const path = this.#workspacePath(record.id);
      this.#workspaceDirectory(this.root, dirname(path));
      // Only claim ownership if we create the directory, not if the user already put one here.
      let created = false;
      rootDir = existingFolder(this.#workspaceDirectory(this.root, path, () => { created = true; }));
      record.ownsWorkspace = created;
    } else {
      delete record.ownsWorkspace;
    }
    record.rootDir = rootDir;
    for (const name of WORKSPACE_DIRS) this.#workspaceDirectory(rootDir, join(rootDir, name));
    this.#writeWorkspaceFile(rootDir, rootDir, 'README.md', `# ${record.title}\n\n${record.mission || record.description}\n`, { dedupe: false });
  }
  #copyWorkspaceSource(root, source, bytes, { legacy = false } = {}) {
    let name = source.name;
    if (name.split(/[\\/]/).includes('..')) {
      if (!legacy) fail('INVALID_REQUEST', 'Invalid workspace source filename');
      // Old uploads could use traversal-like display names. Recover their bytes under a safe ID.
      name = source.id;
    }
    const dir = this.#workspaceDirectory(root, join(root, 'sources'));
    this.#writeWorkspaceFile(root, dir, workspaceName(name, 'Source'), bytes);
  }
  #materializeWorkspace(id, root) {
    const visit = (nodes, dir) => {
      const folders = new Set(dir === join(root, 'docs') ? ['canon'] : []);
      for (const node of nodes) {
        const name = workspaceName(node.title, node.id);
        if (node.type === 'folder') {
          for (let index = 1; ; index++) {
            const folder = index === 1 ? name : `${name}-${index}`;
            if (folders.has(folder.toLowerCase())) continue;
            const path = join(dir, folder);
            const existing = fs.lstatSync(path, { throwIfNoEntry: false });
            if (existing && !existing.isDirectory()) continue;
            folders.add(folder.toLowerCase());
            visit(node.children, this.#workspaceDirectory(root, path));
            break;
          }
        } else if (node.hasReadableContent) {
          const { content } = this.#withContent(node);
          const markdown = node.modality === 'markdown_doc';
          this.#writeWorkspaceFile(root, dir, `${name}.${markdown ? 'md' : 'json'}`,
            markdown ? content : `${JSON.stringify(content, null, 2)}\n`);
        }
      }
    };
    visit(this.getStructure(id), join(root, 'docs'));
    const canon = this.listCanon(id);
    if (canon.length) {
      const dir = this.#workspaceDirectory(root, join(root, 'docs', 'canon'));
      for (const item of canon) this.#writeWorkspaceFile(root, dir, `${workspaceName(item.title, item.id)}.md`, item.contentMd);
    }
    for (const source of this.listSources(id)) {
      const bytes = this.#readBytes(id, this.#path(id, 'sources', safeId(source.id), 'original'), LIMITS.sourceBytes);
      this.#copyWorkspaceSource(root, source, bytes, { legacy: true });
    }
    for (const asset of this.all("SELECT data FROM creation_assets WHERE creation_id=? AND id NOT IN ('export-markdown','export-json') ORDER BY rowid", id).map(data)) {
      const name = asset.mimeType?.startsWith('image/') || IMAGE_EXT.test(asset.ext) ? 'images'
        : asset.mimeType?.startsWith('video/') || VIDEO_EXT.test(asset.ext) ? 'videos' : 'assets';
      const bytes = this.#readBytes(id, this.#assetPath(id, asset, { legacy: true }), LIMITS.assetBytes);
      const dir = this.#workspaceDirectory(root, join(root, name));
      this.#writeWorkspaceFile(root, dir, workspaceName(asset.name ?? `${asset.id}.${asset.ext}`, asset.id), bytes);
    }
  }
  ensureWorkspace(id, { rootDir } = {}) {
    return this.transaction(() => {
      const record = data(this.#creation(id));
      if (record.rootDir) {
        try {
          if (fs.statSync(record.rootDir, { throwIfNoEntry: false })?.isDirectory()) {
            return { creation: this.getCreation(id), rootDir: record.rootDir, materialized: false };
          }
        } catch (error) {
          if (error.code !== 'ENOTDIR' && error.code !== 'ELOOP') throw error;
        }
      }
      this.#initializeWorkspace(record, rootDir == null ? null : existingFolder(rootDir));
      this.#materializeWorkspace(id, record.rootDir);
      this.run('UPDATE creations SET updated_at=?,data=? WHERE id=?', now(), json(record), id);
      return { creation: this.getCreation(id), rootDir: record.rootDir, materialized: true };
    });
  }
  findByFolder(rootDir) {
    let canonical = folderPath(rootDir);
    try { canonical = fs.realpathSync(canonical); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') fail('INVALID_REQUEST', 'Invalid rootDir');
    }
    const row = this.one("SELECT * FROM creations WHERE json_extract(data,'$.rootDir')=? ORDER BY updated_at DESC,id LIMIT 1", canonical);
    return { creation: row ? this.#summary(row) : null };
  }

  listSources(id) { return this.all('SELECT data FROM creation_sources WHERE creation_id=? ORDER BY rowid', safeId(id)).map(data); }
  addSources(id, { files = [], textSources = [] }, { copyToWorkspace = false } = {}) {
    const creation = this.#creation(id);
    const rootDir = copyToWorkspace ? data(creation).rootDir : null;
    const incoming = [...boundedList(files, LIMITS.sources, 'files').map(file => ({ file })),
      ...boundedList(textSources, LIMITS.sources, 'text sources').map(item => ({ item }))];
    return this.transaction(() => {
      if (incoming.length + this.listSources(id).length > LIMITS.sources) fail('LIMIT_EXCEEDED', 'Too many sources');
      let total = 0;
      const results = incoming.map(({ file, item }) => {
        if ((file !== undefined && (!file || typeof file !== 'object')) || (file === undefined && item == null)) fail('INVALID_REQUEST', 'Invalid source');
        const sourceId = randomUUID();
        const name = title(file?.name ?? file?.filename ?? item?.name ?? item?.title ?? 'Notes.txt');
        const mimeType = String(file?.mimeType ?? file?.mime ?? file?.contentType ?? file?.type ?? (file ? 'application/octet-stream' : 'text/plain')).toLowerCase();
        if (!/^[a-z0-9][a-z0-9!#$&^_.+\-]*\/[a-z0-9][a-z0-9!#$&^_.+\-]*$/.test(mimeType) || mimeType.length > 128) fail('INVALID_REQUEST', 'Invalid source media type');
        const bytes = file ? decodeBase64(file.base64 ?? file.dataBase64 ?? file.contentBase64 ?? file.data, LIMITS.sourceBytes)
          : Buffer.from(text(typeof item === 'string' ? item : item.text ?? item.content, LIMITS.sourceBytes, 'source text'));
        total += bytes.length;
        if (total > LIMITS.sourceBatchBytes) fail('LIMIT_EXCEEDED', 'Source batch is too large');
        const parsed = parseSource(bytes, { name, mimeType });
        const { detectedMimeType } = parsed;
        this.#write(this.#path(id, 'sources', sourceId, 'original'), bytes);
        this.#write(this.#path(id, 'sources', sourceId, 'parsed.json'), json(parsed));
        const record = { id: sourceId, creationId: id, name, mimeType, detectedMimeType,
          playableVideo: detectedMimeType === 'video/mp4' || detectedMimeType === 'video/webm', byteLength: bytes.length,
          kind: parsed.kind, summary: parsed.summary, chunkCount: parsed.chunks.length, truncated: parsed.truncated, createdAt: now() };
        this.run('INSERT INTO creation_sources VALUES (?,?,?)', id, sourceId, json(record));
        if (rootDir) this.#copyWorkspaceSource(rootDir, record, bytes);
        return record;
      });
      if (results.length) this.#touch(id);
      return results;
    });
  }
  getSource(id, sourceId) {
    const source = data(this.one('SELECT data FROM creation_sources WHERE creation_id=? AND id=?', safeId(id), safeId(sourceId))) ?? notFound('Source');
    const parsed = JSON.parse(this.#read(id, this.#path(id, 'sources', sourceId, 'parsed.json'), 2 * 1024 * 1024));
    return { ...source, parsed, chunks: parsed.chunks };
  }
  deleteSource(id, sourceId) {
    return this.transaction(() => {
      if (!this.run('DELETE FROM creation_sources WHERE creation_id=? AND id=?', safeId(id), safeId(sourceId)).changes) notFound('Source');
      this.tx.afterCommit.push(() => this.#remove(this.#path(id, 'sources', sourceId)));
      this.#touch(id);
      return { deleted: true, id: sourceId };
    });
  }
  searchSources(id, query, { limit = 8, excludedContextIds = [] } = {}) {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const excluded = new Set(excludedContextIds);
    const matches = [];
    for (const source of this.listSources(id)) {
      if (excluded.has(source.id)) continue;
      for (const chunk of this.getSource(id, source.id).chunks) {
        if (excluded.has(`${source.id}:${chunk.index}`)) continue;
        const body = chunk.text.toLowerCase();
        const name = source.name.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (body.includes(term) ? 2 : 0) + (name.includes(term) ? 1 : 0), 0);
        if (score) matches.push({ sourceId: source.id, name: source.name, ...chunk, score });
      }
    }
    return matches.sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId) || a.index - b.index)
      .slice(0, Math.max(0, Math.min(Number(limit) || 0, 30)));
  }

  listCanon(id) { return this.all('SELECT data FROM creation_canon WHERE creation_id=? ORDER BY pinned DESC,title,id', safeId(id)).map(data); }
  getCanon(id, canonId) { return data(this.one('SELECT data FROM creation_canon WHERE creation_id=? AND id=?', safeId(id), safeId(canonId))); }
  #canonRecord(id, patch, current, canonId, actor) {
    const item = current ? { ...current } : { id: canonId, creationId: id, createdAt: now(), type: 'world',
      title: 'Untitled canon', contentMd: '', pinned: false, lockedByUser: false };
    if (own(patch, 'type')) item.type = pick(patch.type, CANON_TYPES, 'canon type');
    if (own(patch, 'title')) item.title = title(patch.title);
    if (own(patch, 'contentMd') || own(patch, 'bodyMd') || own(patch, 'body') || own(patch, 'content')) {
      item.contentMd = text(patch.contentMd ?? patch.bodyMd ?? patch.body ?? patch.content, LIMITS.promptBytes, 'canon content');
    }
    if (own(patch, 'state') || own(patch, 'stateJson')) {
      const state = patch.state ?? patch.stateJson;
      if (state !== null && (!state || typeof state !== 'object' || Array.isArray(state))) fail('INVALID_REQUEST', 'Invalid Canon state');
      boundedText(json(state), LIMITS.promptBytes, 'Canon state');
      item.state = state;
    } else if (own(patch, 'rows') && Array.isArray(patch.rows)) {
      const nextState = { ...(item.state && typeof item.state === 'object' ? item.state : {}), rows: patch.rows };
      boundedText(json(nextState), LIMITS.promptBytes, 'Canon state');
      item.state = nextState;
    }
    if (own(patch, 'pinned')) item.pinned = patch.pinned === true;
    if (actor === 'user' && (own(patch, 'lockedByUser') || own(patch, 'locked'))) {
      item.lockedByUser = (patch.lockedByUser ?? patch.locked) === true;
    }
    return { ...item, version: randomUUID(), updatedAt: now() };
  }
  upsertCanon(id, patch, { actor = 'user' } = {}) {
    return this.transaction(() => {
      this.#creation(id);
      const canonId = idFor(patch.id ?? patch.canonId);
      const current = this.getCanon(id, canonId);
      if (actor !== 'user' && current) fail(current.lockedByUser ? 'LOCKED' : 'REVIEW_REQUIRED', 'Existing canon requires user review');
      if (!current && this.one('SELECT COUNT(*) AS count FROM creation_canon WHERE creation_id=?', id).count >= LIMITS.canon) fail('LIMIT_EXCEEDED', 'Too many canon items');
      const item = this.#canonRecord(id, patch, current, canonId, actor);
      this.run(`INSERT INTO creation_canon VALUES (?,?,?,?,?,?) ON CONFLICT(creation_id,id) DO UPDATE SET
        title=excluded.title,body=excluded.body,pinned=excluded.pinned,data=excluded.data`,
      id, canonId, item.title, item.contentMd, +item.pinned, json(item));
      this.#touch(id);
      return item;
    });
  }
  deleteCanon(id, canonId, { actor = 'user' } = {}) {
    if (actor !== 'user') fail('REVIEW_REQUIRED', 'Canon deletion requires user review');
    if (!this.run('DELETE FROM creation_canon WHERE creation_id=? AND id=?', safeId(id), safeId(canonId)).changes) notFound('Canon item');
    this.#touch(id);
    return { deleted: true, id: canonId };
  }
  recallCanon(id, query, { limit = 8, excludedContextIds = [] } = {}) {
    safeId(id);
    const match = searchTerms(query).map(term => `"${term}"`).join(' OR ');
    if (!match) return [];
    const excluded = new Set(excludedContextIds);
    return this.all(`SELECT c.data FROM creation_canon_fts f JOIN creation_canon c ON c.rowid=f.rowid
      WHERE creation_canon_fts MATCH ? AND f.creation_id=? ORDER BY bm25(creation_canon_fts),c.id`, match, id)
      .map(data).filter(item => !excluded.has(item.id)).slice(0, limit);
  }

  listNodes(id) {
    return this.all('SELECT data FROM creation_nodes WHERE creation_id=? ORDER BY position,id', safeId(id)).map(row => nodeFields(data(row)));
  }
  getStructure(id, { includeContent = false } = {}) {
    this.#creation(id);
    const nodes = this.listNodes(id).map(node => includeContent ? this.#withContent(node) : node);
    const byId = new Map(nodes.map(node => [node.id, { ...node, children: [] }]));
    const roots = [];
    for (const node of byId.values()) (byId.get(node.parentId)?.children ?? roots).push(node);
    return roots;
  }
  #node(id, nodeId) {
    return data(this.one('SELECT data FROM creation_nodes WHERE creation_id=? AND id=?', safeId(id), safeId(nodeId))) ?? notFound('Node');
  }
  #withContent(node) {
    if (!node.currentRevId) return { ...nodeFields(node), content: '' };
    return { ...nodeFields(node), content: this.getRevision(node.creationId, node.id, node.currentRevId).content };
  }
  getNode(id, nodeId) { return this.#withContent(this.#node(id, nodeId)); }
  listRevisions(id, nodeId, { limit = 50 } = {}) {
    this.#node(id, nodeId);
    return this.all('SELECT data FROM creation_revisions WHERE creation_id=? AND node_id=? ORDER BY rowid DESC LIMIT ?', id, nodeId, limit).map(data);
  }
  getRevision(id, nodeId, revId) {
    const rev = data(this.one('SELECT data FROM creation_revisions WHERE creation_id=? AND node_id=? AND id=?',
      safeId(id), safeId(nodeId), safeId(revId))) ?? notFound('Revision');
    const value = this.#read(id, this.#path(id, 'artifacts', nodeId, 'revisions', `${revId}.${rev.structured ? 'json' : 'snap'}`), LIMITS.nodeBytes);
    return { ...rev, content: rev.structured ? JSON.parse(value) : value };
  }
  #nodeFields(node, patch, actor) {
    if (own(patch, 'title')) node.title = title(patch.title);
    if (own(patch, 'outlineMd') || own(patch, 'outline')) node.outlineMd = text(patch.outlineMd ?? patch.outline, LIMITS.promptBytes, 'outline');
    if (own(patch, 'summaryMd')) node.summaryMd = text(patch.summaryMd, LIMITS.promptBytes, 'summary');
    if (own(patch, 'status')) {
      if (actor !== 'user' && (node.status === 'final' || patch.status === 'final')) fail('REVIEW_REQUIRED', 'Final status is user-controlled');
      node.status = pick(patch.status, NODE_STATUSES, 'node status');
    }
    if (own(patch, 'canonRefs')) {
      node.canonRefs = [...new Set(boundedList(patch.canonRefs, 64, 'canon references').map(safeId))];
      for (const ref of node.canonRefs) if (!this.getCanon(node.creationId, ref)) notFound('Canon reference');
    }
    return node;
  }
  #parent(id, parentId, nodeId = null) {
    let depth = 1;
    while (parentId !== null) {
      const parent = this.#node(id, parentId);
      if (parent.id === nodeId || parent.type !== 'folder' || ++depth > LIMITS.treeDepth) fail('INVALID_REQUEST', 'Invalid parent folder');
      parentId = parent.parentId;
    }
    return depth;
  }
  #nextPosition(id, parentId) {
    return this.one('SELECT COALESCE(MAX(position),-1)+1 AS position FROM creation_nodes WHERE creation_id=? AND parent_id IS ?', id, parentId).position;
  }
  #nodeWrite(node) {
    this.run(`UPDATE creation_nodes SET parent_id=?,position=?,current_rev_id=?,readable=?,words=?,data=? WHERE creation_id=? AND id=?`,
      node.parentId, node.position, node.currentRevId, +node.hasReadableContent, node.wordCount, json(node), node.creationId, node.id);
    this.#touch(node.creationId);
  }
  #addRevision(node, value, actor, restoredFromRevId = null) {
    const { encoded, structured, words, readable } = contentRecord(value, node.modality);
    const rev = { id: randomUUID(), nodeId: node.id, creationId: node.creationId, actor, structured, createdAt: now(),
      baseRevId: node.currentRevId, restoredFromRevId };
    this.#write(this.#path(node.creationId, 'artifacts', node.id, 'revisions', `${rev.id}.${structured ? 'json' : 'snap'}`), encoded);
    this.run('INSERT INTO creation_revisions VALUES (?,?,?,?)', node.creationId, node.id, rev.id, json(rev));
    Object.assign(node, { currentRevId: rev.id, hasReadableContent: readable, wordCount: words,
      userEdited: node.userEdited || actor === 'user' });
    if (node.status === 'outline' && readable) node.status = 'draft';
  }
  createNode(id, input, { actor = 'user' } = {}) {
    return this.transaction(() => {
      const creation = data(this.#creation(id));
      if (this.one('SELECT COUNT(*) AS count FROM creation_nodes WHERE creation_id=?', id).count >= LIMITS.nodes) fail('LIMIT_EXCEEDED', 'Too many nodes');
      const nodeId = idFor(input.id ?? input.nodeId);
      if (this.one('SELECT id FROM creation_nodes WHERE creation_id=? AND id=?', id, nodeId)) fail('CONFLICT', 'Node identifier is in use');
      const parentId = input.parentId == null ? null : safeId(input.parentId);
      this.#parent(id, parentId);
      const type = pick(input.type ?? input.nodeType ?? 'unit', ['folder', 'unit'], 'node type');
      const modality = own(input, 'modality') && input.modality != null
        ? pick(input.modality, MODALITIES, 'node modality')
        : creation.modality;
      const fields = this.#nodeFields({ id: nodeId, creationId: id, parentId, type, modality,
        title: type === 'folder' ? 'Untitled folder' : 'Untitled unit', outlineMd: '', summaryMd: '', canonRefs: [],
        status: 'outline', currentRevId: null, userEdited: false, hasReadableContent: false, wordCount: 0,
        position: this.#nextPosition(id, parentId), createdAt: now(), updatedAt: now() }, input, actor);
      this.run('INSERT INTO creation_nodes VALUES (?,?,?,?,?,?,?,?)', id, nodeId, parentId, fields.position, null, 0, 0, json(fields));
      const initialContent = own(input, 'content') ? input.content : (own(input, 'initialContent') ? input.initialContent : undefined);
      if (initialContent !== undefined) return this.updateNode(id, nodeId, { content: initialContent }, { actor });
      this.#touch(id);
      return this.#withContent(fields);
    });
  }
  updateNode(id, nodeId, patch, { actor = 'user', restoredFromRevId = null } = {}) {
    return this.transaction(() => {
      const node = this.#node(id, nodeId);
      if (own(patch, 'baseRevId')) {
        if (patch.baseRevId !== null) safeId(patch.baseRevId);
        if (node.currentRevId !== patch.baseRevId) return this.#conflict(node);
      }
      if (own(patch, 'content')) {
        if (node.type !== 'unit') fail('INVALID_REQUEST', 'Folder cannot contain unit content');
        if (actor !== 'user' && (node.userEdited || node.status === 'final')) fail('REVIEW_REQUIRED', 'Unit content requires user review');
      }
      this.#nodeFields(node, patch, actor);
      if (own(patch, 'parentId')) {
        if (actor !== 'user') fail('REVIEW_REQUIRED', 'Moving existing nodes requires user review');
        const parentId = patch.parentId === null ? null : safeId(patch.parentId);
        const depth = this.#parent(id, parentId, nodeId);
        const height = this.one(`WITH RECURSIVE subtree(id,height) AS (SELECT ?,0 UNION ALL
          SELECT n.id,s.height+1 FROM creation_nodes n JOIN subtree s ON n.parent_id=s.id WHERE n.creation_id=?)
          SELECT MAX(height) AS height FROM subtree`, nodeId, id).height;
        if (depth + height > LIMITS.treeDepth) fail('INVALID_REQUEST', 'Node tree is too deep');
        if (node.parentId !== parentId) Object.assign(node, { parentId, position: this.#nextPosition(id, parentId) });
      }
      if (own(patch, 'content')) this.#addRevision(node, patch.content, actor, restoredFromRevId);
      node.updatedAt = now();
      this.#nodeWrite(node);
      return this.#withContent(node);
    });
  }
  #conflict(node) { return { conflict: true, currentRevId: node.currentRevId, currentContent: this.#withContent(node).content }; }
  reorderNodes(id, parentId, nodeIds) {
    return this.transaction(() => {
      this.#creation(id);
      parentId = parentId ?? null;
      this.#parent(id, parentId);
      const siblings = this.all('SELECT data FROM creation_nodes WHERE creation_id=? AND parent_id IS ? ORDER BY position,id', id, parentId).map(data);
      const byId = new Map(siblings.map(node => [node.id, node]));
      const orderedIds = new Set(boundedList(nodeIds, LIMITS.nodes, 'ordered nodes').map(safeId));
      if (orderedIds.size !== nodeIds.length || orderedIds.size !== byId.size || [...orderedIds].some(nodeId => !byId.has(nodeId))) {
        fail('INVALID_REQUEST', 'Reorder requires each sibling exactly once');
      }
      return nodeIds.map((nodeId, position) => {
        const node = { ...byId.get(nodeId), position, updatedAt: now() };
        this.#nodeWrite(node);
        return nodeFields(node);
      });
    });
  }
  deleteNode(id, nodeId) {
    return this.transaction(() => {
      this.#node(id, nodeId);
      const removed = this.all(`WITH RECURSIVE subtree(id) AS (SELECT ? UNION ALL SELECT n.id FROM creation_nodes n
        JOIN subtree s ON n.parent_id=s.id WHERE n.creation_id=?) SELECT id FROM subtree`, nodeId, id).map(row => row.id);
      const targets = new Set(removed);
      const pending = this.all(`SELECT id FROM creation_proposals WHERE creation_id=? AND status='pending'
        AND json_extract(data,'$.type')='unit_edit' AND json_extract(data,'$.nodeId') IN (${removed.map(() => '?').join(',')})`, id, ...removed);
      for (const row of pending) {
        const proposal = data(this.one('SELECT data FROM creation_proposals WHERE creation_id=? AND id=?', id, row.id));
        this.#settleProposal(proposal, 'rejected', 'node_deleted');
      }
      const running = data(this.one("SELECT data FROM creation_runs WHERE creation_id=? AND status='running'", id));
      if (running?.nodeIds?.some(target => targets.has(target)) || targets.has(running?.scopeId)) fail('BUSY', 'Node belongs to an active run');
      for (const target of removed) {
        this.run("DELETE FROM creation_threads WHERE creation_id=? AND scope_type IN ('unit','folder') AND scope_id=?", id, target);
        this.tx.afterCommit.push(() => this.#remove(this.#path(id, 'artifacts', target)));
      }
      this.run('DELETE FROM creation_nodes WHERE creation_id=? AND id=?', id, nodeId);
      this.#touch(id);
      return { deleted: true, id: nodeId, nodeIds: removed };
    });
  }
  restoreRevision(id, nodeId, revId, options = {}) {
    return this.transaction(() => {
      const { content } = this.getRevision(id, nodeId, revId);
      return this.updateNode(id, nodeId, { ...options, content }, { restoredFromRevId: revId });
    });
  }

  #proposal(id, fields) {
    if (this.one('SELECT COUNT(*) AS count FROM creation_proposals WHERE creation_id=?', id).count >= LIMITS.proposalCount) fail('LIMIT_EXCEEDED', 'Too many proposals');
    const proposal = { id: randomUUID(), creationId: id, createdAt: now(), status: 'pending', ...fields };
    this.run('INSERT INTO creation_proposals VALUES (?,?,?,?)', id, proposal.id, proposal.status, json(proposal));
    this.#touch(id);
    return proposal;
  }
  proposeCanonPatch(id, patch, { summary = '' } = {}) {
    return this.transaction(() => {
      this.#creation(id);
      const canonId = idFor(patch.id ?? patch.canonId);
      const current = this.getCanon(id, canonId);
      const { title, type, contentMd, pinned, state } = this.#canonRecord(id, patch, current, canonId, 'ai');
      return this.#proposal(id, { type: 'canon_patch', canonId, baseCanonVersion: current?.version ?? null,
        patch: { id: canonId, title, type, contentMd, pinned, ...(state === undefined ? {} : { state }) }, summary: text(summary, LIMITS.promptBytes, 'proposal summary') });
    });
  }
  proposeUnitEdit(id, nodeId, input) {
    return this.transaction(() => {
      const node = this.getNode(id, nodeId);
      if (node.type !== 'unit') fail('INVALID_REQUEST', 'Expected a unit');
      const proposedContent = input.proposedContent ?? input.content;
      const proposed = contentRecord(proposedContent, node.modality);
      const baseRevId = own(input, 'baseRevId') ? input.baseRevId : node.currentRevId;
      const baseContent = baseRevId === null ? '' : baseRevId === node.currentRevId ? node.content : this.getRevision(id, nodeId, baseRevId).content;
      const encoded = typeof baseContent === 'string' ? baseContent : json(baseContent);
      const anchor = input.anchor ?? null;
      if (anchor !== null) boundedText(json(anchor), 8192, 'anchor');
      return this.#proposal(id, { type: 'unit_edit', nodeId, baseRevId, proposedContent, anchor,
        summary: text(input.summary ?? '', LIMITS.promptBytes, 'proposal summary'), diffStats: diffStats(encoded, proposed.encoded) });
    });
  }
  getProposal(id, proposalId) {
    return data(this.one('SELECT data FROM creation_proposals WHERE creation_id=? AND id=?', safeId(id), safeId(proposalId))) ?? notFound('Proposal');
  }
  listProposals(id, { status, nodeId, includeContent = true, limit = LIMITS.proposalCount, offset = 0 } = {}) {
    this.#creation(id);
    const filters = ['creation_id=?'];
    const params = [id];
    if (status != null) {
      filters.push('status=?');
      params.push(pick(status, PROPOSAL_STATUSES, 'proposal status'));
    }
    if (nodeId != null) {
      filters.push("json_extract(data,'$.nodeId')=?");
      params.push(safeId(nodeId));
    }
    if (typeof includeContent !== 'boolean' || !Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.proposalCount
      || !Number.isSafeInteger(offset) || offset < 0) fail('INVALID_REQUEST', 'Invalid proposal page');
    const statement = this.db.prepare(`SELECT data FROM creation_proposals WHERE ${filters.join(' AND ')} ORDER BY rowid DESC LIMIT ? OFFSET ?`);
    const proposals = [];
    let bytes = 2; // Array brackets; count commas as entries are appended.
    let hasMore = false;
    for (const row of statement.iterate(...params, limit + 1, offset)) {
      if (proposals.length === limit) { hasMore = true; break; }
      const proposal = data(row);
      let item = includeContent ? proposal : compactProposal(proposal);
      let size = jsonBytes(item);
      if (includeContent && size + 2 > PAGE_BYTES) {
        item = { ...compactProposal(proposal), contentTruncated: true };
        size = jsonBytes(item);
      }
      const entryBytes = size + Number(proposals.length > 0);
      if (bytes + entryBytes > PAGE_BYTES) { hasMore = true; break; }
      bytes += entryBytes;
      proposals.push(item);
    }
    return { proposals, hasMore, nextOffset: hasMore ? offset + proposals.length : null };
  }
  #settleProposal(proposal, status, reason = null, outcome = {}) {
    Object.assign(proposal, { status, reason, resolvedAt: now(), ...outcome });
    this.run('UPDATE creation_proposals SET status=?,data=? WHERE creation_id=? AND id=?', status, json(proposal), proposal.creationId, proposal.id);
    this.#touch(proposal.creationId);
    return proposal;
  }
  resolveProposal(id, proposalId, { action, force = false }) {
    pick(action, ['accept', 'reject'], 'proposal action');
    return this.transaction(() => {
      const proposal = this.getProposal(id, proposalId);
      if (proposal.status !== 'pending') {
        if (proposal.status === (action === 'accept' ? 'accepted' : 'rejected')) return { proposal, unchanged: true };
        fail('CONFLICT', 'Proposal already resolved');
      }
      if (action === 'reject') return { proposal: this.#settleProposal(proposal, 'rejected') };
      if (proposal.type === 'unit_edit') {
        const node = this.updateNode(id, proposal.nodeId, { content: proposal.proposedContent,
          ...(force === true ? {} : { baseRevId: proposal.baseRevId }) });
        if (node.conflict) return node;
        return { node, proposal: this.#settleProposal(proposal, 'accepted', null, { appliedRevId: node.currentRevId }) };
      }
      const currentCanon = this.getCanon(id, proposal.canonId);
      if (force !== true && proposal.baseCanonVersion !== (currentCanon?.version ?? null)) return { conflict: true, currentCanon };
      const canon = this.upsertCanon(id, proposal.patch);
      return { canon, proposal: this.#settleProposal(proposal, 'accepted', null, { appliedCanonVersion: canon.version }) };
    });
  }

  getThread(id, { threadId, scopeType, scopeId } = {}) {
    this.#creation(id);
    if (threadId != null) {
      const thread = data(this.one('SELECT data FROM creation_threads WHERE creation_id=? AND id=?', id, safeId(threadId))) ?? notFound('Thread');
      const scopeMatches = scopeType === 'node' ? ['unit', 'folder'].includes(thread.scopeType)
        : scopeType == null || this.#scopeType(scopeType) === thread.scopeType;
      if (!scopeMatches || (scopeId != null && scopeId !== (thread.scopeType === 'global' ? id : thread.scopeId))) {
        fail('INVALID_REQUEST', 'Thread scope does not match');
      }
      return thread;
    }
    if (scopeType === 'node' && scopeId != null) {
      scopeType = this.#node(id, scopeId).type;
    } else {
      scopeType = this.#scopeType(scopeType ?? 'global');
    }
    if (scopeType === 'global') {
      if (scopeId != null && scopeId !== id) fail('INVALID_REQUEST', 'Invalid global scope');
      scopeId = '';
    } else if (this.#node(id, scopeId).type !== scopeType) fail('INVALID_REQUEST', 'Invalid node scope');
    return this.transaction(() => {
      const existing = data(this.one('SELECT data FROM creation_threads WHERE creation_id=? AND scope_type=? AND scope_id=?', id, scopeType, scopeId));
      if (existing) return existing;
      const thread = { id: randomUUID(), creationId: id, scopeType, scopeId: scopeId || null, createdAt: now() };
      this.run('INSERT INTO creation_threads VALUES (?,?,?,?,?)', id, thread.id, scopeType, scopeId, json(thread));
      return thread;
    });
  }
  listThreads(id) {
    this.#creation(id);
    return this.all('SELECT data FROM creation_threads WHERE creation_id=? ORDER BY rowid', id).map(data);
  }
  #scopeType(type) { return type === 'node' ? 'unit' : pick(type, ['global', 'folder', 'unit'], 'thread scope'); }
  #messageRows(id, threadId, { limit = 100, beforeId } = {}, extra = 0) {
    this.getThread(id, { threadId });
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_REQUEST', 'Invalid message limit');
    const before = beforeId == null ? null : this.one('SELECT rowid FROM creation_messages WHERE creation_id=? AND thread_id=? AND id=?',
      id, threadId, safeId(beforeId)) ?? notFound('Message');
    return before
      ? this.db.prepare('SELECT data FROM creation_messages WHERE creation_id=? AND thread_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?').iterate(id, threadId, before.rowid, limit + extra)
      : this.db.prepare('SELECT data FROM creation_messages WHERE creation_id=? AND thread_id=? ORDER BY rowid DESC LIMIT ?').iterate(id, threadId, limit + extra);
  }
  listMessages(id, threadId, options) { return Array.from(this.#messageRows(id, threadId, options), data).reverse(); }
  pageMessages(id, threadId, options = {}) {
    const messages = [];
    let bytes = 2;
    let hasMore = false;
    for (const row of this.#messageRows(id, threadId, options, 1)) {
      if (messages.length >= (options.limit ?? 100)) { hasMore = true; break; }
      let message = data(row);
      let size = Buffer.byteLength(row.data);
      if (!messages.length && size + bytes > PAGE_BYTES) {
        // An older individual message may exceed the whole page after JSON escaping.
        // Include a preview (with its original cursor ID) so paging can still advance.
        const { id, creationId, threadId, createdAt, role, runId, status, text } = message;
        const preview = clipBytes(text ?? '', 64 * 1024);
        message = { id, creationId, threadId, createdAt, role, runId, status, text: preview, content: preview, contentTruncated: true };
        size = jsonBytes(message);
      }
      const entryBytes = size + Number(messages.length > 0);
      if (bytes + entryBytes > PAGE_BYTES) { hasMore = true; break; }
      bytes += entryBytes;
      messages.push(message);
    }
    messages.reverse();
    return { messages, hasMore, nextBeforeId: hasMore ? messages[0]?.id ?? null : null };
  }
  ensureAssistantMessage(run, { status, text, contextMeta }) {
    const { creationId, threadId, assistantMessageId: id } = run;
    return data(this.one('SELECT data FROM creation_messages WHERE creation_id=? AND thread_id=? AND id=?', creationId, threadId, id))
      ?? this.addMessage(creationId, threadId, { id, role: 'assistant', status, text, content: text, runId: run.id, contextMeta });
  }
  addMessage(id, threadId, message) {
    this.getThread(id, { threadId });
    const record = { ...message, id: idFor(message.id), creationId: id, threadId, createdAt: now() };
    this.run('INSERT INTO creation_messages VALUES (?,?,?,?)', id, threadId, record.id, json(record));
    return record;
  }
  listRuns(id) { return this.all('SELECT data FROM creation_runs WHERE creation_id=? ORDER BY rowid DESC LIMIT 100', safeId(id)).map(data); }
  getRun(id, runId) {
    return data(this.one('SELECT data FROM creation_runs WHERE creation_id=? AND id=?', safeId(id), safeId(runId))) ?? notFound('Run');
  }
  #ensureIdle(id) {
    if (this.one(`SELECT id FROM creation_runs WHERE creation_id=? AND status='running'`, id)) fail('BUSY', 'Creation already has a running turn or batch');
  }
  createRun(id, input) {
    return this.transaction(() => {
      this.#creation(id);
      this.#ensureIdle(id);
      const run = { ...input, id: randomUUID(), creationId: id, status: 'running', reason: null, leaseEpoch: 1,
        bootId: safeId(input.bootId), createdAt: now(), updatedAt: now() };
      this.run('INSERT INTO creation_runs VALUES (?,?,?,?,?,?)', id, run.id, run.status, run.bootId, run.leaseEpoch, json(run));
      this.#touch(id);
      return run;
    });
  }
  #saveRun(run) {
    pick(run.status, RUN_STATUSES, 'run status');
    run.updatedAt = now();
    this.run('UPDATE creation_runs SET status=?,boot_id=?,lease_epoch=?,data=? WHERE creation_id=? AND id=?',
      run.status, run.bootId, run.leaseEpoch, json(run), run.creationId, run.id);
    this.#touch(run.creationId);
    return run;
  }
  updateRun(id, runId, { bootId, leaseEpoch }, patch) {
    return this.transaction(() => {
      const current = this.getRun(id, runId);
      if (current.status !== 'running' || current.bootId !== bootId || current.leaseEpoch !== leaseEpoch) return null;
      return this.#saveRun({ ...current, ...patch });
    });
  }
  controlRun(id, runId, action, bootId) {
    return this.transaction(() => {
      const run = this.getRun(id, runId);
      if (action === 'resume') {
        if (run.type !== 'batch' || run.status !== 'paused') fail('INVALID_STATE', 'Only paused batch runs can resume');
        this.#ensureIdle(id);
        return this.#saveRun({ ...run, status: 'running', leaseEpoch: run.leaseEpoch + 1, bootId: safeId(bootId), reason: null,
          failedNodeId: null, error: null });
      }
      pick(action, ['pause', 'cancel'], 'run action');
      if (action === 'pause' && run.type !== 'batch') fail('INVALID_STATE', 'Only batch runs can pause');
      const status = action === 'pause' ? 'paused' : 'cancelled';
      if (run.status === status) return run;
      if (run.status !== 'running' && !(run.status === 'paused' && action === 'cancel')) fail('INVALID_STATE', 'Run cannot be controlled');
      return this.#saveRun({ ...run, status, reason: action === 'pause' ? 'user_paused' : 'user_cancelled', currentNodeId: null, leaseEpoch: run.leaseEpoch + 1 });
    });
  }
  interruptRun(run) {
    return this.transaction(() => {
      const next = this.updateRun(run.creationId, run.id, run, { status: run.type === 'thread' ? 'failed' : 'paused',
        reason: 'agent_restarted', currentNodeId: null, leaseEpoch: run.leaseEpoch + 1 });
      if (next?.type === 'thread') this.ensureAssistantMessage(next, { status: 'failed', text: 'Turn interrupted by Agent restart.' });
      return next;
    });
  }
  recoverInterruptedRuns(bootId) {
    safeId(bootId);
    return this.transaction(() => this.all("SELECT data FROM creation_runs WHERE status='running' AND boot_id<>?", bootId)
      .map(row => this.interruptRun(data(row))));
  }

  #assetPath(id, record, { legacy = false } = {}) {
    if (!own(ASSET_TYPES, record.ext) && !(legacy && typeof record.ext === 'string' && /^[a-z0-9]{1,12}$/i.test(record.ext))) {
      fail('INVALID_PATH', 'Invalid stored asset type');
    }
    const assetId = safeId(record.id);
    if (record.file == null) return this.#path(id, 'assets', `${safeId(record.fileId ?? assetId)}.${record.ext}`);
    const file = `${assetId}.${safeId(record.version)}.${record.ext}`;
    if (record.file !== file) fail('INVALID_PATH', 'Invalid stored asset filename');
    return this.#path(id, 'assets', file);
  }

  saveAsset(id, input, { exportFile = false } = {}) {
    return this.transaction(() => {
      this.#creation(id);
      const ext = String(input.ext ?? input.extension ?? '').toLowerCase();
      if (!own(ASSET_TYPES, ext)) fail('INVALID_REQUEST', 'Unsupported asset type');
      const isExportType = ext === 'md' || ext === 'json';
      if (exportFile && !isExportType) fail('INVALID_REQUEST', 'Invalid export type');
      // Reserve one slot per export format, independent of the regular asset quota.
      if (!exportFile && this.one("SELECT COUNT(*) AS count FROM creation_assets WHERE creation_id=? AND id NOT IN ('export-markdown','export-json')", id).count >= LIMITS.assets) {
        fail('LIMIT_EXCEEDED', 'Too many assets');
      }
      const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : typeof input.content === 'string' && ['html', 'svg', 'md', 'json'].includes(ext)
        ? Buffer.from(boundedText(input.content, LIMITS.assetBytes, 'asset content'))
        : decodeBase64(input.base64 ?? input.dataBase64, LIMITS.assetBytes);
      if ((bytes.length > LIMITS.assetBytes && !(exportFile && isExportType && Buffer.isBuffer(input.bytes))) || !validAsset(ext, bytes)) fail('INVALID_REQUEST', 'Invalid asset bytes or size');
      const assetId = exportFile ? `export-${ext === 'md' ? 'markdown' : ext}` : randomUUID();
      const asset = { id: assetId, creationId: id, ext, ...(exportFile ? { name: `${id}.${ext}` } : {}), mimeType: ASSET_TYPES[ext], byteLength: bytes.length,
        // Active formats must be served as downloads or inside a sandbox by the relay/UI.
        disposition: (isExportType || ['html', 'svg'].includes(ext)) ? 'attachment' : 'inline', createdAt: now() };
      const version = randomUUID();
      const record = { ...asset, version, file: `${assetId}.${version}.${ext}` };
      // Stage immutable bytes before publishing the new record. Rollback keeps the old export readable.
      this.#write(this.#assetPath(id, record), bytes);
      if (exportFile) {
        const previous = data(this.one('SELECT data FROM creation_assets WHERE creation_id=? AND id=?', id, assetId));
        const previousPath = previous ? this.#assetPath(id, previous) : null;
        this.run(`INSERT INTO creation_assets VALUES (?,?,?) ON CONFLICT(creation_id,id) DO UPDATE SET data=excluded.data`,
          id, assetId, json(record));
        if (previousPath) this.tx.afterCommit.push(() => this.#remove(previousPath));
      } else {
        this.run('INSERT INTO creation_assets VALUES (?,?,?)', id, assetId, json(record));
      }
      this.#touch(id);
      return { ...asset, version };
    });
  }
  listAssets(id) {
    return this.all('SELECT data FROM creation_assets WHERE creation_id=? ORDER BY rowid', safeId(id))
      .map(row => { const { fileId, file, ...asset } = data(row); return asset; });
  }
  readMediaRange(id, mediaKind, mediaId, start = 0, end = undefined, { expectedVersion = null } = {}) {
    this.#creation(id);
    safeId(mediaId);
    let record;
    let path;
    if (mediaKind === 'asset' || mediaKind === 'assets') {
      record = data(this.one('SELECT data FROM creation_assets WHERE creation_id=? AND id=?', id, mediaId)) ?? notFound('Asset');
      path = this.#assetPath(id, record);
    } else if (mediaKind === 'source' || mediaKind === 'sources') {
      record = data(this.one('SELECT data FROM creation_sources WHERE creation_id=? AND id=?', id, mediaId)) ?? notFound('Source');
      path = this.#path(id, 'sources', mediaId, 'original');
    } else fail('INVALID_REQUEST', 'Invalid media kind');
    const version = record.version ?? record.sha256 ?? record.updatedAt ?? record.createdAt;
    if (expectedVersion != null && version !== expectedVersion) {
      fail('CONFLICT', 'Creation media changed during transfer');
    }
    const { fd, size } = this.#open(id, path);
    try {
      // Inclusive HTTP byte range. An omitted end requests a bounded first/next chunk.
      const last = end ?? Math.min(size - 1, start + LIMITS.mediaRangeBytes - 1);
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(last)
        || (size === 0 ? (start !== 0 || (end != null && end < 0)) : (start >= size || last < start || Math.min(last, size - 1) - start + 1 > LIMITS.mediaRangeBytes))) {
        fail('INVALID_RANGE', 'Unsatisfiable Creations media range');
      }
      const bytes = Buffer.alloc(Math.min(last, size - 1) - start + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const read = fs.readSync(fd, bytes, offset, bytes.length - offset, start + offset);
        if (!read) fail('INVALID_RANGE', 'Media changed during read');
        offset += read;
      }
      const safeInline = /^(?:image\/(?:png|jpeg|gif|webp)|audio\/(?:mpeg|wav|ogg|mp4)|video\/(?:mp4|webm|ogg))$/.test(record.mimeType);
      return { bytes, start, end: start + offset - 1, totalSize: size, mimeType: record.mimeType,
        version: record.version ?? record.sha256 ?? record.updatedAt ?? record.createdAt,
        filename: (record.name ?? `${record.id}.${record.ext}`).slice(0, 255).toWellFormed(),
        disposition: record.disposition ?? (safeInline ? 'inline' : 'attachment') };
    } finally { fs.closeSync(fd); }
  }
}

function diffStats(before, after) {
  if (before === after) return { addedLines: 0, removedLines: 0 };
  const left = before ? before.split('\n') : [];
  const right = after ? after.split('\n') : [];
  let prefix = 0;
  let suffix = 0;
  while (prefix < left.length && left[prefix] === right[prefix]) prefix++;
  while (suffix < Math.min(left.length, right.length) - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
  return { addedLines: right.length - prefix - suffix, removedLines: left.length - prefix - suffix };
}

export function createCreationStore(options) { return new CreationStore(options); }
