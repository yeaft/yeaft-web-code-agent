import { join } from 'node:path';
import { createAgentHistoryScan } from '../conversation/search.js';
import { parseMessage, parseSeqFromId } from '../conversation/persist.js';
import { sessionDeletionProjection } from '../conversation/turn-deletion-journal.js';
import { iterateCanonicalVisibleEntriesNewestFirst } from '../conversation/visible-entry.js';
import { ACTIVE_WINDOW_MS, DAY_MS, discoveryIndexedAt, localSessionDirs, openDiscoveryStore, replaceDailyIndex, readSourceFence, expireDailyIndex } from './store.js';

// Only explicit user decisions or standing preferences become proposals.
// Assistant progress or a one-off instruction is not user consensus.
const durablePrefix = /^(?:(?:我们)?(?:已达成共识|达成共识|已确认|已决定|决定|长期约定|我的长期偏好)\s*[:：]|(?:从今往后|今后默认|以后默认|今后统一|以后统一)[，、,:：]?|(?:consensus|confirmed decision|standing agreement|standing preference)\s*:|(?:going forward|from now on|we agreed(?: that)?)\b[\s,:-]*)\s*/iu;
const nonPortable = /`|\b(?:https?:\/\/|(?:api|access|secret)[ _-]?key\b|password\b)|(?:密码|密钥|令牌)|(?:^|\s)(?:[~.]?[/\\]|\w:[/\\])|\b[\w.-]+\.(?:[cm]?[jt]sx?|py|go|rs|sh|tsx|json|ya?ml|toml|ini|css|html|sql|md)\b|[{}<>]|[?？]|\b(?:should we|what if|maybe|might|not yet)\b|(?:是否|要不要|可能|还没定|待确认)/iu;
const MAX_PASSAGES = 20;
const MAX_CARDS = 1500;
const truncate = (text, limit) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
const seq = row => parseSeqFromId(row?.id);

function extractConsensus(entry, text, createdAt) {
  if (entry.role !== 'user' || text.length > 500 || !entry.anchorMessageId) return null;
  const prefix = durablePrefix.exec(text);
  if (!prefix) return null;
  const body = text.slice(prefix[0].length).trim();
  if (body.length < 4 || nonPortable.test(body)) return null;
  const title = truncate(body.split(/[。！？.!?；;]/u)[0].trim() || body, 72);
  return { title, body, sourceMessageId: entry.anchorMessageId, createdAt };
}

// Scan the canonical instance transcript only. Don't open/repair the live
// SegmentStore from a worker, and never follow a transcript-supplied path.
function* transcriptRows(conversation, sessionId, read, list, operations) {
  const { scrub } = sessionDeletionProjection(operations);
  const segments = (list(join(conversation, 'segments'), '.jsonl') || []).filter(file => /^\d+\.jsonl$/u.test(file)).sort().reverse();
  const legacy = ['messages', 'cold'].flatMap(kind => {
    const dir = join(conversation, kind);
    return (list(dir, '.md') || []).filter(name => /^m\d+\.md$/u.test(name))
      .map(name => ({ path: join(dir, name), id: name.slice(0, -3) }));
  }).sort((a, b) => seq(b) - seq(a));
  let i = 0;
  const legacyRow = file => {
    const raw = read(file.path);
    const row = raw ? parseMessage(raw) : null;
    return row && row.id === file.id && (!row.sessionId || row.sessionId === sessionId)
      ? scrub({ ...row, sessionId }) : null;
  };
  for (const file of segments) {
    const raw = read(join(conversation, 'segments', file));
    if (!raw) continue;
    const rows = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (row?.sessionId === sessionId && Number.isFinite(seq(row))) rows.push(row);
      } catch { /* an incomplete trailing append may be read */ }
    }
    rows.sort((a, b) => seq(b) - seq(a));
    for (const row of rows) {
      while (i < legacy.length && seq(legacy[i]) > seq(row)) yield legacyRow(legacy[i++]);
      while (i < legacy.length && seq(legacy[i]) === seq(row)) i++;
      yield scrub(row);
    }
  }
  while (i < legacy.length) yield legacyRow(legacy[i++]);
}

export function runDailySessionIndex(root, now = Date.now()) {
  const db = openDiscoveryStore(root);
  try {
    expireDailyIndex(db, now);
    const indexedAt = discoveryIndexedAt(db);
    if (indexedAt !== null && now >= indexedAt && now - indexedAt < DAY_MS) return false;
    const cutoff = now - ACTIVE_WINDOW_MS;
    const cards = [];
    const { read, list, stopped } = createAgentHistoryScan(root, {});
    // Last-created first for very large inventories: spend the bounded scan
    // budget on active work before older, reopened conversations.
    const sessions = [...localSessionDirs(root, read)].reverse();
    for (const [sessionId, dir] of sessions) {
      if (stopped() || cards.length >= MAX_CARDS) break;
      try {
        const source = readSourceFence(root, sessionId, read);
        if (!source || (!source.freshAt || source.freshAt < cutoff)) continue;
        const meta = source.meta;
        let count = 0;
        let activeAt = 0;
        const messages = [];
        const candidates = [];
        const rows = transcriptRows(join(dir, 'conversation'), sessionId, read, list, source.operations);
        for (const entry of iterateCanonicalVisibleEntriesNewestFirst(rows, sessionId)) {
          const time = typeof entry.timestamp === 'number' ? entry.timestamp : Date.parse(entry.timestamp);
          count++;
          if (Number.isFinite(time) && time <= now) activeAt = Math.max(activeAt, time);
          if (time >= cutoff && time <= now) {
            const text = entry.textParts.slice(0, 4).map(part => part.slice(0, 1400)).join(' ').trim();
            if (text) messages.push({ role: entry.role, text: truncate(text, 1400) });
            const proposal = extractConsensus(entry, text, time);
            if (proposal) candidates.push(proposal);
          }
          if (count >= MAX_PASSAGES || (time < cutoff && count > 3)) break;
        }
        if (count <= 3 || activeAt < cutoff || readSourceFence(root, sessionId, read)?.key !== source.key) continue;
        cards.push({ sessionId, activeAt, deletionGeneration: source.key, messages, candidates,
          title: truncate(typeof meta.name === 'string' ? meta.name : sessionId, 240),
          workDir: truncate(typeof meta.workDir === 'string' ? meta.workDir : '', 512) });
      } catch (error) {
        // Missing/deleted or corrupt Sessions can't keep their stale cards.
        console.warn('[SessionDiscovery] skipping unreadable Session:', error.code || error.name);
      }
    }
    return replaceDailyIndex(db, cards, now);
  } finally { db.close(); }
}
