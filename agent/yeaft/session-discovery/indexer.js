import { join } from 'node:path';
import { createAgentHistoryScan } from '../conversation/search.js';
import { parseMessage, parseSeqFromId } from '../conversation/persist.js';
import { sessionDeletionProjection } from '../conversation/turn-deletion-journal.js';
import { iterateCanonicalVisibleEntriesNewestFirst } from '../conversation/visible-entry.js';
import { isVisibleConversationRow } from '../conversation/internal-control.js';
import { ACTIVE_WINDOW_MS, DAY_MS, discoveryIndexedAt, localSessionDirs, openDiscoveryStore, replaceDailyIndex, readSourceFence, expireDailyIndex } from './store.js';

// Keep the legacy review-only proposal extractor for the manual Share API.
const durablePrefix = /^(?:(?:我们)?(?:已达成共识|达成共识|已确认|已决定|决定|长期约定|我的长期偏好)\s*[:：]|(?:从今往后|今后默认|以后默认|今后统一|以后统一)[，、,:：]?|(?:consensus|confirmed decision|standing agreement|standing preference)\s*:|(?:going forward|from now on|we agreed(?: that)?)\b[\s,:-]*)\s*/iu;
const nonPortable = /`|\b(?:https?:\/\/|(?:api|access|secret)[ _-]?key\b|password\b)|(?:密码|密钥|令牌)|(?:^|\s)(?:[~.]?[/\\]|\w:[/\\])|\b[\w.-]+\.(?:[cm]?[jt]sx?|py|go|rs|sh|tsx|json|ya?ml|toml|ini|css|html|sql|md)\b|[{}<>]|[?？]|\b(?:should we|what if|maybe|might|not yet)\b|(?:是否|要不要|可能|还没定|待确认)/iu;
const standingPrefix = /^(?:(?:长期约定|长期决定|我的长期偏好)[ \t]*[:：]|(?:今后默认|以后默认)[，、,:：]?|(?:standing agreement|standing preference|durable decision)[ \t]*:)[ \t]*/iu;
const automaticExclusions = /[/\\]|\b\S+\.[a-z][a-z0-9]{0,11}\b|\b(?:bearer|credentials?|tokens?)\b|(?:本次|这次|当前(?:任务|仓库|项目))|\b(?:this (?:time|task|repo(?:sitory)?|project)|just once)\b/iu;
const MAX_PASSAGES = 20;
const MAX_NEW_AGREEMENTS = 2_000;
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

function extractStandingAgreement(row, source, cutoff, now) {
  if (row?.role !== 'user' || row.id.length > 32 || !isVisibleConversationRow(row)
      || (row.origin && (row.origin.sessionId !== row.sessionId || row.origin.streamId !== source.streamId))) return null;
  const timestamp = row.ts || row.time;
  const createdAt = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!Number.isSafeInteger(createdAt) || createdAt < cutoff || createdAt > now) return null;
  // Only short, standalone plain-text declarations, not quoted or attached material.
  const content = Array.isArray(row.content) && row.content.length === 1 && row.content[0]?.type === 'text'
    ? row.content[0].text : row.content;
  if (row.quote || row.attachments?.length || typeof content !== 'string' || content.length > 500) return null;
  const text = content.trim();
  if (/[\r\n\u2028\u2029]/u.test(text)) return null;
  const prefix = standingPrefix.exec(text);
  if (!prefix) return null;
  const body = text.slice(prefix[0].length).trim();
  if (body.length < 4 || nonPortable.test(body) || automaticExclusions.test(body)) return null;
  // Keep the IDs used by the canonical deletion projection, not the whole row.
  const ref = { id: row.id };
  for (const key of ['causalRootId', 'userTurnId', 'clientMessageId', 'turnId']) {
    if (row[key] == null) continue;
    if (typeof row[key] !== 'string' || row[key].length > 256) return null;
    ref[key] = row[key];
  }
  return { title: truncate(body.split(/[。！？.!?；;]/u)[0].trim() || body, 72), body, createdAt, ref };
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
    const automatic = [];
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
        const agreements = [];
        const rows = transcriptRows(join(dir, 'conversation'), sessionId, read, list, source.operations);
        // Inspect raw user rows before the visible projection normalizes
        // whitespace and flattens content blocks for the short-term cards.
        function* collectAgreements() {
          for (const row of rows) {
            if (agreements.length < MAX_PASSAGES && automatic.length + agreements.length < MAX_NEW_AGREEMENTS) {
              const agreement = extractStandingAgreement(row, source, cutoff, now);
              if (agreement) agreements.push(agreement);
            }
            yield row;
          }
        }
        for (const entry of iterateCanonicalVisibleEntriesNewestFirst(collectAgreements(), sessionId)) {
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
        if (!agreements.length && (count <= 3 || activeAt < cutoff)) continue;
        if (readSourceFence(root, sessionId, read)?.key !== source.key) continue;
        for (const agreement of agreements) {
          automatic.push({ ...agreement, sessionId, sourceIdentity: source.identity });
        }
        if (count <= 3 || activeAt < cutoff) continue;
        cards.push({ sessionId, activeAt, deletionGeneration: source.key, messages, candidates,
          title: truncate(typeof meta.name === 'string' ? meta.name : sessionId, 240),
          workDir: truncate(typeof meta.workDir === 'string' ? meta.workDir : '', 512) });
      } catch (error) {
        // Missing/deleted or corrupt Sessions can't keep their stale cards.
        console.warn('[SessionDiscovery] skipping unreadable Session:', error.code || error.name);
      }
    }
    return replaceDailyIndex(db, cards, now, automatic, root);
  } finally { db.close(); }
}
