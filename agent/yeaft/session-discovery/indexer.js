import { join } from 'node:path';
import { createAgentHistoryScan } from '../conversation/search.js';
import { parseMessage, parseSeqFromId } from '../conversation/persist.js';
import { sessionDeletionProjection } from '../conversation/turn-deletion-journal.js';
import { isVisibleConversationRow } from '../conversation/internal-control.js';
import {
  DAY_MS,
  applyDailyIndexUpdates,
  discoveryIndexedAt,
  listIndexedCardWatermarks,
  localSessionDirs,
  openDiscoveryStore,
  readSourceFence,
} from './store.js';

// Keep the legacy review-only proposal extractor for the manual Share API.
const durablePrefix = /^(?:(?:我们)?(?:已达成共识|达成共识|已确认|已决定|决定|长期约定|我的长期偏好)\s*[:：]|(?:从今往后|今后默认|以后默认|今后统一|以后统一)[，、,:：]?|(?:consensus|confirmed decision|standing agreement|standing preference)\s*:|(?:going forward|from now on|we agreed(?: that)?)\b[\s,:-]*)\s*/iu;
const nonPortable = /`|\b(?:https?:\/\/|(?:api|access|secret)[ _-]?key\b|password\b)|(?:密码|密钥|令牌)|(?:^|\s)(?:[~.]?[/\\]|\w:[/\\])|\b[\w.-]+\.(?:[cm]?[jt]sx?|py|go|rs|sh|tsx|json|ya?ml|toml|ini|css|html|sql|md)\b|[{}<>]|[?？]|\b(?:should we|what if|maybe|might|not yet)\b|(?:是否|要不要|可能|还没定|待确认)/iu;
const standingPrefix = /^(?:(?:长期约定|长期决定|我的长期偏好)[ \t]*[:：]|(?:今后默认|以后默认)[，、,:：]?|(?:standing agreement|standing preference|durable decision)[ \t]*:)[ \t]*/iu;
const automaticExclusions = /[/\\]|\b\S+\.[a-z][a-z0-9]{0,11}\b|\b(?:bearer|credentials?|tokens?)\b|(?:本次|这次|当前(?:任务|仓库|项目))|\b(?:this (?:time|task|repo(?:sitory)?|project)|just once)\b/iu;

const FAILED_RESPONSE_REASONS = new Set(['aborted', 'errored', 'error', 'cancelled', 'canceled']);
const MAX_AGREEMENTS_PER_SESSION = 50;
const MAX_NEW_AGREEMENTS = 2_000;
const MAX_UPSERTS_PER_RUN = 5_000;
export const MAX_MESSAGE_INDEX_CHARS = 64 * 1024;
const MIN_MESSAGES_FOR_CARD = 4;

const truncate = (text, limit) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
const seq = row => Number.isFinite(row?.seq) ? Number(row.seq) : parseSeqFromId(row?.id);

function rowTimestamp(row) {
  const raw = row?.ts ?? row?.time;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  return Date.parse(raw);
}

/**
 * Resolve the inclusive sequence boundary at which incremental append should
 * prune and re-insert messages, so an assistant turn split across two indexing
 * runs (e.g. progress -> result) is re-evaluated cleanly without touching older turns.
 * Returns the first seq after the last user message at/before `existingLastSeq`,
 * or `0` when no user message precedes `existingLastSeq` (covering seq === 0).
 */
function findTurnPruneStartSeq(rows, sessionId, existingLastSeq) {
  if (!Number.isFinite(existingLastSeq) || existingLastSeq < 0) return 0;
  let lastUserSeq = null;
  for (const row of rows) {
    if (!row || row.sessionId !== sessionId || !isVisibleConversationRow(row)) continue;
    const rowSeq = seq(row);
    if (!Number.isFinite(rowSeq)) continue;
    if (rowSeq > existingLastSeq) break;
    if (row.role === 'user') lastUserSeq = rowSeq;
  }
  return lastUserSeq === null ? 0 : lastUserSeq + 1;
}

/**
 * Extract plain text only from a conversation row.
 * Images, binary/base64 blocks, attachments, tool calls, and tool results are excluded.
 */
function extractPlainText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim();
}

function classifyAssistantResponseKind(row) {
  if (row?.incomplete === true || FAILED_RESPONSE_REASONS.has(row?.stopReason)) return 'progress';
  if (row?.responseKind === 'progress' || row?.responseKind === 'result') return row.responseKind;
  if (row?.stopReason === 'end_turn') return 'result';
  if (Array.isArray(row?.toolCalls) && row.toolCalls.length > 0) return 'progress';
  return null;
}

function extractConsensus(message, createdAt) {
  if (message.role !== 'user' || message.text.length > 500 || !message.messageId) return null;
  const prefix = durablePrefix.exec(message.text);
  if (!prefix) return null;
  const body = message.text.slice(prefix[0].length).trim();
  if (body.length < 4 || nonPortable.test(body)) return null;
  const title = truncate(body.split(/[。！？.!?；;]/u)[0].trim() || body, 72);
  return { title, body, sourceMessageId: message.messageId, createdAt };
}

function extractStandingAgreement(row, source, now) {
  if (row?.role !== 'user' || !row.id || row.id.length > 32 || !isVisibleConversationRow(row)
      || (row.origin && (row.origin.sessionId !== row.sessionId || row.origin.streamId !== source.streamId))) return null;
  const createdAt = rowTimestamp(row);
  if (!Number.isSafeInteger(createdAt) || createdAt > now) return null;
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

// Scan the canonical instance transcript oldest-first. Don't open/repair the
// live SegmentStore from a worker, and never follow a transcript-supplied path.
function readTranscriptRowsOldestFirst(conversation, sessionId, read, list, operations) {
  const { scrub } = sessionDeletionProjection(operations);
  const bySeq = new Map();

  const legacy = ['messages', 'cold'].flatMap(kind => {
    const dir = join(conversation, kind);
    return (list(dir, '.md') || []).filter(name => /^m\d+\.md$/u.test(name))
      .map(name => ({ path: join(dir, name), id: name.slice(0, -3) }));
  });
  for (const file of legacy) {
    const raw = read(file.path);
    const parsed = raw ? parseMessage(raw) : null;
    if (!parsed || parsed.id !== file.id || (parsed.sessionId && parsed.sessionId !== sessionId)) continue;
    const kept = scrub({ ...parsed, sessionId });
    const rowSeq = seq(kept);
    if (kept && Number.isFinite(rowSeq)) bySeq.set(rowSeq, kept);
  }

  const segments = (list(join(conversation, 'segments'), '.jsonl') || [])
    .filter(file => /^\d+\.jsonl$/u.test(file))
    .sort((a, b) => Number.parseInt(a.slice(0, -6), 10) - Number.parseInt(b.slice(0, -6), 10) || a.localeCompare(b));
  for (const file of segments) {
    const raw = read(join(conversation, 'segments', file));
    if (!raw) continue;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (row?.sessionId !== sessionId) continue;
        const kept = scrub(row);
        const rowSeq = seq(kept);
        if (kept && Number.isFinite(rowSeq)) bySeq.set(rowSeq, kept);
      } catch { /* an incomplete trailing append may be read */ }
    }
  }

  return [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}

/**
 * Project persisted transcript rows into indexable complete User questions and
 * final Assistant responses (excluding intermediate `progress` replies, tool calls,
 * tool results, images, and hidden internal rows).
 */
export function extractIndexableTurnMessages(rows, sessionId, now) {
  const indexable = [];
  let visibleTurnCount = 0;
  let activeAt = 0;
  let lastSeq = 0;

  let assistantBucket = [];

  const flushAssistantBucket = () => {
    if (assistantBucket.length === 0) return;
    const byGroup = new Map();
    for (const item of assistantBucket) {
      const turnId = typeof item.row.turnId === 'string' && item.row.turnId ? item.row.turnId : null;
      const speaker = item.row.speakerVpId || item.row.meta?.senderVpId
        || (item.row.role === 'assistant' && item.row.from && item.row.from !== 'user' ? item.row.from : '');
      // Match visible-entry.js: coalesce by explicit turnId + speaker; legacy
      // assistant rows without a turnId keep their own message identity so
      // distinct legacy replies are never collapsed into one.
      const key = turnId
        ? `turn:${turnId}:speaker:${speaker}`
        : `legacy:${speaker}:${item.row.id || item.seq}`;
      const list = byGroup.get(key) || [];
      list.push(item);
      byGroup.set(key, list);
    }

    const chosen = [];
    for (const items of byGroup.values()) {
      const textItems = items.filter(item => item.text.length > 0);
      // Every visible assistant turn counts toward session activity/message count
      // even if it had no final text (or was image-only).
      visibleTurnCount += 1;
      for (const item of items) {
        if (Number.isFinite(item.time) && item.time <= now) activeAt = Math.max(activeAt, item.time);
        lastSeq = Math.max(lastSeq, item.seq);
      }
      if (textItems.length === 0) continue;

      const explicitResults = textItems.filter(item => item.kind === 'result');
      let finalItem = null;
      if (explicitResults.length > 0) {
        finalItem = explicitResults[explicitResults.length - 1];
      } else {
        // Legacy rows without responseKind/stopReason: keep the last unlabeled row
        // only when it is not followed by an explicit progress row (which indicates
        // an in-progress or failed turn rather than a finished response).
        const lastText = textItems[textItems.length - 1];
        if (lastText.kind === null) {
          finalItem = lastText;
        }
      }
      if (finalItem) {
        chosen.push({
          seq: finalItem.seq,
          role: 'assistant',
          messageId: finalItem.row.id,
          createdAt: Number.isFinite(finalItem.time) ? finalItem.time : 0,
          text: truncate(finalItem.text, MAX_MESSAGE_INDEX_CHARS),
        });
      }
    }

    chosen.sort((a, b) => a.seq - b.seq);
    indexable.push(...chosen);
    assistantBucket = [];
  };

  for (const row of rows) {
    if (!row || row.sessionId !== sessionId || !isVisibleConversationRow(row)) continue;
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    const rowSeq = seq(row);
    if (!Number.isFinite(rowSeq)) continue;
    const time = rowTimestamp(row);
    const text = extractPlainText(row.content);

    if (row.role === 'user') {
      flushAssistantBucket();
      visibleTurnCount += 1;
      if (Number.isFinite(time) && time <= now) activeAt = Math.max(activeAt, time);
      lastSeq = Math.max(lastSeq, rowSeq);
      if (text) {
        indexable.push({
          seq: rowSeq,
          role: 'user',
          messageId: row.id,
          createdAt: Number.isFinite(time) ? time : 0,
          text: truncate(text, MAX_MESSAGE_INDEX_CHARS),
        });
      }
      continue;
    }

    const hasVisiblePayload = text.length > 0
      || Boolean(row.attachments?.length || row.images?.length || row.imageAssetIds?.length)
      || Boolean(row.todos || row.askUserResults);
    if (!hasVisiblePayload) continue;

    assistantBucket.push({
      row,
      seq: rowSeq,
      time,
      text,
      kind: classifyAssistantResponseKind(row),
    });
  }

  flushAssistantBucket();

  return {
    messages: indexable,
    visibleTurnCount,
    activeAt,
    lastSeq,
  };
}

export function runDailySessionIndex(root, now = Date.now(), { force = false, createScan = createAgentHistoryScan } = {}) {
  const db = openDiscoveryStore(root);
  try {
    const indexedAt = discoveryIndexedAt(db);
    if (!force && indexedAt !== null && now >= indexedAt && now - indexedAt < DAY_MS) return false;

    const existingCards = listIndexedCardWatermarks(db);
    const upserts = [];
    const removedSessionIds = [];
    const automatic = [];
    const telemetry = {};
    const { read, list, stopped } = createScan(root, telemetry);
    const scanStopped = () => Boolean(stopped() || telemetry.scanIncomplete);

    // Newest-created first so bounded scan budgets prioritize recent work first
    // while still indexing all eligible historical Sessions incrementally.
    const sessionsMap = localSessionDirs(root, read);
    if (scanStopped()) return false;
    const sessions = [...sessionsMap].reverse();

    for (const existingSessionId of existingCards.keys()) {
      if (!sessionsMap.has(existingSessionId)) {
        removedSessionIds.push(existingSessionId);
      }
    }

    for (const [sessionId, dir] of sessions) {
      if (scanStopped() || upserts.length >= MAX_UPSERTS_PER_RUN) break;
      try {
        const source = readSourceFence(root, sessionId, read, { includeSignature: true, list });
        if (scanStopped()) break;
        if (!source) {
          if (existingCards.has(sessionId)) removedSessionIds.push(sessionId);
          continue;
        }
        const meta = source.meta;
        const title = truncate(typeof meta.name === 'string' ? meta.name : sessionId, 240);
        const workDir = truncate(typeof meta.workDir === 'string' ? meta.workDir : '', 512);
        const existing = existingCards.get(sessionId);

        const unchangedTranscript = Boolean(
          existing
          && existing.deletionGeneration === source.key
          && existing.freshAt === source.freshAt
          && existing.transcriptSignature === (source.transcriptSignature || '')
          && source.freshAt > 0,
        );
        if (unchangedTranscript) {
          if (existing.title !== title || existing.workDir !== workDir) {
            upserts.push({
              mode: 'append',
              sessionId,
              title,
              workDir,
              activeAt: existing.activeAt,
              deletionGeneration: existing.deletionGeneration,
              freshAt: existing.freshAt,
              transcriptSignature: existing.transcriptSignature,
              lastSeq: existing.lastSeq,
              messageCount: existing.messageCount,
              messages: [],
              candidates: [],
            });
          }
          continue;
        }

        const rows = readTranscriptRowsOldestFirst(join(dir, 'conversation'), sessionId, read, list, source.operations);
        // Never mutate or delete an existing Session card using a partial/truncated
        // read caused by scan budget exhaustion.
        if (scanStopped()) break;
        const agreements = [];
        for (const row of rows) {
          if (agreements.length >= MAX_AGREEMENTS_PER_SESSION
              || automatic.length + agreements.length >= MAX_NEW_AGREEMENTS) break;
          const agreement = extractStandingAgreement(row, source, now);
          if (agreement) agreements.push(agreement);
        }

        const { messages, visibleTurnCount, activeAt, lastSeq } = extractIndexableTurnMessages(rows, sessionId, now);

        // Verify the source fence did not mutate mid-read.
        const afterSource = readSourceFence(root, sessionId, read);
        if (scanStopped()) break;
        if (afterSource?.key !== source.key) continue;

        for (const agreement of agreements) {
          automatic.push({ ...agreement, sessionId, sourceIdentity: source.identity });
        }

        if (visibleTurnCount < MIN_MESSAGES_FOR_CARD || activeAt <= 0) {
          // Daily sweep enforces the >=4 message threshold for brand-new indexing,
          // while preserving cards ALREADY inserted by live turn-end refresh (`existing`)
          // while they remain active within the 5-day window.
          const keepExistingLiveCard = Boolean(
            existing
            && activeAt > 0
            && now - activeAt <= 5 * DAY_MS
            && visibleTurnCount >= 2,
          );
          if (!keepExistingLiveCard) {
            if (existing) removedSessionIds.push(sessionId);
            continue;
          }
        }

        const candidates = [];
        for (const message of messages) {
          const proposal = extractConsensus(message, message.createdAt);
          if (proposal) candidates.push(proposal);
        }

        // True incremental append when the lineage/deletion fence matches and
        // we only have strictly newer turns. If the previous run ended mid-turn
        // (e.g. a progress/result update arrived for the same assistant turn),
        // prune & re-insert only from the boundary user turn forward.
        // Only perform delta append when we know the transcript only grew at the tail
        // (i.e. canonical segment index signature is present and unchanged prior to tail).
        // For legacy markdown transcripts or non-monotonic changes, fall back to replace.
        const hasIndexSignature = Boolean(source.transcriptSignature && source.transcriptSignature.startsWith('[["idx",'));
        const canIncrementalAppend = Boolean(
          existing
          && hasIndexSignature
          && existing.deletionGeneration === source.key
          && lastSeq >= existing.lastSeq
          && visibleTurnCount >= existing.messageCount,
        );
        const pruneFromSeq = canIncrementalAppend
          ? findTurnPruneStartSeq(rows, sessionId, existing.lastSeq)
          : null;
        const deltaMessages = canIncrementalAppend
          ? messages.filter(message => message.seq >= pruneFromSeq)
          : messages;

        upserts.push({
          mode: canIncrementalAppend ? 'append' : 'replace',
          pruneFromSeq: canIncrementalAppend ? pruneFromSeq : null,
          sessionId,
          title,
          workDir,
          activeAt,
          deletionGeneration: source.key,
          freshAt: source.freshAt,
          transcriptSignature: source.transcriptSignature || '',
          lastSeq,
          messageCount: visibleTurnCount,
          messages: deltaMessages,
          candidates,
        });
      } catch (error) {
        if (scanStopped()) break;
        // Missing/deleted or corrupt Sessions can't keep their stale cards.
        if (existingCards.has(sessionId)) removedSessionIds.push(sessionId);
        console.warn('[SessionDiscovery] skipping unreadable Session:', error.code || error.name);
      }
    }

    const hitBudgetLimit = scanStopped() || upserts.length >= MAX_UPSERTS_PER_RUN;
    return applyDailyIndexUpdates(db, {
      upserts,
      removedSessionIds,
      automatic,
      now,
      root,
      force,
      // When a run stops early due to scan budget, persist already-verified
      // incremental progress without advancing index_state so the next run
      // can resume remaining Sessions instead of stalling for 24 hours.
      markIndexed: !hitBudgetLimit,
    });
  } finally {
    db.close();
  }
}

/**
 * Incrementally refresh one Session's card & complete turn messages in
 * `discovery.db` immediately after a turn settles (or when metadata changes),
 * without advancing the 24h `index_state` timer or running global standing-agreement sweeps.
 *
 * Accepts Sessions with `>= minMessages` (default 2: at least 1 complete user+assistant
 * turn; pass 4 to enforce the daily-sweep threshold) so a newly created Session
 * becomes searchable and eligible for Tier 2 auto-routing right away.
 */
export function refreshSingleSessionIndex(root, sessionId, now = Date.now(), {
  minMessages = 2,
  busyTimeoutMs = 150,
  createScan = createAgentHistoryScan,
} = {}) {
  if (!root || typeof sessionId !== 'string' || !sessionId.trim()) return false;
  const targetId = sessionId.trim();
  const db = openDiscoveryStore(root, { busyTimeoutMs });
  try {
    const existingCards = listIndexedCardWatermarks(db);
    const existing = existingCards.get(targetId);
    const telemetry = {};
    const { read, list, stopped } = createScan(root, telemetry);
    const scanStopped = () => Boolean(stopped() || telemetry.scanIncomplete);

    const sessionsMap = localSessionDirs(root, read, new Set([targetId]));
    if (scanStopped()) return false;
    const dir = sessionsMap.get(targetId);
    if (!dir) {
      if (existing) {
        return applyDailyIndexUpdates(db, {
          upserts: [],
          removedSessionIds: [targetId],
          automatic: [],
          now,
          root: null,
          force: true,
          markIndexed: false,
        });
      }
      return false;
    }

    const source = readSourceFence(root, targetId, read, { includeSignature: true, list });
    if (scanStopped()) return false;
    if (!source) {
      if (existing) {
        return applyDailyIndexUpdates(db, {
          upserts: [],
          removedSessionIds: [targetId],
          automatic: [],
          now,
          root: null,
          force: true,
          markIndexed: false,
        });
      }
      return false;
    }

    const meta = source.meta;
    const title = truncate(typeof meta.name === 'string' ? meta.name : targetId, 240);
    const workDir = truncate(typeof meta.workDir === 'string' ? meta.workDir : '', 512);

    const rows = readTranscriptRowsOldestFirst(join(dir, 'conversation'), targetId, read, list, source.operations);
    if (scanStopped()) return false;
    const { messages, visibleTurnCount, activeAt, lastSeq } = extractIndexableTurnMessages(rows, targetId, now);
    const afterSource = readSourceFence(root, targetId, read);
    if (scanStopped() || afterSource?.key !== source.key) return false;

    const effectiveMin = Math.max(1, Math.floor(Number(minMessages) || 2));
    if (visibleTurnCount < effectiveMin || activeAt <= 0) {
      if (existing) {
        return applyDailyIndexUpdates(db, {
          upserts: [],
          removedSessionIds: [targetId],
          automatic: [],
          now,
          root: null,
          force: true,
          markIndexed: false,
        });
      }
      return false;
    }

    const candidates = [];
    for (const message of messages) {
      const proposal = extractConsensus(message, message.createdAt);
      if (proposal) candidates.push(proposal);
    }

    const hasIndexSignature = Boolean(source.transcriptSignature && source.transcriptSignature.startsWith('[["idx",'));
    const canIncrementalAppend = Boolean(
      existing
      && hasIndexSignature
      && existing.deletionGeneration === source.key
      && lastSeq >= existing.lastSeq
      && visibleTurnCount >= existing.messageCount,
    );
    const pruneFromSeq = canIncrementalAppend
      ? findTurnPruneStartSeq(rows, targetId, existing.lastSeq)
      : null;
    const deltaMessages = canIncrementalAppend
      ? messages.filter(message => message.seq >= pruneFromSeq)
      : messages;

    return applyDailyIndexUpdates(db, {
      upserts: [{
        mode: canIncrementalAppend ? 'append' : 'replace',
        pruneFromSeq: canIncrementalAppend ? pruneFromSeq : null,
        sessionId: targetId,
        title,
        workDir,
        activeAt,
        deletionGeneration: source.key,
        freshAt: source.freshAt,
        transcriptSignature: source.transcriptSignature || '',
        lastSeq,
        messageCount: visibleTurnCount,
        messages: deltaMessages,
        candidates,
      }],
      removedSessionIds: [],
      automatic: [],
      now,
      root: null,
      force: true,
      markIndexed: false,
    });
  } catch (error) {
    const msg = String(error?.message || '');
    if (error?.errcode === 5 || /database is locked|SQLITE_BUSY/i.test(msg)) {
      const busyErr = new Error('discovery_db_busy');
      busyErr.code = 'SQLITE_BUSY';
      throw busyErr;
    }
    console.warn('[SessionDiscovery] single-session index refresh failed:', error?.code || error?.name || error?.message);
    return false;
  } finally {
    db.close();
  }
}

export function scheduleSingleSessionIndexRefresh(root, sessionId, { maxAttempts = 4, baseDelayMs = 250 } = {}) {
  if (!root || typeof sessionId !== 'string' || !sessionId.trim()) return;
  let attempt = 0;
  const run = () => {
    attempt += 1;
    try {
      refreshSingleSessionIndex(root, sessionId, Date.now(), { busyTimeoutMs: 120 });
    } catch (err) {
      if (err?.code === 'SQLITE_BUSY' && attempt < maxAttempts) {
        const retryTimer = setTimeout(run, baseDelayMs * attempt);
        retryTimer.unref?.();
      }
    }
  };
  const firstTimer = setTimeout(run, 0);
  firstTimer.unref?.();
}
