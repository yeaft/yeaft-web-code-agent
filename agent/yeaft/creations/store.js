import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, dirname, extname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeAtomic } from '../storage/atomic.js';
import {
  CREATION_KINDS, MODALITIES, MODALITY_BY_KIND, CREATION_STATUSES, CANON_TYPES, NODE_STATUSES, PROPOSAL_STATUSES, RUN_STATUSES,
  DEFAULT_KIND_BY_CATEGORY, DOC_WORKFLOW_STATUSES, inferCategoryFromKind, normalizeCategory,
  LIMITS, boundedText, decodeBase64, defaultCelestialPlacement, fail, safeId,
} from './constants.js';
import { parseSource, searchTerms, sniffSourceMimeType } from './source-parser.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS creations (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS creation_doc_states (
  creation_id TEXT NOT NULL REFERENCES creations ON DELETE CASCADE,
  file_path TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (creation_id, file_path));
CREATE TABLE IF NOT EXISTS creation_doc_reviews (
  creation_id TEXT NOT NULL REFERENCES creations ON DELETE CASCADE,
  file_path TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (creation_id, file_path));
CREATE TABLE IF NOT EXISTS creation_doc_review_attempts (
  creation_id TEXT NOT NULL REFERENCES creations ON DELETE CASCADE,
  file_path TEXT NOT NULL, attempt_id INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (creation_id, file_path));
-- External and ambiguous folder history is retained independently of the Creation.
-- A freshly generated workspace has a recorded directory identity instead.
CREATE TABLE IF NOT EXISTS protected_workspaces (root_dir TEXT PRIMARY KEY NOT NULL);
INSERT OR IGNORE INTO protected_workspaces SELECT json_extract(data,'$.rootDir')
  FROM creations WHERE json_type(data,'$.rootDir')='text' AND json_type(data,'$.workspaceIdentity') IS NOT 'object';
DROP TRIGGER IF EXISTS creation_workspace_insert;
DROP TRIGGER IF EXISTS creation_workspace_update;
DROP TRIGGER IF EXISTS creation_workspace_delete;
CREATE TRIGGER creation_workspace_insert AFTER INSERT ON creations BEGIN
  INSERT OR IGNORE INTO protected_workspaces SELECT json_extract(new.data,'$.rootDir')
    WHERE json_type(new.data,'$.rootDir')='text' AND json_type(new.data,'$.workspaceIdentity') IS NOT 'object';
END;
CREATE TRIGGER creation_workspace_update AFTER UPDATE OF data ON creations BEGIN
  INSERT OR IGNORE INTO protected_workspaces SELECT json_extract(old.data,'$.rootDir')
    WHERE json_type(old.data,'$.rootDir')='text' AND (
      json_type(old.data,'$.workspaceIdentity') IS NOT 'object'
      OR json_extract(old.data,'$.rootDir') IS NOT json_extract(new.data,'$.rootDir'));
  INSERT OR IGNORE INTO protected_workspaces SELECT json_extract(new.data,'$.rootDir')
    WHERE json_type(new.data,'$.rootDir')='text' AND json_type(new.data,'$.workspaceIdentity') IS NOT 'object';
END;
CREATE TRIGGER creation_workspace_delete BEFORE DELETE ON creations BEGIN
  INSERT OR IGNORE INTO protected_workspaces SELECT json_extract(old.data,'$.rootDir')
    WHERE json_type(old.data,'$.rootDir')='text' AND json_type(old.data,'$.workspaceIdentity') IS NOT 'object';
END;
CREATE TABLE IF NOT EXISTS creation_materialization_journal (
  creation_id TEXT PRIMARY KEY, target_dir TEXT NOT NULL, temp_files_json TEXT NOT NULL,
  planned_outputs_json TEXT NOT NULL, published_outputs_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
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

export function normalizeDocFilePath(filePath) {
  boundedText(filePath, 1024, 'document file path', { required: true });
  if (!filePath.isWellFormed() || /\p{Cc}/u.test(filePath) || filePath.includes('\\') || /^[a-z]:/i.test(filePath)
    || filePath.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    fail('INVALID_REQUEST', 'Invalid document file path');
  }
  return filePath;
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
  if (typeof value !== 'string') fail('INVALID_REQUEST', 'Invalid rootDir');
  const trimmed = value.trim();
  if (!trimmed || value.length > 4096 || value.includes('\0') || !value.isWellFormed()) fail('INVALID_REQUEST', 'Invalid rootDir');
  // Use native path semantics: a backslash is a literal filename character on POSIX.
  return resolve(trimmed);
}
function workspaceName(value, fallback) {
  let name = value.replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').trim().replace(/^\.+|[. ]+$/g, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return clipBytes(name, 180).replace(/[. ]+$/g, '') || fallback;
}
const WORKSPACE_DIRS = ['docs', 'images', 'videos', 'sources'];
const CREATE_EXCLUSIVE = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
const workspaceDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const workspaceOccupied = () => fail('CONFLICT', 'A planned workspace output is occupied or has changed');
const publicationPath = output => output?.relPath ?? output;
const isIncompletePublication = output => output?.complete === false;
const fdPath = fd => `/proc/self/fd/${fd}`;
const sameInode = (a, b) => a?.dev === b.dev && a?.ino === b.ino;
const rootIdentityOf = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const matchesRootIdentity = (stat, identity) => String(stat.dev) === identity.dev && String(stat.ino) === identity.ino;

function requirePinnedWorkspace() {
  if (!fs.constants.O_NOFOLLOW || !fs.constants.O_DIRECTORY || process.platform !== 'linux' || !fs.existsSync('/proc/self/fd')) {
    fail('UNSUPPORTED', 'External workspace materialization requires pinned directory handles');
  }
}

function workspaceBytesMatch(fd, stat, expected, prefix = false) {
  if (!stat.isFile() || stat.size > BigInt(expected.length) || (!prefix && stat.size !== BigInt(expected.length))) return false;
  const size = Number(stat.size);
  const bytes = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (!count) break;
    offset += count;
  }
  return offset === size && bytes.subarray(0, size).equals(expected.subarray(0, size));
}
const CACHE_CONTAINER = '_creations';
const CACHE_DIRS = new Set(['sources', 'artifacts', 'assets']);
const WORKSPACE_CONTAINER = '_workspaces';
const LEGACY_WORKSPACE_CONTAINER = 'workspaces';

function isWithin(root, path) { return relative(root, path) === '' || contains(root, path); }
const overlaps = (a, b) => isWithin(a, b) || isWithin(b, a);

function assertWorkspaceDescriptor(fd, path) {
  if (process.platform === 'linux' && fs.existsSync('/proc/self/fd')
    && fs.readlinkSync(`/proc/self/fd/${fd}`) !== path) fail('INVALID_PATH', 'Workspace file changed during open');
}

function syncWorkspaceDirectory(path) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

const IMAGE_EXT = /^(?:png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?)$/i;
const VIDEO_EXT = /^(?:mp4|webm|mov|mkv|avi|ogv|m4v|mpeg|mpg)$/i;

const legacyItems = value => Array.isArray(value) ? value : [];
const legacyText = value => typeof value === 'string' ? value.trim() : '';
const headingText = value => legacyText(value).replace(/\s+/g, ' ');
const linkText = value => headingText(value).replace(/[\\[\]]/g, '\\$&');
const legacyMediaType = (mime, ext) => mime?.startsWith('image/') || IMAGE_EXT.test(ext) ? 'images'
  : mime?.startsWith('video/') || VIDEO_EXT.test(ext) ? 'videos' : null;
const timestamp = seconds => {
  const whole = Math.floor(seconds);
  const mmss = [Math.floor(whole / 60) % 60, whole % 60].map(n => String(n).padStart(2, '0')).join(':');
  return whole >= 3600 ? `${Math.floor(whole / 3600)}:${mmss}` : mmss;
};

function legacyMarkdown(node, content, mediaFor, inlineImage) {
  // The old editors stored both objects and JSON-encoded strings. Plain
  // Markdown/script content is kept intact if there is no structured payload.
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { return `# ${headingText(node.title)}\n\n${content}\n`; }
    if (typeof content === 'string') return `# ${headingText(node.title)}\n\n${content}\n`;
  }
  const work = content ?? {};
  const lines = [`# ${headingText(work.title) || headingText(node.title)}`];
  const add = value => { if (legacyText(value)) lines.push(value.trim()); };
  const labeled = (label, value) => { if (legacyText(value)) lines.push(`**${label}:** ${value.trim()}`); };
  const renderMedia = (media, label) => {
    if (media) lines.push(media.kind === 'images' ? `![${linkText(label)}](${media.url})` : `[${linkText(label)}](${media.url})`);
  };
  const media = (assetId, sourceId) => mediaFor('asset', assetId) ?? mediaFor('source', sourceId);
  const image = (assetId, sourceId) => {
    const ref = media(assetId, sourceId);
    return ref?.kind === 'images' ? ref : null;
  };
  const video = (assetId, sourceId) => {
    const ref = media(assetId, sourceId);
    return ref?.kind === 'videos' ? ref : null;
  };
  const bullets = list => add(legacyItems(list).map(item => legacyText(item?.text ?? item)).filter(Boolean)
    .map(item => `- ${item.replace(/\r?\n/g, '\n  ')}`).join('\n'));
  add(work.description);
  if (node.modality === 'slide_deck') {
    legacyItems(work.slides ?? work).forEach((entry, i) => {
      const slide = entry ?? {};
      lines.push(`## Slide ${i + 1}: ${headingText(slide.title ?? slide) || 'Untitled'}`);
      add(slide.subtitle);
      add(slide.body);
      bullets(slide.bullets);
      renderMedia(image(slide.imageAssetId ?? slide.assetId, slide.imageSourceId ?? slide.sourceId), slide.caption ?? slide.imageCaption ?? slide.title ?? '');
      for (const block of legacyItems(slide.blocks)) {
        add(block?.body ?? block?.text ?? block);
        bullets(block?.bullets ?? block?.items);
        renderMedia(image(block?.imageAssetId ?? block?.assetId, block?.imageSourceId ?? block?.sourceId), block?.caption ?? '');
      }
      if (legacyText(slide.speakerNotes)) lines.push(`> Speaker Notes: ${slide.speakerNotes.trim().replace(/\r?\n/g, '\n> ')}`);
    });
  } else if (node.modality === 'image_gallery') {
    legacyItems(work.frames ?? work.images ?? work).forEach((entry, i) => {
      const frame = entry ?? {};
      lines.push(`## ${headingText(frame.title) || `Frame ${i + 1}`}`);
      renderMedia(image(frame.assetId ?? frame.imageAssetId ?? frame, frame.sourceId ?? frame.imageSourceId) ?? inlineImage(frame.svgMarkup, i), '');
      add(frame.caption);
      labeled('Notes', frame.notes);
      labeled('Prompt', frame.prompt);
    });
  } else if (node.modality === 'video_episode') {
    renderMedia(video(work.videoAssetId, work.videoSourceId), 'Episode video');
    renderMedia(image(work.posterAssetId, work.posterSourceId), 'Episode poster');
    let elapsed = 0;
    legacyItems(work.scenes ?? work).forEach((entry, i) => {
      const scene = entry ?? {};
      const duration = typeof scene.durationSec === 'number' ? scene.durationSec : Number(legacyText(scene.durationSec));
      const end = elapsed + (Number.isFinite(duration) && duration > 0 ? Math.max(1, duration) : 6);
      lines.push(`## Scene ${i + 1}: ${headingText(scene.title) || 'Untitled'}`, `**Time:** ${timestamp(elapsed)}–${timestamp(end)}`);
      elapsed = end;
      labeled('Narration', scene.narration ?? scene.script ?? scene);
      const subtitles = legacyItems(scene.subtitles).map(cue => legacyText(cue?.text ?? cue)).filter(Boolean).join('\n');
      labeled('Subtitles', legacyText(scene.subtitles) || subtitles || scene.caption);
      labeled('Visual prompt', scene.visualPrompt);
      const visual = media(scene.assetId, scene.sourceId);
      renderMedia(video(scene.videoAssetId, scene.videoSourceId) ?? (visual?.kind === 'videos' ? visual : null), 'Scene video');
      renderMedia(image(scene.frameAssetId ?? scene.posterAssetId, scene.frameSourceId ?? scene.posterSourceId)
        ?? (visual?.kind === 'images' ? visual : null), 'Scene frame');
    });
  }
  return `${lines.join('\n\n')}\n`;
}

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
    this.yeaftDir = fs.existsSync(yeaftDir) ? fs.realpathSync(yeaftDir) : resolve(yeaftDir);
    const base = storageRoot == null ? join(this.yeaftDir, 'creations') : resolve(storageRoot);
    this.creationsRoot = base;
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
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
        this.transaction(() => {
          this.db.exec(SCHEMA);
          if (!this.all('PRAGMA table_info(creations)').some(column => column.name === 'cache_dir')) {
            this.db.exec('ALTER TABLE creations ADD COLUMN cache_dir TEXT');
          }
          this.#migrateSharedLegacyCache();
        });
      }
    } catch (error) { this.db.close(); throw error; }
  }

  close() { this.db.close(); }
  transaction(fn) {
    if (this.tx) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    const tx = this.tx = { rollback: [], afterCommit: [] };
    let committed = false;
    let result;
    try {
      result = fn();
      this.db.exec('COMMIT');
      committed = true;
    } catch (error) {
      if (!committed) {
        try { this.db.exec('ROLLBACK'); } catch {}
        for (const cleanup of tx.rollback.reverse()) cleanup();
      }
      throw error;
    } finally { this.tx = null; }
    for (const hook of tx.afterCommit) {
      try { hook(); }
      catch (err) { console.warn('[CreationStore] post-commit cleanup failed:', err?.message || err); }
    }
    return result;
  }
  one(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }

  #cachePath(id) { return join(this.root, CACHE_CONTAINER, safeId(id)); }
  #legacyCachePath(id) {
    return safeId(id).toLowerCase() === LEGACY_WORKSPACE_CONTAINER ? null : join(this.root, id);
  }
  #path(id, ...parts) {
    const { cache_dir: cache } = this.#creation(id);
    const root = cache == null ? join(this.root, safeId(id)) : cache === this.#cachePath(id) ? cache : null;
    if (!root) fail('INVALID_PATH', 'Invalid Creation cache directory');
    return join(root, ...parts);
  }
  #migrateSharedLegacyCache() {
    for (const { id } of this.all('SELECT id FROM creations WHERE id = ? COLLATE NOCASE AND cache_dir IS NULL', LEGACY_WORKSPACE_CONTAINER)) {
      const legacy = join(this.root, safeId(id));
      const cache = this.#cachePath(id);
      const copy = (...parts) => {
        const source = join(legacy, ...parts);
        if (!fs.lstatSync(source, { throwIfNoEntry: false })) return;
        const { fd } = this.#openCacheFile(legacy, source);
        let bytes;
        try { bytes = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
        const dest = join(cache, ...parts);
        if (fs.lstatSync(dest, { throwIfNoEntry: false })) {
          // A previous upgrade may have copied this leaf before SQLite committed.
          const { fd } = this.#openCacheFile(cache, dest);
          try {
            if (!fs.readFileSync(fd).equals(bytes)) fail('CONFLICT', 'Migrated Creation file already exists with different bytes');
          } finally { fs.closeSync(fd); }
        } else {
          this.#write(dest, bytes);
        }
      };
      // The legacy root is shared with workspaces. Never traverse or remove it;
      // copy only recorded cache leaves, leaving the old layout readable too.
      for (const row of this.all('SELECT id FROM creation_sources WHERE creation_id=?', id)) {
        copy('sources', safeId(row.id), 'original');
        copy('sources', safeId(row.id), 'parsed.json');
      }
      for (const row of this.all('SELECT id,node_id,data FROM creation_revisions WHERE creation_id=?', id)) {
        copy('artifacts', safeId(row.node_id), 'revisions', `${safeId(row.id)}.${data(row).structured ? 'json' : 'snap'}`);
      }
      for (const row of this.all('SELECT id,data FROM creation_assets WHERE creation_id=?', id)) {
        copy('assets', this.#assetFilename({ ...data(row), id: row.id }, { legacy: true }));
      }
      this.run('UPDATE creations SET cache_dir=? WHERE id=?', cache, id);
    }
  }
  #directory(path) {
    if (!contains(this.root, path)) fail('INVALID_PATH', 'Invalid Creations file path');
    let current = this.root;
    if (fs.realpathSync(current) !== current) fail('INVALID_PATH', 'Invalid Creations directory');
    for (const part of relative(this.root, path).split(sep)) {
      current = join(current, part);
      let created = false;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
        created = true;
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (!this.#ownedDirectory(current)) fail('INVALID_PATH', 'Invalid Creations directory');
      if (created) syncWorkspaceDirectory(dirname(current));
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
  #open(creationId, path) { return this.#openCacheFile(this.#path(creationId), path); }

  #openCacheFile(creationRoot, path) {
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
    const { ownsWorkspace, workspaceIdentity, boundRootIdentity, pendingBindTarget, pendingBindIdentity, ...rec } = data(row);
    return { ...rec, category: rec.category ?? inferCategoryFromKind(rec.kind), sessionId: rec.sessionId ?? null, projectId: rec.projectId ?? null, rootDir: rec.rootDir ?? null,
      summary: rec.description || rec.mission || '', celestial: rec.placement, updatedAt: row.updated_at, ...counts, ...totals, hasReadableContent: counts.readableUnitCount > 0,
      activeRunStatus: active?.status ?? null, activeRunProgress: active?.progress?.total > 0 ? active.progress.completed / active.progress.total : null };
  }
  listCreations() { return this.all('SELECT * FROM creations ORDER BY updated_at DESC,id').map(row => this.#summary(row)); }
  getCreation(id) { return this.#summary(this.#creation(id)); }
  // Prepare related records in the same transaction as the Creation and its inputs.
  // External publication runs only after that transaction commits.
  createCreation(input, { prepare, onWorkspaceMaterialized } = {}) {
    const nested = Boolean(this.tx);
    let newlyCreatedJournalToken;
    let retryBindTarget;
    const result = this.transaction(() => {
      const { importKey } = input;
      if (importKey !== undefined) {
        if (typeof importKey !== 'string' || importKey.length > 128 || !importKey.trim() || importKey.includes('\0')
          || !importKey.isWellFormed()) fail('INVALID_REQUEST', 'Invalid import key');
        const existing = this.one('SELECT creation_id FROM creation_import_keys WHERE import_key=?', importKey);
        if (existing) {
          const row = this.#creation(existing.creation_id);
          const creation = this.#summary(row);
          if (!importKey.startsWith('bind-folder:') || input.rootDir == null) {
            return { ...creation, deduplicated: true };
          }
          const targetRoot = this.#linkableRootFolder(input.rootDir);
          const pending = this.one('SELECT target_dir FROM creation_materialization_journal WHERE creation_id=?', creation.id);
          if (creation.rootDir === targetRoot || (creation.rootDir == null && pending?.target_dir === targetRoot)) {
            return { ...creation, deduplicated: true };
          }
          if (creation.rootDir == null && input.initializeFolder === true && data(row).pendingBindTarget === targetRoot) {
            retryBindTarget = targetRoot;
            return { ...creation, deduplicated: true };
          }
          this.run('DELETE FROM creation_import_keys WHERE import_key=?', importKey);
        }
      }
      if (input.initializeFolder !== undefined && typeof input.initializeFolder !== 'boolean') {
        fail('INVALID_REQUEST', 'Invalid initializeFolder');
      }
      const id = idFor(input.id);
      const category = normalizeCategory(input.category, input.kind);
      const kind = pick(input.kind ?? DEFAULT_KIND_BY_CATEGORY[category], CREATION_KINDS, 'creation kind');
      const modality = input.modality ?? MODALITY_BY_KIND[kind];
      if (modality !== MODALITY_BY_KIND[kind]) fail('INVALID_REQUEST', 'Modality does not match creation kind');
      const cache = this.#cachePath(id);
      if (this.one('SELECT id FROM creations WHERE id=?', id) || fs.lstatSync(cache, { throwIfNoEntry: false })) {
        fail('CONFLICT', 'Creation identifier is in use');
      }
      const index = this.one('SELECT COUNT(*) AS count FROM creations').count;
      const createdAt = now();
      const record = this.#creationFields({ id, kind, category, modality, createdAt, incarnation: randomUUID(), title: 'Untitled creation',
        mission: '', description: '', status: 'draft', readingNodeId: null, readingOffset: 0,
        sessionId: null, projectId: null, rootDir: null, placement: defaultCelestialPlacement(kind, index) }, input);
      const externalRoot = input.initializeFolder === true && record.rootDir;
      const externalRootIdentity = externalRoot ? record.boundRootIdentity : undefined;
      if (externalRoot) {
        if (nested) fail('INVALID_STATE', 'External materialization cannot run inside another transaction');
        record.rootDir = null;
        delete record.boundRootIdentity;
      } else if (input.initializeFolder === true) {
        this.#initializeWorkspace(record);
      }
      this.run('INSERT INTO creations (id,updated_at,data,cache_dir) VALUES (?,?,?,?)', id, createdAt, json(record), cache);
      if (importKey !== undefined) this.run('INSERT INTO creation_import_keys VALUES (?,?)', importKey, id);
      if (input.files !== undefined || input.textSources !== undefined) {
        this.addSources(id, input, { copyToWorkspace: !externalRoot && input.initializeFolder === true,
          validateWorkspaceNames: Boolean(externalRoot) });
      }
      prepare?.(id);
      if (externalRoot) {
        // Preparation can add nodes, canon and assets. Validate the full plan
        // without touching the external folder, then checkpoint it with the inputs.
        const pending = data(this.#creation(id));
        const { planned, published, rootIdentity } = this.#planAndPreflightExternalFolder(
          id, externalRoot, pending, {}, {}, externalRootIdentity);
        if (importKey?.startsWith('bind-folder:')) {
          // Keep the verified target and identity even if the untouched journal is retired.
          pending.pendingBindTarget = externalRoot;
          pending.pendingBindIdentity = { dev: rootIdentity.dev, ino: rootIdentity.ino };
          this.run('UPDATE creations SET data=? WHERE id=?', json(pending), id);
        }
        newlyCreatedJournalToken = { target_dir: externalRoot, temp_files_json: '[]',
          planned_outputs_json: this.#journalPlanJson(planned, rootIdentity), published_outputs_json: json(published), updated_at: Date.now() };
        this.run('INSERT INTO creation_materialization_journal VALUES (?,?,?,?,?,?)', id, ...Object.values(newlyCreatedJournalToken));
      }
      return this.getCreation(id);
    });
    if (result.rootDir == null) {
      const pending = this.one('SELECT target_dir FROM creation_materialization_journal WHERE creation_id=?', result.id);
      const target = pending?.target_dir ?? retryBindTarget;
      if (target) {
        if (input.initializeFolder === true && input.rootDir != null && folderPath(input.rootDir) !== target) {
          fail('CONFLICT', 'Resume materialization in the original target folder');
        }
        const { creation, materialized } = this.ensureWorkspace(result.id, { rootDir: target, newlyCreatedJournalToken });
        if (result.deduplicated && (materialized || (creation.rootDir ?? null) !== (result.rootDir ?? null))) onWorkspaceMaterialized?.(result.id);
        return result.deduplicated ? { ...creation, deduplicated: true } : creation;
      }
    }
    return result;
  }
  #creationFields(record, input) {
    for (const key of ['sessionId', 'projectId']) if (own(input, key)) record[key] = optionalLinkId(input[key], key);
    if (own(input, 'rootDir')) {
      const rootDir = input.rootDir == null ? null : this.#linkableRootFolder(input.rootDir);
      if (record.rootDir !== rootDir) {
        delete record.ownsWorkspace;
        delete record.workspaceIdentity;
      }
      if (rootDir == null) delete record.boundRootIdentity;
      else if (!record.workspaceIdentity) {
        // An unchanged path must not silently adopt a replacement inode.
        const boundRootIdentity = record.rootDir === rootDir ? record.boundRootIdentity : undefined;
        const stat = this.#canonicalDirectoryStat(rootDir, { code: 'INVALID_REQUEST', boundRootIdentity });
        record.boundRootIdentity = rootIdentityOf(stat);
      }
      record.rootDir = rootDir;
    }
    if (own(input, 'title')) record.title = title(input.title);
    if (own(input, 'kind') && input.kind !== undefined) {
      const nextKind = pick(input.kind, CREATION_KINDS, 'creation kind');
      if (own(input, 'modality') && input.modality !== undefined && input.modality !== MODALITY_BY_KIND[nextKind]) {
        fail('INVALID_REQUEST', 'Modality does not match creation kind');
      }
      record.kind = nextKind;
      record.modality = MODALITY_BY_KIND[nextKind];
    }
    if (own(input, 'category') && input.category !== undefined) {
      record.category = normalizeCategory(input.category, record.kind);
    }
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
      const record = data(this.#creation(id));
      if (own(patch, 'expectedSessionId')) {
        const expected = optionalLinkId(patch.expectedSessionId, 'expectedSessionId');
        if ((record.sessionId ?? null) !== expected) fail('CONFLICT', 'Creation session link changed concurrently');
      }
      const previousRoot = record.rootDir ?? null;
      this.#creationFields(record, patch);
      if (own(patch, 'rootDir')) {
        const journal = this.one('SELECT temp_files_json FROM creation_materialization_journal WHERE creation_id=?', id);
        if ((record.rootDir ?? null) !== previousRoot || (record.rootDir == null && (journal || record.pendingBindTarget))) {
          this.run('DELETE FROM creation_materialization_journal WHERE creation_id=?', id);
          this.run("DELETE FROM creation_import_keys WHERE creation_id=? AND import_key LIKE 'bind-folder:%'", id);
          if (journal) {
            const temps = JSON.parse(journal.temp_files_json);
            this.tx.afterCommit.push(() => this.#cleanupJournalTemps(this.#stagingDir(id), temps));
          }
        }
        delete record.pendingBindTarget;
        delete record.pendingBindIdentity;
      }
      this.run('UPDATE creations SET updated_at=?,data=? WHERE id=?', now(), json(record), id);
      return this.getCreation(id);
    });
  }
  listDocStates(creationId) {
    this.#creation(creationId);
    const rows = this.all(`SELECT file_path, status, updated_at,
      (SELECT COUNT(*) FROM json_each(review_data, '$.annotations') a
        WHERE a.type='object' AND a.value ->> 'status' = 'open') AS open_count
      FROM (
        SELECT s.file_path, s.status, s.updated_at, r.data AS review_data
        FROM creation_doc_states s LEFT JOIN creation_doc_reviews r USING (creation_id, file_path)
        WHERE s.creation_id=?
        UNION ALL
        SELECT r.file_path, 'draft', r.updated_at, r.data
        FROM creation_doc_reviews r LEFT JOIN creation_doc_states s USING (creation_id, file_path)
        WHERE r.creation_id=? AND s.file_path IS NULL
      ) ORDER BY file_path`, creationId, creationId);
    return Object.fromEntries(rows.map(row => [row.file_path, {
      status: row.status, updatedAt: row.updated_at, openReviewCount: row.open_count,
    }]));
  }

  getDocState(creationId, filePath) {
    const row = this.one('SELECT file_path, status, updated_at FROM creation_doc_states WHERE creation_id=? AND file_path=?',
      safeId(creationId), normalizeDocFilePath(filePath));
    return row ? { filePath: row.file_path, status: row.status, updatedAt: row.updated_at } : null;
  }

  #checkDocPathQuota(creationId, filePath) {
    if (this.getDocState(creationId, filePath)
      || this.one('SELECT 1 FROM creation_doc_reviews WHERE creation_id=? AND file_path=?', creationId, filePath)
      || this.one('SELECT 1 FROM creation_doc_review_attempts WHERE creation_id=? AND file_path=?', creationId, filePath)) return;
    const { count } = this.one(`SELECT COUNT(*) AS count FROM (
      SELECT file_path FROM creation_doc_states WHERE creation_id=?
      UNION SELECT file_path FROM creation_doc_reviews WHERE creation_id=?
      UNION SELECT file_path FROM creation_doc_review_attempts WHERE creation_id=?
    )`, creationId, creationId, creationId);
    if (count >= LIMITS.docStates) fail('LIMIT_EXCEEDED', 'Document workflow state limit reached');
  }

  setDocState(creationId, filePath, status) {
    filePath = normalizeDocFilePath(filePath);
    pick(status, DOC_WORKFLOW_STATUSES, 'document workflow status');
    return this.transaction(() => {
      this.#creation(creationId);
      this.#checkDocPathQuota(creationId, filePath);
      const updatedAt = now();
      this.run(`INSERT INTO creation_doc_states (creation_id,file_path,status,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(creation_id,file_path) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at`,
      creationId, filePath, status, updatedAt);
      return { filePath, status, updatedAt };
    });
  }

  getDocReview(creationId, filePath) {
    this.#creation(creationId);
    return data(this.one('SELECT data FROM creation_doc_reviews WHERE creation_id=? AND file_path=?', creationId, normalizeDocFilePath(filePath)));
  }

  #checkDocReviewCreation(creationId, expectedIncarnation, expectedRootDir) {
    const rec = data(this.#creation(creationId));
    if (expectedIncarnation !== undefined && (rec.incarnation ?? rec.createdAt) !== expectedIncarnation) {
      fail('STALE', 'Creation changed before review completed');
    }
    if (expectedRootDir !== undefined && (rec.rootDir ?? null) !== expectedRootDir) {
      fail('STALE', 'Creation workspace changed before review completed');
    }
  }

  beginDocReviewAttempt(creationId, filePath, { expectedIncarnation, expectedRootDir } = {}) {
    filePath = normalizeDocFilePath(filePath);
    return this.transaction(() => {
      this.#checkDocReviewCreation(creationId, expectedIncarnation, expectedRootDir);
      this.#checkDocPathQuota(creationId, filePath);
      const { attempt_id: attemptId } = this.one(`INSERT INTO creation_doc_review_attempts
        (creation_id,file_path,attempt_id,updated_at) VALUES (?,?,1,?)
        ON CONFLICT(creation_id,file_path) DO UPDATE SET attempt_id=attempt_id+1,updated_at=excluded.updated_at
        RETURNING attempt_id`, creationId, filePath, now());
      return { attemptId };
    });
  }

  saveDocReview(creationId, filePath, review, { expectedIncarnation, expectedRootDir, attemptId } = {}) {
    filePath = normalizeDocFilePath(filePath);
    return this.transaction(() => {
      this.#checkDocReviewCreation(creationId, expectedIncarnation, expectedRootDir);
      if (attemptId != null) {
        const row = this.one('SELECT attempt_id FROM creation_doc_review_attempts WHERE creation_id=? AND file_path=?', creationId, filePath);
        if (row?.attempt_id !== attemptId) fail('STALE', 'Document review was superseded by a newer review');
      }
      this.#checkDocPathQuota(creationId, filePath);
      let encoded;
      try { encoded = json(review); } catch { fail('INVALID_REQUEST', 'Invalid document review'); }
      if (!encoded?.startsWith('{')) fail('INVALID_REQUEST', 'Invalid document review');
      if (Buffer.byteLength(encoded) > 512 * 1024) fail('LIMIT_EXCEEDED', 'Document review is too large');
      this.run(`INSERT INTO creation_doc_reviews (creation_id,file_path,updated_at,data) VALUES (?,?,?,?)
        ON CONFLICT(creation_id,file_path) DO UPDATE SET updated_at=excluded.updated_at,data=excluded.data`,
      creationId, filePath, now(), encoded);
      return JSON.parse(encoded);
    });
  }

  updateDocReviewAnnotation(creationId, filePath, annotationId, status) {
    pick(status, ['open', 'accepted', 'dismissed'], 'review annotation status');
    boundedText(annotationId, 256, 'review annotation identifier', { required: true });
    return this.transaction(() => {
      const review = this.getDocReview(creationId, filePath);
      if (!review) notFound('Document review');
      const annotation = Array.isArray(review.annotations) && review.annotations.find(item => item?.id === annotationId);
      if (!annotation) notFound('Review annotation');
      annotation.status = status;
      // Some consumers display the per-lens list as well as the sorted list.
      if (Array.isArray(review.lensResults)) for (const lens of review.lensResults) {
        const copy = Array.isArray(lens?.annotations) && lens.annotations.find(item => item?.id === annotationId);
        if (copy) copy.status = status;
      }
      return this.saveDocReview(creationId, filePath, review);
    });
  }

  deleteCreation(id, { purgeWorkspace = false } = {}) {
    return this.transaction(() => {
      const row = this.#creation(id);
      if (this.one("SELECT id FROM creation_runs WHERE creation_id=? AND status='running'", id)) fail('BUSY', 'Creation has an active run');
      const { rootDir, ownsWorkspace, workspaceIdentity } = data(row);
      const workspace = this.#workspacePath(id);
      const cache = row.cache_dir ?? this.#legacyCachePath(id);
      const protectedPaths = this.all(`SELECT root_dir FROM protected_workspaces UNION
        SELECT json_extract(data,'$.rootDir') FROM creations WHERE id<>? AND json_type(data,'$.rootDir')='text'
        UNION SELECT target_dir FROM creation_materialization_journal`, id).map(row => row.root_dir);
      const protectedPath = path => protectedPaths.some(root => overlaps(root, path));
      if (cache && !protectedPath(cache) && !(rootDir && overlaps(rootDir, cache))) {
        const stat = this.#ownedDirectory(cache);
        if (stat && (row.cache_dir === this.#cachePath(id) || (row.cache_dir == null
          && fs.readdirSync(cache, { withFileTypes: true }).every(entry => entry.isDirectory() && CACHE_DIRS.has(entry.name))))) {
          this.#reclaimAfterCommit(cache, stat);
        }
      }
      if (purgeWorkspace === true && ownsWorkspace === true && rootDir === workspace && !protectedPath(workspace)) {
        const stat = this.#ownedDirectory(workspace);
        if (stat && workspaceIdentity?.dev === stat.dev && workspaceIdentity?.ino === stat.ino) this.#reclaimAfterCommit(workspace, stat);
      }
      const journal = this.one('SELECT temp_files_json FROM creation_materialization_journal WHERE creation_id=?', id);
      if (journal) this.#cleanupJournalTemps(this.#stagingDir(id), JSON.parse(journal.temp_files_json));
      this.run('DELETE FROM creation_materialization_journal WHERE creation_id=?', id);
      this.run('DELETE FROM creations WHERE id=?', id);
      return { deleted: true, id };
    });
  }

  #ownedDirectory(path) {
    try {
      const stat = fs.lstatSync(path, { throwIfNoEntry: false });
      return stat?.isDirectory() && fs.realpathSync(path) === path ? stat : null;
    } catch { return null; }
  }

  #reclaimAfterCommit(path, { dev, ino }) {
    this.tx.afterCommit.push(() => {
      const stat = this.#ownedDirectory(path);
      if (stat?.dev === dev && stat.ino === ino) this.#remove(path);
    });
  }

  #workspacePath(id, container = WORKSPACE_CONTAINER) { return join(this.root, container, safeId(id)); }

  #assertExternalFolder(path) {
    if (overlaps(this.creationsRoot, path) || overlaps(join(this.yeaftDir, 'creations'), path)
      || isWithin(path, this.yeaftDir)) {
      fail('INVALID_PATH', 'Cannot link a workspace that overlaps private Creation storage');
    }
  }

  #recordedWorkspace(id, { rootDir: path, boundRootIdentity }, { allowMissing = false } = {}) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || resolve(path) !== path) {
      fail('INVALID_PATH', 'Invalid recorded workspace path');
    }
    if (path !== this.#workspacePath(id) && path !== this.#workspacePath(id, LEGACY_WORKSPACE_CONTAINER)) {
      this.#assertExternalFolder(path);
    }
    return this.#assertNoSymlinkDir(path, { code: 'INVALID_REQUEST', allowMissing, boundRootIdentity });
  }

  resolveWorkspaceBinding(id) {
    try {
      const record = data(this.#creation(id));
      if (record?.rootDir == null) return null;
      return { rootDir: this.#recordedWorkspace(id, record), boundRootIdentity: record.boundRootIdentity ?? null };
    } catch (error) {
      if (['NOT_FOUND', 'INVALID_REQUEST', 'INVALID_PATH'].includes(error.code)) return null;
      throw error;
    }
  }

  resolveWorkspaceRoot(id) {
    return this.resolveWorkspaceBinding(id)?.rootDir ?? null;
  }

  #assertNoSymlinkDir(dirPath, options) {
    return this.#canonicalDirectoryStat(dirPath, options) ? dirPath : null;
  }

  #canonicalDirectoryStat(dirPath, { code = 'INVALID_PATH', allowMissing = false, root = dirPath, boundRootIdentity } = {}) {
    try {
      const stat = fs.lstatSync(dirPath, { bigint: true, throwIfNoEntry: false });
      if (!stat && allowMissing) {
        // ENOENT can also mean that an ancestor is a dangling symlink or
        // redirects to a directory where the final component is absent.
        for (let parent = dirname(dirPath); ; parent = dirname(parent)) {
          if (fs.lstatSync(parent, { throwIfNoEntry: false })) {
            this.#assertNoSymlinkDir(parent, { code });
            return null;
          }
          if (parent === dirname(parent)) break;
        }
      }
      if (stat?.isDirectory() && !stat.isSymbolicLink()) {
        const canonical = fs.realpathSync(dirPath);
        if (canonical === dirPath && (canonical === root || contains(root, canonical))) {
          if (boundRootIdentity != null && !matchesRootIdentity(stat, boundRootIdentity)) {
            fail('INVALID_PATH', 'Bound workspace directory changed');
          }
          return stat;
        }
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM', 'ENAMETOOLONG'].includes(error.code)) throw error;
    }
    fail(code, 'Expected a canonical directory with no symbolic links');
  }
  #rootFolder(value, { allowMissing = false } = {}) {
    const path = folderPath(value);
    return this.#assertNoSymlinkDir(path, { code: 'INVALID_REQUEST', allowMissing }) ?? path;
  }
  #linkableRootFolder(value) {
    const path = folderPath(value);
    this.#assertExternalFolder(path);
    return this.#assertNoSymlinkDir(path, { code: 'INVALID_REQUEST' });
  }
  #walkWorkspace(root, path, create = false) {
    if (path !== root && !contains(root, path)) fail('INVALID_PATH', 'Invalid workspace path');
    this.#assertNoSymlinkDir(root);
    if (path === root) return path;
    let current = root;
    for (const part of relative(root, path).split(sep)) {
      current = join(current, part);
      if (create && !this.#assertNoSymlinkDir(current, { root, allowMissing: true })) {
        if (!this.tx) fail('CONFLICT', 'Workspace directory changed during materialization');
        try {
          fs.mkdirSync(current, { mode: 0o700 });
          const created = current;
          const { dev, ino } = fs.lstatSync(created);
          this.tx.rollback.push(() => {
            try {
              this.#assertNoSymlinkDir(created, { root });
              const stat = fs.lstatSync(created);
              if (stat.dev === dev && stat.ino === ino) fs.rmdirSync(created);
            } catch { /* not empty or no longer ours */ }
          });
          syncWorkspaceDirectory(dirname(created));
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      this.#assertNoSymlinkDir(current, { root });
    }
    return path;
  }
  #writeWorkspaceFile(root, dir, name, bytes, { dedupe = true, claimed } = {}) {
    const path = join(dir, name);
    if (!contains(root, path) || dirname(path) !== dir) fail('INVALID_PATH', 'Invalid workspace filename');
    const ext = extname(name);
    const expected = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    for (let index = 1; ; index++) {
      this.#walkWorkspace(root, dir);
      const dest = index === 1 ? path : join(dir, `${name.slice(0, name.length - ext.length)}-${index}${ext}`);
      const existing = fs.lstatSync(dest, { bigint: true, throwIfNoEntry: false });
      if (existing?.isSymbolicLink()) fail('INVALID_PATH', 'Workspace file cannot be a symbolic link');
      if (existing || claimed?.has(dest)) {
        if (!dedupe) return null;
        // Reconcile files published before an interrupted SQLite commit. Each
        // output can claim a matching name only once per materialization.
        if (claimed && !claimed.has(dest) && existing?.isFile() && existing.size === BigInt(expected.length)
          && this.#workspaceFileMatches(root, dest, existing, expected)) {
          claimed.add(dest);
          return dest;
        }
        continue;
      }
      const temp = join(dir, `.creation-tmp-${randomUUID()}`);
      const fd = fs.openSync(temp, CREATE_EXCLUSIVE, 0o600);
      let identity;
      try {
        const { dev, ino } = identity = fs.fstatSync(fd);
        this.#walkWorkspace(root, dir);
        assertWorkspaceDescriptor(fd, temp);
        fs.writeFileSync(fd, expected);
        fs.fsyncSync(fd);
        this.#walkWorkspace(root, dir);
        // Publish complete bytes without overwriting a concurrently created file.
        fs.linkSync(temp, dest);
        this.tx.rollback.push(() => this.#unlinkWorkspaceFile(root, dest, dev, ino));
        syncWorkspaceDirectory(dir);
        claimed?.add(dest);
        return dest;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Recheck this name (including for symlinks) after a lost publish race.
        index--;
      } finally {
        try { fs.closeSync(fd); }
        finally { if (identity) this.#unlinkWorkspaceFile(root, temp, identity.dev, identity.ino); }
      }
    }
  }
  #unlinkWorkspaceFile(root, path, dev, ino) {
    try {
      this.#walkWorkspace(root, dirname(path));
      const stat = fs.lstatSync(path);
      if (stat.dev === dev && stat.ino === ino) fs.unlinkSync(path);
    } catch { /* file no longer reachable */ }
  }
  #workspaceFileMatches(root, path, existing, expected) {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      this.#walkWorkspace(root, dirname(path));
      const stat = fs.fstatSync(fd, { bigint: true });
      const named = fs.lstatSync(path, { bigint: true });
      if (!stat.isFile() || stat.ino !== existing.ino || stat.dev !== existing.dev
        || stat.ino !== named.ino || stat.dev !== named.dev) fail('INVALID_PATH', 'Workspace file changed during open');
      const bytes = Buffer.alloc(expected.length + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = fs.readSync(fd, bytes, size, bytes.length - size, size);
        if (!count) break;
        size += count;
      }
      return size === expected.length && bytes.subarray(0, size).equals(expected);
    } finally { fs.closeSync(fd); }
  }
  #initializeWorkspace(record, { materialize = false } = {}) {
    const populate = dir => {
      for (const name of WORKSPACE_DIRS) this.#walkWorkspace(dir, join(dir, name), true);
      this.#writeWorkspaceFile(dir, dir, 'README.md', `# ${record.title}\n\n${record.mission || record.description}\n`, { dedupe: false });
      if (materialize) this.#materializeWorkspace(record.id, dir);
    };
    delete record.ownsWorkspace;
    delete record.workspaceIdentity;
    delete record.boundRootIdentity;
    const rootDir = this.#workspacePath(record.id);
    const parent = this.#walkWorkspace(this.root, dirname(rootDir), true);
    // BEGIN IMMEDIATE serializes attempts. The delimiter cannot occur in an ID.
    const prefix = `.staging-${record.id}.`;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) this.#remove(join(parent, entry.name));
    }
    if (this.#assertNoSymlinkDir(rootDir, { allowMissing: true })) {
      populate(rootDir);
    } else {
      const staging = fs.mkdtempSync(join(parent, prefix));
      this.tx.rollback.push(() => this.#remove(staging));
      populate(staging);
      this.#assertNoSymlinkDir(parent);
      if (fs.lstatSync(rootDir, { throwIfNoEntry: false })) fail('CONFLICT', 'Workspace directory appeared during initialization');
      const { dev, ino } = fs.lstatSync(staging);
      fs.renameSync(staging, rootDir);
      record.ownsWorkspace = true;
      record.workspaceIdentity = { dev, ino };
      this.tx.rollback.push(() => {
        const stat = fs.lstatSync(rootDir, { throwIfNoEntry: false });
        if (stat?.dev === dev && stat.ino === ino) this.#remove(rootDir);
      });
      syncWorkspaceDirectory(parent);
    }
    record.rootDir = rootDir;
    delete record.pendingBindTarget;
    delete record.pendingBindIdentity;
  }
  #unsafeSourceName(name) { return name.split(/[\\/]/).includes('..'); }
  #copyWorkspaceSource(root, source, bytes, { legacy = false, write,
    directory = path => this.#walkWorkspace(root, path, true) } = {}) {
    let name = source.name;
    if (this.#unsafeSourceName(name)) {
      if (!legacy) fail('INVALID_REQUEST', 'Invalid workspace source filename');
      // Old uploads could use traversal-like display names. Recover their bytes under a safe ID.
      name = source.id;
    }
    const dir = directory(join(root, 'sources'));
    return (write ?? ((_, ...args) => this.#writeWorkspaceFile(root, ...args)))(`source:${source.id}`, dir, workspaceName(name, 'Source'), bytes);
  }
  #materializeWorkspace(id, root, write, directory = path => this.#walkWorkspace(root, path, true)) {
    const external = Boolean(write);
    const claimed = new Set();
    write ??= (_, dir, name, bytes) => this.#writeWorkspaceFile(root, dir, name, bytes, { claimed });
    const assets = new Map();
    const sources = new Map();
    const sourcePaths = new Map();
    const copyMedia = (key, kind, name, bytes) => write(key, directory(join(root, kind)), name, bytes);
    for (const asset of this.all("SELECT data FROM creation_assets WHERE creation_id=? AND id NOT IN ('export-markdown','export-json') ORDER BY rowid", id).map(data)) {
      const kind = legacyMediaType(asset.mimeType, asset.ext) ?? 'assets';
      const bytes = this.#readBytes(id, this.#assetPath(id, asset, { legacy: true }), LIMITS.assetBytes);
      const name = workspaceName(asset.name ?? `${asset.id}.${asset.ext}`, `${asset.id}.${asset.ext}`);
      const path = copyMedia(`asset:${asset.id}`, kind, name, bytes);
      assets.set(asset.id, { kind, path });
    }
    for (const source of this.listSources(id)) {
      const bytes = this.#readBytes(id, this.#path(id, 'sources', safeId(source.id), 'original'), LIMITS.sourceBytes);
      this.#copyWorkspaceSource(root, source, bytes, { legacy: true, write, directory });
      sources.set(source.id, source);
    }
    const sourceMedia = sourceId => {
      if (sourcePaths.has(sourceId)) return sourcePaths.get(sourceId);
      const source = sources.get(sourceId);
      if (!source) return null;
      const ext = extname(source.name).slice(1);
      const kind = legacyMediaType(source.detectedMimeType, ext) ?? legacyMediaType(source.mimeType, ext);
      if (!kind) return null;
      const bytes = this.#readBytes(id, this.#path(id, 'sources', safeId(sourceId), 'original'), LIMITS.sourceBytes);
      const path = copyMedia(`source-media:${sourceId}`, kind, workspaceName(source.name, sourceId), bytes);
      const ref = { kind, path };
      sourcePaths.set(sourceId, ref);
      return ref;
    };
    const visit = (nodes, dir) => {
      const folders = new Set(dir.toLowerCase() === join(root, 'docs').toLowerCase() ? ['canon'] : []);
      const relativeUrl = path => relative(dir, path).split(sep).map(part => encodeURIComponent(part).replace(/[()]/g,
        c => c === '(' ? '%28' : '%29')).join('/');
      for (const node of nodes) {
        const name = workspaceName(node.title, node.id);
        if (node.type === 'folder') {
          for (let index = 1; ; index++) {
            const folder = index === 1 ? name : `${name}-${index}`;
            if (folders.has(folder.toLowerCase())) continue;
            const path = join(dir, folder);
            if (!external) {
              const existing = fs.lstatSync(path, { throwIfNoEntry: false });
              if (existing?.isSymbolicLink()) fail('INVALID_PATH', 'Workspace directory cannot be a symbolic link');
              if (existing && !existing.isDirectory()) continue;
            }
            folders.add(folder.toLowerCase());
            visit(node.children, directory(path));
            break;
          }
        } else if (node.hasReadableContent) {
          const { content } = this.#withContent(node);
          const markdown = node.modality === 'markdown_doc' ? content : legacyMarkdown(node, content, (type, mediaId) => {
            const ref = type === 'asset' ? assets.get(mediaId) : sourceMedia(mediaId);
            return ref && { kind: ref.kind, url: relativeUrl(ref.path) };
          }, (svg, i) => {
            if (typeof svg !== 'string') return null;
            const bytes = Buffer.from(svg);
            if (!validAsset('svg', bytes)) return null;
            return { kind: 'images', url: relativeUrl(copyMedia(`frame:${node.id}:${i}`, 'images', `${node.id}-frame-${i + 1}.svg`, bytes)) };
          });
          write(`node:${node.id}`, dir, `${name}.md`, markdown);
        }
      }
    };
    visit(this.getStructure(id), directory(join(root, 'docs')));
    const canon = this.listCanon(id);
    if (canon.length) {
      const dir = directory(join(root, 'docs', 'canon'));
      for (const item of canon) write(`canon:${item.id}`, dir, `${workspaceName(item.title, item.id)}.md`, item.contentMd);
    }
  }
  #journalPath(root, relPath) {
    const path = resolve(root, relPath);
    if (isAbsolute(relPath) || !contains(root, path)) fail('INVALID_PATH', 'Invalid materialization journal path');
    return path;
  }

  #stagingDir(id) { return join(this.#cachePath(id), '.staging'); }

  #isRecordedStagingTemp(stagingDir, entry) {
    const { path, dev, ino } = entry ?? {};
    if (typeof dev !== 'string' || typeof ino !== 'string' || typeof path !== 'string'
      || !contains(stagingDir, path) || resolve(path) !== path || dirname(path) !== stagingDir
      || !/^\.creation-tmp-[a-zA-Z0-9-]+$/.test(basename(path)) || !this.#ownedDirectory(stagingDir)) return false;
    const stat = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
    return stat?.isFile() && String(stat.dev) === dev && String(stat.ino) === ino;
  }

  #cleanupJournalTemps(stagingDir, temps) {
    for (const entry of temps) {
      if (!this.#isRecordedStagingTemp(stagingDir, entry)) continue;
      fs.unlinkSync(entry.path);
      syncWorkspaceDirectory(stagingDir);
    }
  }

  #journalPlanJson(planned, { dev, ino }) {
    return json({ root_dev: dev, root_ino: ino, ...planned });
  }

  #reconcileWorkspacePublications(root, stagingDir, planned, published, temps, rootIdentity) {
    const keys = new Map(Object.entries(planned).map(([key, output]) => [output.relPath, key]));
    for (const entry of temps) {
      if (!this.#isRecordedStagingTemp(stagingDir, entry)) continue;
      const key = keys.get(entry.relPath);
      if (key === undefined || own(published, key)) continue;
      const dest = this.#journalPath(root, entry.relPath);
      const { entry: stat } = this.#inspectExternalOutput(root, dest, undefined, { rootIdentity });
      // A surviving hard link proves publication only if it is still our temp.
      if (stat && String(stat.dev) === entry.dev && String(stat.ino) === entry.ino) published[key] = entry.relPath;
    }
  }

  #withExternalDirectory(root, path, { rootIdentity, onCreate, allowMissing = false, matchCase = false }, use) {
    requirePinnedWorkspace();
    if (!isWithin(root, path)) fail('INVALID_PATH', 'Invalid workspace directory');
    const handles = [];
    const invalid = () => fail('INVALID_PATH', 'External workspace directory changed or is not canonical');
    const verify = ({ fd, anchor, canonical, stat }) => {
      let real, named;
      try {
        real = fs.realpathSync(fdPath(fd));
        named = fs.lstatSync(anchor, { bigint: true, throwIfNoEntry: false });
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error;
        invalid();
      }
      if (real !== canonical || !named?.isDirectory() || !sameInode(named, stat)) invalid();
    };
    const check = () => handles.forEach(verify);
    const open = (anchor, canonical, parentFd) => {
      let fd;
      const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY;
      try {
        try { fd = fs.openSync(anchor, flags); }
        catch (error) {
          if (error.code !== 'ENOENT' || parentFd === undefined) throw error;
          check();
          if (!onCreate && allowMissing) return;
          if (!onCreate) throw error;
          try {
            fs.mkdirSync(anchor, { mode: 0o700 });
            onCreate();
          } catch (error) { if (error.code !== 'EEXIST') throw error; }
          fd = fs.openSync(anchor, flags);
          fs.fsyncSync(parentFd);
        }
        const stat = fs.fstatSync(fd, { bigint: true });
        if (!stat.isDirectory() || (parentFd === undefined && rootIdentity && !matchesRootIdentity(stat, rootIdentity))) invalid();
        verify({ fd, anchor, canonical, stat });
        handles.push({ fd, anchor, canonical, stat });
        const held = fd;
        fd = undefined;
        return held;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error;
        invalid();
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    };
    try {
      let canonical = root;
      let fd = open(root, root);
      for (const part of path === root ? [] : relative(root, path).split(sep)) {
        check();
        const name = this.#externalEntryName(fd, part);
        if (!matchCase && name !== part) workspaceOccupied();
        canonical = join(canonical, name);
        fd = open(`${fdPath(fd)}/${name}`, canonical, fd);
        if (fd === undefined) return;
      }
      check();
      return use(fd, check, canonical, handles[0].stat);
    } finally {
      for (const handle of handles.reverse()) fs.closeSync(handle.fd);
    }
  }

  #externalEntryName(fd, name) {
    const matches = fs.readdirSync(fdPath(fd)).filter(entry => entry.toLowerCase() === name.toLowerCase());
    if (matches.length > 1) workspaceOccupied();
    return matches[0] ?? name;
  }

  #inspectExternalOutput(root, path, bytes, { rootIdentity, matchCase = false } = {}) {
    return this.#withExternalDirectory(root, dirname(path), { rootIdentity, allowMissing: true }, (dirFd, check) => {
      const name = this.#externalEntryName(dirFd, basename(path));
      if (!matchCase && name !== basename(path)) workspaceOccupied();
      const actualPath = join(dirname(path), name);
      const anchor = `${fdPath(dirFd)}/${name}`;
      const entry = fs.lstatSync(anchor, { bigint: true, throwIfNoEntry: false });
      if (entry && !entry.isFile()) fail('INVALID_PATH', 'Workspace output must be a regular file, not a symbolic link or directory');
      if (!bytes || entry?.size !== BigInt(bytes.length)) return { entry, path: actualPath };
      const fd = fs.openSync(anchor, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        check();
        const stat = fs.fstatSync(fd, { bigint: true });
        if (!sameInode(stat, entry) || !sameInode(fs.lstatSync(anchor, { bigint: true, throwIfNoEntry: false }), stat)) {
          fail('INVALID_PATH', 'Workspace file changed during open');
        }
        return { entry, path: actualPath, matches: workspaceBytesMatch(fd, stat, bytes) };
      } finally { fs.closeSync(fd); }
    }) ?? { path };
  }

  #visitExternalOutputs(id, root, record, write, directory) {
    for (const dir of WORKSPACE_DIRS) directory(join(root, dir));
    write('readme', root, 'README.md', `# ${record.title}\n\n${record.mission || record.description}\n`);
    this.#materializeWorkspace(id, root, write, directory);
  }

  #planAndPreflightExternalFolder(id, root, record, planned = {}, published = {}, rootIdentity) {
    rootIdentity = this.#withExternalDirectory(root, root, { rootIdentity }, (_fd, _check, _path, stat) => rootIdentityOf(stat));
    const claimed = new Set();
    for (const { relPath } of Object.values(planned)) {
      const folded = relPath.toLowerCase();
      if (claimed.has(folded)) workspaceOccupied();
      claimed.add(folded);
    }
    const directories = new Map();
    const existingAncestors = new Map([[root, root]]);
    const writeAncestors = new Set();
    const directory = path => {
      const key = relative(root, path).toLowerCase();
      if (!directories.has(key)) {
        // Resolve existing entries by their real spelling, including ancestors of missing directories.
        const parent = dirname(path) === root ? root : directory(dirname(path));
        const requested = join(parent, basename(path));
        const existing = this.#withExternalDirectory(root, requested, { rootIdentity, allowMissing: true, matchCase: true },
          (_fd, _check, actual) => actual);
        const canonical = existing ?? requested;
        const ancestor = existing ?? existingAncestors.get(parent);
        if (!existing) writeAncestors.add(ancestor);
        existingAncestors.set(canonical, ancestor);
        directories.set(key, canonical);
      }
      return directories.get(key);
    };
    this.#visitExternalOutputs(id, root, record, (key, dir, name, content) => {
      const bytes = Buffer.from(content);
      const sha256 = workspaceDigest(bytes);
      const publication = published[key];
      if (isIncompletePublication(publication)) {
        if (publication.relPath !== planned[key]?.relPath || publication.sha256 !== sha256 || planned[key].sha256 !== sha256) {
          workspaceOccupied();
        }
        return this.#journalPath(root, publication.relPath);
      }
      if (own(published, key)) {
        const path = this.#journalPath(root, publicationPath(publication));
        if (this.#inspectExternalOutput(root, path, undefined, { rootIdentity }).entry) return path; // Published bytes belong to the user now.
        delete published[key];
      }
      if (own(planned, key)) {
        const path = this.#journalPath(root, planned[key].relPath);
        const { entry, matches } = this.#inspectExternalOutput(root, path, bytes, { rootIdentity });
        if (sha256 !== planned[key].sha256 || (entry && !matches)) workspaceOccupied();
        if (matches) published[key] = { relPath: planned[key].relPath, adopted: true };
        else {
          // A resumed output can still use an older planned directory spelling.
          let ancestor = dirname(path);
          while (!this.#withExternalDirectory(root, ancestor, { rootIdentity, allowMissing: true }, () => true)) {
            ancestor = dirname(ancestor);
          }
          writeAncestors.add(ancestor);
        }
        return path;
      }
      const ext = extname(name);
      for (let index = 1; ; index++) {
        const path = join(dir, index === 1 ? name : `${name.slice(0, name.length - ext.length)}-${index}${ext}`);
        const folded = relative(root, path).toLowerCase();
        if (claimed.has(folded)) continue;
        const { entry, matches, path: actualPath } = this.#inspectExternalOutput(root, path, bytes, { rootIdentity, matchCase: true });
        if (entry && !matches && key !== 'readme') continue;
        claimed.add(folded);
        const relPath = relative(root, actualPath);
        planned[key] = { relPath, sha256 };
        if (entry) published[key] = { relPath, adopted: true }; // Preserve an existing user README too.
        else writeAncestors.add(existingAncestors.get(dir));
        return actualPath;
      }
    }, directory);
    for (const folded of claimed) {
      if (directories.has(folded)) fail('INVALID_PATH', 'A workspace path cannot be both an output file and a directory');
    }
    for (const ancestor of writeAncestors) {
      this.#withExternalDirectory(root, ancestor, { rootIdentity }, (_fd, check) => {
        fs.accessSync(ancestor, fs.constants.W_OK | fs.constants.X_OK);
        check();
      });
    }
    return { planned, published, directories, rootIdentity };
  }

  #publishExternalOutput(root, dest, bytes, temp, pending, { rootIdentity, onCreate, assertCheckpoint, savePublication, output }) {
    this.#withExternalDirectory(root, dirname(dest), { rootIdentity }, (dirFd, check) => {
      const name = basename(dest);
      const anchor = `${fdPath(dirFd)}/${name}`;
      const checkName = () => {
        check();
        if (this.#externalEntryName(dirFd, name) !== name) workspaceOccupied();
      };
      let fd;
      try {
        if (!pending) {
          const linked = this.transaction(() => {
            assertCheckpoint();
            checkName();
            try {
              fs.linkSync(temp, anchor);
            } catch (error) {
              if (error.code === 'EEXIST') workspaceOccupied();
              if (error.code !== 'EXDEV') throw error;
              checkName();
              try { fd = fs.openSync(anchor, CREATE_EXCLUSIVE, 0o600); }
              catch (error) { if (error.code === 'EEXIST') workspaceOccupied(); throw error; }
              onCreate();
              const stat = fs.fstatSync(fd, { bigint: true });
              savePublication(pending = { ...output, dev: String(stat.dev), ino: String(stat.ino), complete: false });
              fs.fsyncSync(dirFd);
              return false;
            }
            onCreate();
            checkName();
            if (!sameInode(fs.lstatSync(anchor, { bigint: true, throwIfNoEntry: false }), fs.lstatSync(temp, { bigint: true }))) {
              workspaceOccupied();
            }
            fs.fsyncSync(dirFd);
            savePublication(output.relPath);
            return true;
          });
          if (linked) return;
        }
        // The reservation is durable before bytes are written. A second writer
        // must pass the same SQLite checkpoint and verify the same inode/prefix.
        this.transaction(() => {
          assertCheckpoint();
          checkName();
          const resuming = fd === undefined;
          if (resuming) {
            try { fd = fs.openSync(anchor, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
            catch (error) {
              if (['ENOENT', 'ELOOP', 'EISDIR', 'ENOTDIR', 'ENXIO', 'EACCES', 'EPERM'].includes(error.code)) workspaceOccupied();
              throw error;
            }
          }
          const stat = fs.fstatSync(fd, { bigint: true });
          if (!stat.isFile() || String(stat.dev) !== pending.dev || String(stat.ino) !== pending.ino
            || (resuming ? !workspaceBytesMatch(fd, stat, bytes, true) : stat.size !== 0n)) workspaceOccupied();
          const verifyFile = () => {
            checkName();
            if (!sameInode(fs.lstatSync(anchor, { bigint: true, throwIfNoEntry: false }), stat)) workspaceOccupied();
          };
          verifyFile();
          if (resuming) fs.ftruncateSync(fd, 0);
          fs.writeFileSync(fd, bytes);
          fs.fsyncSync(fd);
          verifyFile();
          const writtenFd = fd;
          fd = undefined;
          fs.closeSync(writtenFd);
          savePublication({ ...pending, complete: true });
        });
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    });
  }

  #materializeExternal(id, root, newlyCreatedJournalToken) {
    let planned, published, temps, checkpoint, rootIdentity;
    let createdJournalInThisCall = false;
    let createdDirsInTarget = 0;
    let createdOutputInTarget = false;
    const journal = () => this.one('SELECT * FROM creation_materialization_journal WHERE creation_id=?', id);
    const save = () => {
      const next = { target_dir: root, temp_files_json: json(temps), planned_outputs_json: this.#journalPlanJson(planned, rootIdentity),
        published_outputs_json: json(published), updated_at: Math.max(Date.now(), (checkpoint?.updated_at ?? 0) + 1) };
      this.run(`INSERT INTO creation_materialization_journal VALUES (?,?,?,?,?,?)
        ON CONFLICT(creation_id) DO UPDATE SET target_dir=excluded.target_dir, temp_files_json=excluded.temp_files_json,
          planned_outputs_json=excluded.planned_outputs_json, published_outputs_json=excluded.published_outputs_json,
          updated_at=excluded.updated_at`, id, ...Object.values(next));
      this.tx.afterCommit.push(() => { checkpoint = next; });
    };
    const matchesCheckpoint = (current, expected = checkpoint) => current && expected
      && Object.keys(expected).every(key => current[key] === expected[key]);
    const assertCheckpoint = () => {
      if (!matchesCheckpoint(journal())) {
        fail('CONFLICT', 'Workspace materialization changed during setup; retry');
      }
    };
    const stagingDir = this.#stagingDir(id);
    const removeTemps = () => {
      this.#cleanupJournalTemps(stagingDir, temps);
      temps = [];
    };
    try {
      const early = this.transaction(() => {
        const record = data(this.#creation(id));
        if (record.rootDir && this.#recordedWorkspace(id, record, { allowMissing: true })) {
          return { creation: this.getCreation(id), rootDir: record.rootDir, materialized: false };
        }
        const previous = journal();
        if (previous?.target_dir === root && newlyCreatedJournalToken) {
          createdJournalInThisCall = matchesCheckpoint(previous, newlyCreatedJournalToken);
        }
        const { root_dev: dev, root_ino: ino, ...outputs } = JSON.parse(previous?.planned_outputs_json ?? '{}');
        planned = outputs;
        published = JSON.parse(previous?.published_outputs_json ?? '{}');
        temps = JSON.parse(previous?.temp_files_json ?? '[]');
        checkpoint = previous;
        this.#linkableRootFolder(root);
        if (previous && previous.target_dir !== root) fail('CONFLICT', 'Resume materialization in the original target folder');
        const pendingIdentity = record.pendingBindTarget === root ? record.pendingBindIdentity : undefined;
        if (previous) {
          // Pre-identity journals cannot prove the path still names the original folder.
          if (typeof dev !== 'string' || typeof ino !== 'string') fail('CONFLICT', 'Materialization journal has no verified root identity');
          rootIdentity = { dev, ino };
          if (pendingIdentity && !matchesRootIdentity(rootIdentity, pendingIdentity)) {
            fail('CONFLICT', 'Materialization journal does not match the pending folder identity');
          }
          this.#withExternalDirectory(root, root, { rootIdentity }, () => {});
          this.#reconcileWorkspacePublications(root, stagingDir, planned, published, temps, rootIdentity);
        } else {
          ({ rootIdentity } = this.#planAndPreflightExternalFolder(id, root, record, planned, published, pendingIdentity));
          createdJournalInThisCall = true;
        }
        save(); // Commit the initial plan or inferred publications before touching the filesystem.
      });
      if (early) return early;

      this.transaction(() => {
        assertCheckpoint();
        removeTemps();
        save();
      });

      const { record, directories } = this.transaction(() => {
        assertCheckpoint();
        const record = data(this.#creation(id));
        const { directories } = this.#planAndPreflightExternalFolder(id, root, record, planned, published, rootIdentity);
        for (const dir of directories.values()) {
          this.#withExternalDirectory(root, dir, { rootIdentity, onCreate: () => { createdDirsInTarget++; } }, () => {});
        }
        save(); // All planned paths are durable before any temporary file is opened.
        return { record, directories };
      });
      this.#visitExternalOutputs(id, root, record, (key, _dir, _name, content) => {
        const publication = published[key];
        const pending = isIncompletePublication(publication) ? publication : undefined;
        if (own(published, key) && !pending) {
          const path = this.#journalPath(root, publicationPath(publication));
          if (!this.#inspectExternalOutput(root, path, undefined, { rootIdentity }).entry) workspaceOccupied();
          return path;
        }
        const bytes = Buffer.from(content);
        const output = planned[key];
        if (!output || output.sha256 !== workspaceDigest(bytes)) workspaceOccupied();
        const dest = this.#journalPath(root, output.relPath);
        const publish = temp => this.#publishExternalOutput(root, dest, bytes, temp, pending, {
          rootIdentity, onCreate: () => { createdOutputInTarget = true; },
          assertCheckpoint, output, savePublication: entry => { published[key] = entry; save(); },
        });
        if (pending) {
          publish();
          return dest;
        }
        const temp = join(stagingDir, `.creation-tmp-${randomUUID()}`);
        let fd, tempEntry;
        try {
          this.transaction(() => {
            assertCheckpoint();
            const { entry, matches } = this.#inspectExternalOutput(root, dest, bytes, { rootIdentity });
            if (entry && !matches) workspaceOccupied();
            if (!entry) {
              this.#directory(stagingDir);
              fd = fs.openSync(temp, CREATE_EXCLUSIVE, 0o600);
              const { dev, ino } = fs.fstatSync(fd, { bigint: true });
              tempEntry = { path: temp, dev: String(dev), ino: String(ino), relPath: output.relPath };
              temps.push(tempEntry);
            } else {
              published[key] = { relPath: output.relPath, adopted: true };
            }
            save(); // Commit the temp identity before writing or publishing bytes.
          });
          if (tempEntry) this.transaction(() => {
            assertCheckpoint();
            assertWorkspaceDescriptor(fd, temp);
            fs.writeFileSync(fd, bytes);
            fs.fsyncSync(fd);
            if (!this.#isRecordedStagingTemp(stagingDir, tempEntry)) workspaceOccupied();
            syncWorkspaceDirectory(stagingDir);
          });
          if (tempEntry) publish(temp); // Keep the temp link until publication is committed in SQLite.
        } finally { if (fd !== undefined) fs.closeSync(fd); }
        this.transaction(() => {
          assertCheckpoint();
          removeTemps();
          save();
        });
        return dest;
      }, path => directories.get(relative(root, path).toLowerCase()));
      // The directory helper releases its descriptor only after this transaction commits.
      return this.#withExternalDirectory(root, root, { rootIdentity }, (_fd, check) => this.transaction(() => {
        assertCheckpoint();
        const current = data(this.#creation(id));
        if (current.rootDir !== record.rootDir) fail('CONFLICT', 'Creation folder changed during materialization');
        if (Object.values(published).some(isIncompletePublication)) {
          fail('CONFLICT', 'Incomplete external materialization output remains unresolved');
        }
        current.rootDir = root;
        current.boundRootIdentity = rootIdentity;
        delete current.pendingBindTarget;
        delete current.pendingBindIdentity;
        delete current.ownsWorkspace;
        delete current.workspaceIdentity;
        this.run('UPDATE creations SET updated_at=?,data=? WHERE id=?', now(), json(current), id);
        this.run('DELETE FROM creation_materialization_journal WHERE creation_id=?', id);
        const creation = this.getCreation(id);
        check();
        return { creation, rootDir: root, materialized: true };
      }));
    } catch (error) {
      if (createdJournalInThisCall && checkpoint && createdDirsInTarget === 0 && !createdOutputInTarget
        && Object.values(published).every(output => output?.adopted === true)) {
        try {
          this.transaction(() => {
            // Never retire a checkpoint another call has advanced.
            if (!matchesCheckpoint(journal())) return;
            this.run('DELETE FROM creation_materialization_journal WHERE creation_id=?', id);
            this.tx.afterCommit.push(() => this.#cleanupJournalTemps(stagingDir, temps));
          });
        } catch (cleanupError) {
          console.warn('[CreationStore] untouched journal cleanup failed:', cleanupError?.message || cleanupError);
        }
      }
      throw error;
    }
  }

  ensureWorkspace(id, { rootDir, newlyCreatedJournalToken } = {}) {
    const record = data(this.#creation(id));
    if (record.rootDir && this.#recordedWorkspace(id, record, { allowMissing: true })) {
      return { creation: this.getCreation(id), rootDir: record.rootDir, materialized: false };
    }
    if (rootDir != null) {
      if (this.tx) fail('INVALID_STATE', 'External materialization cannot run inside another transaction');
      return this.#materializeExternal(id, folderPath(rootDir), newlyCreatedJournalToken);
    }
    return this.transaction(() => {
      const current = data(this.#creation(id));
      if (current.rootDir && this.#recordedWorkspace(id, current, { allowMissing: true })) {
        return { creation: this.getCreation(id), rootDir: current.rootDir, materialized: false };
      }
      if (this.one('SELECT creation_id FROM creation_materialization_journal WHERE creation_id=?', id)) {
        fail('CONFLICT', 'Resume materialization in the original target folder');
      }
      this.#initializeWorkspace(current, { materialize: true });
      this.run('UPDATE creations SET updated_at=?,data=? WHERE id=?', now(), json(current), id);
      return { creation: this.getCreation(id), rootDir: current.rootDir, materialized: true };
    });
  }
  findByFolder(rootDir) {
    const canonical = this.#rootFolder(rootDir, { allowMissing: true });
    const row = this.one(`SELECT c.* FROM creations c
      LEFT JOIN creation_materialization_journal j ON j.creation_id=c.id
      WHERE json_extract(c.data,'$.rootDir')=? OR (json_extract(c.data,'$.rootDir') IS NULL AND
        (j.target_dir=? OR (j.target_dir IS NULL AND json_extract(c.data,'$.pendingBindTarget')=?)))
      ORDER BY (json_extract(c.data,'$.rootDir') IS ?) DESC,(j.target_dir IS NOT NULL) DESC,c.updated_at DESC,c.id LIMIT 1`,
      canonical, canonical, canonical, canonical);
    return { creation: row ? this.#summary(row) : null };
  }

  listSources(id) { return this.all('SELECT data FROM creation_sources WHERE creation_id=? ORDER BY rowid', safeId(id)).map(data); }
  addSources(id, { files = [], textSources = [] }, { copyToWorkspace = false, validateWorkspaceNames = false } = {}) {
    const row = this.#creation(id);
    const creation = copyToWorkspace ? data(row) : null;
    const rootDir = creation?.rootDir == null ? null : this.#recordedWorkspace(id, creation);
    const incoming = [...boundedList(files, LIMITS.sources, 'files').map(file => ({ file })),
      ...boundedList(textSources, LIMITS.sources, 'text sources').map(item => ({ item }))];
    return this.transaction(() => {
      if (incoming.length + this.listSources(id).length > LIMITS.sources) fail('LIMIT_EXCEEDED', 'Too many sources');
      let total = 0;
      const results = incoming.map(({ file, item }) => {
        if ((file !== undefined && (!file || typeof file !== 'object')) || (file === undefined && item == null)) fail('INVALID_REQUEST', 'Invalid source');
        const sourceId = randomUUID();
        const name = title(file?.name ?? file?.filename ?? item?.name ?? item?.title ?? 'Notes.txt');
        if (validateWorkspaceNames && this.#unsafeSourceName(name)) fail('INVALID_REQUEST', 'Invalid workspace source filename');
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
          sha256: createHash('sha256').update(bytes).digest('hex'),
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
      const path = this.#path(id, 'sources', sourceId);
      this.tx.afterCommit.push(() => this.#remove(path));
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
        const path = this.#path(id, 'artifacts', target);
        this.tx.afterCommit.push(() => this.#remove(path));
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

  #assetPath(id, record, options) { return this.#path(id, 'assets', this.#assetFilename(record, options)); }

  #assetFilename(record, { legacy = false } = {}) {
    if (!own(ASSET_TYPES, record.ext) && !(legacy && typeof record.ext === 'string' && /^[a-z0-9]{1,12}$/i.test(record.ext))) {
      fail('INVALID_PATH', 'Invalid stored asset type');
    }
    const assetId = safeId(record.id);
    if (record.file == null) return `${safeId(record.fileId ?? assetId)}.${record.ext}`;
    const file = `${assetId}.${safeId(record.version)}.${record.ext}`;
    if (record.file !== file) fail('INVALID_PATH', 'Invalid stored asset filename');
    return file;
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
