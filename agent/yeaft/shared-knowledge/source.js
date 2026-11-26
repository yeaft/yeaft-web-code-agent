import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { isVisibleConversationRow } from '../conversation/internal-control.js';
import { parseMessage, parseSeqFromId } from '../conversation/persist.js';
import { createAgentHistoryScan, isAgentHistorySessionId } from '../conversation/search.js';
import { sessionDeletionProjection } from '../conversation/turn-deletion-journal.js';
import { classifyAssistantResponseKind, extractIndexableTurnMessages, extractPlainText, rowTimestamp } from '../session-discovery/indexer.js';
import { localSessionDirs, readSourceFence } from '../session-discovery/store.js';
import { screenKnowledgeText } from './prompts.js';
import { validatePendingSeqs } from './store.js';

const isSeq = value => Number.isSafeInteger(value) && value >= 0;
const stat = path => lstatSync(path, { throwIfNoEntry: false });
// NTFS can update ctime when a read updates access metadata.
const changeTime = st => process.platform === 'win32' ? st.mtimeMs : st.ctimeMs;
const stamp = st => st && [st.dev, st.ino, st.size, st.mtimeMs, changeTime(st)].join(':');

function canFinalizeInPlace(row) {
  return row.incomplete !== true && !row.toolCalls?.length && (
    row.stopReason === 'end_turn' || row.stopReason === 'stop_sequence' || row.stopReason == null || row.stopReason === '');
}

function digestScan(root, signal) {
  const telemetry = {};
  // Per-Session I/O budget for the dedicated background worker. Keep the
  // existing 8 MiB per-file safety bound and retain only small text projections.
  const scan = createAgentHistoryScan(root, telemetry, signal, { maxScanBytes: 256 * 1024 * 1024 });
  const check = () => {
    signal?.throwIfAborted();
    if (telemetry.scanIncomplete) throw new Error('Incomplete digest source scan');
  };
  return {
    check,
    read(path) { const value = scan.read(path); check(); return value; },
    list(path, suffix) { const value = scan.list(path, suffix); check(); return value; },
  };
}

/** Local manifest IDs only; the per-Session loader decides eligibility. */
export function listDigestSessions(root, { signal } = {}) {
  const scan = digestScan(root, signal);
  scan.check();
  const ids = [...localSessionDirs(root, scan.read, null, { strict: true }).keys()];
  scan.check();
  return ids;
}

function segmentBounds(raw, streamId) {
  // The index is a cache, not the commit point. Never use metadata from a
  // different stream or an unknown schema. Unusable metadata means a full read.
  if (!raw || !streamId) return new Map();
  try {
    const index = JSON.parse(raw);
    if (index.version !== 2 || index.streamId !== streamId || !Array.isArray(index.segments)) return new Map();
    const bounds = new Map();
    for (const entry of index.segments) {
      if (!/^\d+\.jsonl$/u.test(entry?.file) || bounds.has(entry.file)
        || !isSeq(entry.firstSeq) || !isSeq(entry.lastSeq) || entry.lastSeq < entry.firstSeq
        || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !Number.isSafeInteger(entry.count) || entry.count <= 0) return new Map();
      bounds.set(entry.file, entry);
    }
    return bounds;
  } catch { return new Map(); }
}

/**
 * Read one manifest-owned transcript without opening or repairing the live store.
 * Bounds are epoch milliseconds (inclusive). An empty result keeps a recognized
 * cursor, or returns -1 if no indexable row has been supplied in this lineage.
 * Messages may include finalized rows at or below the cursor. pendingSeqs is
 * the unresolved set after processing all returned messages.
 */
export function readDigestSource(root, sessionId, { watermark = null, bootstrapSince, cutoff, signal } = {}) {
  const scan = digestScan(root, signal);
  scan.check();
  if (!isAgentHistorySessionId(sessionId)) return null;
  if (!Number.isFinite(bootstrapSince) || !Number.isFinite(cutoff)) throw new TypeError('Digest time bounds must be epoch milliseconds');

  const allowed = new Set([sessionId]);
  const getDir = () => {
    const entries = new Map();
    const dir = localSessionDirs(root, scan.read, allowed, { strict: true, entries }).get(sessionId);
    return { dir, entry: entries.get(sessionId) };
  };
  const { dir, entry } = getDir();
  if (!dir) return null;
  const conversation = join(dir, 'conversation');
  // Track file identity and directory entries as well as the logical fence:
  // cache/index publication is allowed to lag a committed segment append.
  const snapshot = new Map();
  const watch = path => {
    const value = stat(path);
    snapshot.set(path, stamp(value));
    return value;
  };
  watch(dir);
  watch(conversation);
  const getFence = () => readSourceFence(root, sessionId, scan.read, { allowEmptyConversation: true });
  const source = getFence();
  if (!source || typeof source.meta.createdAt !== 'string' || !source.meta.createdAt) throw new Error('Invalid digest source fence');
  if (entry.createdAt !== source.meta.createdAt) throw new Error('Digest source does not match Session manifest');
  if (source.meta.task || source.meta.archived || source.meta.archivedAt) return null;

  const recognized = watermark?.identity === source.identity;
  const previous = recognized ? watermark.lastSeq : -1;
  if (previous !== -1 && !isSeq(previous)) throw new TypeError('Invalid digest watermark');
  const oldPending = new Set(recognized ? validatePendingSeqs(watermark.pendingSeqs === undefined ? [] : watermark.pendingSeqs) : []);
  const pendingBelowCursor = [...oldPending].filter(seq => seq <= previous).sort((a, b) => a - b);
  const pendingIntersects = ({ firstSeq, lastSeq }) => {
    let lo = 0, hi = pendingBelowCursor.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pendingBelowCursor[mid] < firstSeq) lo = mid + 1;
      else hi = mid;
    }
    return lo < pendingBelowCursor.length && pendingBelowCursor[lo] <= lastSeq;
  };
  const indexPath = join(conversation, 'index.json');
  const indexStat = watch(indexPath);
  const bounds = previous >= 0 && indexStat ? segmentBounds(scan.read(indexPath), source.streamId) : new Map();
  const { scrub } = sessionDeletionProjection(source.operations);
  const bySeq = new Map();
  function add(row, path) {
    const seq = parseSeqFromId(row?.id);
    // Older imports can retain a stale numeric `seq` after rewriting the
    // canonical mNNNN ID. IDs agree with the writer's segment bounds and are
    // also the stable source references. Current origin-stamped rows must agree.
    if (!row || !isSeq(seq) || (row.origin != null && row.seq != null && row.seq !== seq)
      || row.sessionId !== sessionId || typeof row.role !== 'string') throw new Error(`Invalid digest transcript row: ${path}`);
    if (seq <= previous && !oldPending.has(seq)) return;
    // Copy/merge rewrites the outer sessionId but preserves the origin. The
    // target's deletion journal cannot authorize another Session/stream's rows.
    const local = row.origin == null || (row.origin.sessionId === sessionId && row.origin.streamId === source.streamId);
    const kept = local && ['user', 'assistant'].includes(row.role) && isVisibleConversationRow(row) ? scrub(row) : null;
    if (!kept) {
      bySeq.delete(seq); // An excluded canonical row must not expose a legacy duplicate.
      return;
    }
    // Keep the fields used by the visible-text projection, not full provider
    // output, attachments, tool data or base64 blocks from a large transcript.
    const text = screenKnowledgeText(extractPlainText(kept.content));
    const kind = kept.role === 'assistant' ? classifyAssistantResponseKind(kept) : null;
    bySeq.set(seq, {
      id: kept.id, sessionId, seq, role: kept.role, ts: rowTimestamp(kept),
      content: text.length <= 64 * 1024 ? text : `${text.slice(0, 48 * 1024)}\n[… omitted …]\n${text.slice(-16 * 1024 + 24)}`,
      responseKind: kind, turnId: kept.turnId, from: kept.from,
      potentiallyFinal: kind === 'progress' && canFinalizeInPlace(kept),
      speakerVpId: kept.speakerVpId || kept.meta?.senderVpId,
    });
  }
  function readFile(path, fileStat) {
    if (!fileStat?.isFile()) throw new Error(`Missing digest transcript file: ${path}`);
    const raw = scan.read(path);
    if (typeof raw !== 'string' || Buffer.byteLength(raw) !== fileStat.size) throw new Error(`Incomplete digest transcript file: ${path}`);
    return raw;
  }

  // Canonical segments take precedence over legacy markdown at the same seq.
  for (const kind of ['cold', 'messages', 'segments']) {
    const dirPath = join(conversation, kind);
    watch(dirPath);
    const segments = kind === 'segments';
    const pattern = segments ? /^\d+\.jsonl$/u : /^m\d+\.md$/u;
    for (const file of scan.list(dirPath, segments ? '.jsonl' : '.md').filter(file => pattern.test(file)).sort()) {
      const path = join(dirPath, file);
      const fileStat = watch(path);
      if (segments) {
        const bound = bounds.get(file);
        if (bound && fileStat?.isFile() && bound.lastSeq <= previous && !pendingIntersects(bound) && bound.bytes === fileStat.size
          && indexStat?.isFile() && fileStat.mtimeMs <= indexStat.mtimeMs && changeTime(fileStat) <= indexStat.mtimeMs) continue;
        const raw = readFile(path, fileStat);
        // Writers commit newline-terminated JSONL records, including the last.
        if (raw && !raw.endsWith('\n')) throw new Error(`Incomplete digest segment: ${path}`);
        for (const line of raw.split('\n')) {
          if (!line) continue;
          let row;
          try { row = JSON.parse(line); } catch { throw new Error(`Invalid JSON in digest segment: ${path}`); }
          add(row, path);
        }
      } else {
        const id = file.slice(0, -3);
        const seq = parseSeqFromId(id);
        if (seq <= previous && !oldPending.has(seq)) continue;
        const row = parseMessage(readFile(path, fileStat));
        if (row?.id !== id) throw new Error(`Invalid legacy digest message: ${path}`);
        add({ ...row, sessionId: row.sessionId ?? sessionId }, path);
      }
    }
  }

  const prefix = [];
  const replay = [];
  const pendingSeqs = [];
  for (const row of [...bySeq.values()].sort((a, b) => a.seq - b.seq)) {
    const indexableNow = row.responseKind !== 'progress' && isVisibleConversationRow(row) && extractPlainText(row.content);
    if (indexableNow || row.potentiallyFinal) {
      const time = rowTimestamp(row);
      if (!Number.isFinite(time)) throw new Error('Invalid digest message timestamp');
      if (time > cutoff) {
        // Do not cross a future potentially-final progress row with the
        // forward cursor: it cannot enter the pending set before its cutoff.
        if (row.seq > previous) break;
        continue;
      }
      if (row.potentiallyFinal && time >= bootstrapSince) pendingSeqs.push(row.seq);
      if (row.seq <= previous && indexableNow && time >= bootstrapSince) {
        // An old hole that has become final is independent of forward turn
        // coalescing, which could otherwise hide it behind a newer result.
        replay.push(...extractIndexableTurnMessages([row], sessionId, cutoff).messages);
      }
    }
    if (row.seq > previous) prefix.push(row);
  }
  validatePendingSeqs(pendingSeqs);
  const { messages: projected } = extractIndexableTurnMessages(prefix, sessionId, cutoff);
  // A sequence checkpoint does not establish time eligibility: later seqs can
  // have older timestamps. Keep the original bootstrap floor on every scan.
  const messages = [...replay, ...projected.filter(message => message.createdAt >= bootstrapSince)];
  const after = getFence();
  const current = getDir();
  if (after?.key !== source.key || after.meta.workDir !== source.meta.workDir || after.meta.task
    || after.meta.archived || after.meta.archivedAt || current.dir !== dir || current.entry?.createdAt !== entry.createdAt) {
    throw new Error('Digest source changed during scan');
  }
  for (const [path, before] of snapshot) {
    const afterStamp = stamp(stat(path));
    if (afterStamp !== before) throw new Error(`Digest transcript changed during scan: ${path} (${before} → ${afterStamp})`);
  }
  scan.check();
  return {
    sessionId,
    generation: source.key,
    identity: source.identity,
    workDir: typeof source.meta.workDir === 'string' ? source.meta.workDir : '',
    messages,
    // A verified older prefix was intentionally excluded by the cold-start
    // policy. Checkpoint it so inactive Sessions needn't rescan it every day.
    lastSeq: Math.max(previous, projected.at(-1)?.seq ?? -1),
    pendingSeqs,
  };
}
