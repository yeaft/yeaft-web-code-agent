import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { basename, extname, relative, resolve, sep } from 'node:path';
import { fail, object, page, PersonError, text } from './contracts.js';

export const OUTPUT_LIMITS = Object.freeze({ fileBytes: 10 * 1024 * 1024, personBytes: 100 * 1024 * 1024, personCount: 200, readBytes: 65536 });
const BINARY = 'application/octet-stream';
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function outputArgs(args) {
  object(args, ['file_path', 'url', 'title'], []);
  if (Object.hasOwn(args, 'file_path') === Object.hasOwn(args, 'url')) fail('INVALID_REQUEST');
  if (Object.hasOwn(args, 'title')) text(args.title, 240);
  if (Object.hasOwn(args, 'file_path')) text(args.file_path, 4096);
  else outputUrl(args.url);
  return args;
}
export function outputUrl(value) {
  text(value, 4096);
  // WHATWG parsing silently trims controls and tolerates ambiguous backslashes.
  if (!/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f\\]/u.test(value)) fail('INVALID_REQUEST');
  let url; try { url = new URL(value); } catch { fail('INVALID_REQUEST'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /^https?:\/\/[^/?#]*@/i.test(value)) fail('INVALID_REQUEST');
  return url.href; // Metadata only. Never fetched by the Agent or Server.
}
export function outputsPage(payload = {}) {
  if (Object.hasOwn(payload ?? {}, 'limit') && payload.limit == null) fail('INVALID_REQUEST');
  return page(payload);
}
export function outputReadRequest(payload = {}) {
  object(payload, ['outputId', 'offset', 'maxBytes'], ['outputId']);
  if (typeof payload.outputId !== 'string' || !ID.test(payload.outputId)) fail('INVALID_REQUEST');
  const offset = payload.offset === undefined ? 0 : payload.offset;
  const maxBytes = payload.maxBytes === undefined ? OUTPUT_LIMITS.readBytes : payload.maxBytes;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > OUTPUT_LIMITS.readBytes) fail('INVALID_REQUEST');
  return { outputId: payload.outputId, offset, maxBytes };
}
export function outputView(record) {
  return { id: record.id, title: record.title, kind: record.kind, mimeType: record.mimeType, size: record.size,
    episodeId: record.episodeId, createdAt: record.createdAt, ...(record.kind === 'link' ? { url: record.url } : {}) };
}

/** Renderer selection is byte-checked and conservative. SVG and unknown/binary
 * formats are downloads only. Signatures are not a full decoder or malware scan. */
export function outputMime(name, data) {
  const ext = extname(name).toLowerCase();
  const magic = hex => data.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  if (ext === '.png') return magic('89504e470d0a1a0a') ? 'image/png' : BINARY;
  if (['.jpg', '.jpeg', '.jfif'].includes(ext)) return magic('ffd8ff') ? 'image/jpeg' : BINARY;
  if (ext === '.gif') return ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii')) ? 'image/gif' : BINARY;
  if (ext === '.webp') return data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : BINARY;
  if (ext === '.pdf') return data.subarray(0, 5).toString('ascii') === '%PDF-' ? 'application/pdf' : BINARY;
  if (ext === '.svg') return BINARY;
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return BINARY; }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content)) return BINARY;
  if (['.html', '.htm'].includes(ext)) return 'text/html'; // UI must use script/network-blocked sandbox.
  if (['.md', '.markdown'].includes(ext)) return 'text/markdown';
  if (ext === '.json') { try { JSON.parse(content); return 'application/json'; } catch { return 'text/plain'; } }
  return 'text/plain'; // Code/plain UTF-8 is never executed, regardless of extension.
}

/** Deliberately Linux-only until another platform has a verified race-safe
 * descriptor-relative implementation. Link publication / durable reads are portable. */
export function outputFilePublicationSupport() {
  const unavailable = { supported: false, reason: 'File publication requires Linux with accessible procfs and no-follow directory descriptors; links and existing snapshots remain available.' };
  if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) return unavailable;
  let root, probe;
  try {
    root = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    probe = openSync(`/proc/self/fd/${root}/.`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!fstatSync(probe).isDirectory() || realpathSync(`/proc/self/fd/${probe}`) !== '/') return unavailable;
    return { supported: true, reason: null };
  } catch { return unavailable; }
  finally { for (const fd of [probe, root]) if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort close */ } } }
}

// A filesystem basename can legally exceed our public title limit. Keep a valid
// UTF-8 prefix (and short extension) rather than rejecting an otherwise valid file.
function defaultTitle(value) {
  value = value.trim() || 'Output';
  if (Buffer.byteLength(value) <= 240) return value;
  const ext = extname(value), suffix = `…${Buffer.byteLength(ext) <= 32 ? ext : ''}`;
  let prefix = '';
  for (const char of value) {
    if (Buffer.byteLength(prefix + char + suffix) > 240) break;
    prefix += char;
  }
  return prefix + suffix;
}

/** Read through pinned directory descriptors: each component is O_NOFOLLOW.
 * Resolving then opening the full path would leave an ancestor-symlink race.
 * Linux procfs provides openat-like anchoring without native dependencies.
 * Missing platform support, fd filesystem or O_NOFOLLOW fails closed. */
export function snapshotOutput(workDir, filePath) {
  const descriptors = [];
  try {
    if (!outputFilePublicationSupport().supported) fail('OUTPUT_PLATFORM');
    const root = realpathSync(resolve(workDir ?? process.cwd()));
    const requested = resolve(root, filePath), rel = relative(root, requested);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== requested) fail('OUTPUT_PATH');
    const fdRoot = '/proc/self/fd';
    let parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptors.push(parent);
    // Revalidate the root descriptor, so a swapped canonical root is not trusted.
    if (realpathSync(`${fdRoot}/${parent}`) !== root) fail('OUTPUT_PATH');
    const parts = rel.split(sep);
    for (const component of parts.slice(0, -1)) {
      parent = openSync(`${fdRoot}/${parent}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      descriptors.push(parent);
    }
    // NONBLOCK prevents a malicious FIFO/device path from hanging before fstat.
    const fd = openSync(`${fdRoot}/${parent}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    descriptors.push(fd);
    const stat = fstatSync(fd);
    if (!stat.isFile()) fail('OUTPUT_PATH');
    const opened = realpathSync(`${fdRoot}/${fd}`), openedRel = relative(root, opened);
    if (!openedRel || openedRel === '..' || openedRel.startsWith(`..${sep}`) || opened !== requested) fail('OUTPUT_PATH');
    if (stat.size > OUTPUT_LIMITS.fileBytes) fail('OUTPUT_QUOTA');
    // Read at most the limit + 1, even if another process grows the original.
    const data = Buffer.alloc(stat.size + 1); let size = 0;
    while (size < data.length) { const n = readSync(fd, data, size, data.length - size, size); if (!n) break; size += n; }
    const after = fstatSync(fd);
    if (after.size > OUTPUT_LIMITS.fileBytes || size > OUTPUT_LIMITS.fileBytes) fail('OUTPUT_QUOTA');
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail('OUTPUT_PATH');
    return { data: data.subarray(0, size), name: basename(requested) };
  } catch (error) {
    if (error instanceof PersonError) throw error;
    fail('OUTPUT_PATH'); // Never leak a filesystem error or raw path.
  } finally { for (const fd of descriptors.reverse()) { try { closeSync(fd); } catch { /* best effort close */ } } }
}

export async function publishOutput(repository, episode, workDir, args, { signal, callId } = {}) {
  outputArgs(args);
  if (!episode || !callId) fail('UNSUPPORTED');
  // Read permission is derived from the started current Person invocation, not
  // from browser arguments or a child/Session tool registry.
  await repository.checkOutputPublication(episode, { callId, args });
  signal?.throwIfAborted();
  let record, data = null;
  if (Object.hasOwn(args, 'file_path')) {
    const snapshot = snapshotOutput(workDir, args.file_path); data = snapshot.data;
    record = { kind: 'file', title: args.title?.trim() ?? defaultTitle(snapshot.name), mimeType: outputMime(snapshot.name, data), size: data.length };
  } else {
    const url = outputUrl(args.url);
    record = { kind: 'link', title: args.title?.trim() ?? defaultTitle(new URL(url).hostname), mimeType: null, size: 0, url };
  }
  text(record.title, 240);
  signal?.throwIfAborted();
  // SQLite checks the invocation/fence again in the same transaction as insert.
  // Once committed this is an honest durable side effect, even after cancellation.
  return repository.saveOutput(episode, { callId, args, record, data });
}
