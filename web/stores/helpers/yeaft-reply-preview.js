/**
 * Lightweight per-Session reply & AskUser preview cache for Yeaft Cosmos Signal Stream
 * and background Session telemetry.
 *
 * Scoped strictly by canonical catalog key (`yeaft:<agentId>:<sessionId>`), bounded
 * to prevent unbounded memory growth, deduplicated against unchanged streaming frames,
 * and cleared on turn deletion, session deletion, agent runtime reset, or logout.
 */

export const MAX_YEAFT_REPLY_PREVIEWS = 160;
const MAX_PREVIEW_CHARS = 280;

export function stripMarkdownPreview(raw, maxLen = MAX_PREVIEW_CHARS) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function extractLatestAssistantPreview(messages, sessionId, turnId = null) {
  if (!Array.isArray(messages) || messages.length === 0) return { text: '', at: 0, turnId: null };
  let seenUserMessage = false;
  let untaggedAfterUser = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (!row) continue;
    const rowSessionId = row.sessionId ?? row.groupId ?? '';
    if (sessionId && rowSessionId !== sessionId) continue;

    if (row.type === 'user') {
      const userText = typeof row.content === 'string'
        ? row.content
        : (typeof row.text === 'string' ? row.text : '');
      const hasAttachments = Array.isArray(row.attachments) && row.attachments.length > 0;
      if (userText.trim() || hasAttachments) {
        seenUserMessage = true;
        // Without a specific turnId, never cross a user-message boundary into a prior turn.
        if (!turnId) break;
      }
      continue;
    }

    if (row.type !== 'assistant') continue;
    const raw = row.presentation?.summary || row.content || row.text || '';
    const cleaned = stripMarkdownPreview(raw);
    if (!cleaned) continue;
    const rawTs = row.turnEndAt || row.timestamp || row.createdAt || 0;
    const at = typeof rawTs === 'number' && Number.isFinite(rawTs)
      ? rawTs
      : (typeof rawTs === 'string' && rawTs ? (Date.parse(rawTs) || 0) : 0);

    if (turnId) {
      if (row.turnId === turnId) return { text: cleaned, at, turnId };
      // Never fall back to an assistant row owned by a different turnId.
      // Only accept an untagged legacy assistant row if it appeared after the
      // latest user message and is not a prior persisted history row.
      if (!row.turnId && !seenUserMessage && !row.isHistory && !untaggedAfterUser) {
        untaggedAfterUser = { text: cleaned, at, turnId: null };
      }
      continue;
    }

    return { text: cleaned, at, turnId: row.turnId || null };
  }
  return untaggedAfterUser || { text: '', at: 0, turnId: null };
}

export function recordYeaftSessionReplyPreview(store, {
  catalogKey,
  text,
  at = Date.now(),
  kind = 'assistant',
  turnId = null,
  live = false,
  beginTurn = false,
  preserveLiveIfInFlight = false,
  onlyIfNoUpdateSince = 0,
  finalizeTurn = false,
  cancelTurn = false,
  askQuestion,
  askRequestId = null,
  askTurnId = null,
  askExpiresAt = 0,
  clearAsk = false,
} = {}) {
  if (!store || !catalogKey) return false;
  const map = store.yeaftSessionReplyPreviewByKey || {};
  const prev = map[catalogKey] || null;
  const cleanedText = typeof text === 'string' ? stripMarkdownPreview(text) : '';
  const cleanedAsk = typeof askQuestion === 'string' ? stripMarkdownPreview(askQuestion) : '';
  const now = Date.now();
  const ts = Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : now;
  const normalizedTurnId = typeof turnId === 'string' && turnId ? turnId : null;

  if (beginTurn && onlyIfNoUpdateSince > 0 && prev && (prev.updatedAt || 0) >= onlyIfNoUpdateSince) {
    return false;
  }

  let nextText = prev?.text || '';
  let nextAt = prev?.at || 0;
  let nextTurnId = prev?.turnId || null;
  let nextKind = prev?.kind || kind;
  let nextLiveText = prev?.liveText || '';
  let nextLiveAt = prev?.liveAt || 0;
  let nextLiveTurnId = prev?.liveTurnId || null;
  let nextInFlight = Boolean(prev?.inFlight);
  let nextTurnStartedAt = prev?.turnStartedAt || 0;
  let nextFinalizedEmptyTurnId = prev?.finalizedEmptyTurnId || null;
  let nextAskQuestion = prev?.askQuestion || '';
  let nextAskRequestId = prev?.askRequestId || null;
  let nextAskTurnId = prev?.askTurnId || null;
  let nextAskExpiresAt = prev?.askExpiresAt || 0;
  let nextAskAt = prev?.askAt || 0;

  let hasAction = false;

  if (clearAsk) {
    const canClearAsk = Boolean(prev && (prev.askQuestion || prev.askRequestId || prev.askTurnId))
      && !(askRequestId && prev.askRequestId && prev.askRequestId !== askRequestId)
      && !(askTurnId && prev.askTurnId && prev.askTurnId !== askTurnId);
    if (canClearAsk) {
      nextAskQuestion = '';
      nextAskRequestId = null;
      nextAskTurnId = null;
      nextAskExpiresAt = 0;
      nextAskAt = 0;
      hasAction = true;
    }
  }

  if (beginTurn) {
    const sameLiveTurn = Boolean(normalizedTurnId && prev?.liveTurnId && prev.liveTurnId === normalizedTurnId);
    const keepCurrentInFlight = preserveLiveIfInFlight && Boolean(prev?.inFlight) && !normalizedTurnId;
    if (!keepCurrentInFlight && !(sameLiveTurn && prev?.inFlight)) {
      nextInFlight = true;
      nextLiveTurnId = normalizedTurnId || (sameLiveTurn ? prev.liveTurnId : null);
      if (!sameLiveTurn) {
        nextLiveText = '';
        nextLiveAt = 0;
      }
      nextTurnStartedAt = Math.max(now, prev?.turnStartedAt || 0);
      nextFinalizedEmptyTurnId = null;
      hasAction = true;
    }
  } else if (finalizeTurn) {
    const otherActiveTurn = Boolean(prev?.inFlight && prev.liveTurnId && normalizedTurnId && prev.liveTurnId !== normalizedTurnId);
    const matchesLiveTurn = Boolean(
      (normalizedTurnId && prev?.liveTurnId === normalizedTurnId)
      || (!normalizedTurnId && prev?.inFlight)
      || (!prev?.liveTurnId && prev?.inFlight),
    );
    const resolvedText = cleanedText || (matchesLiveTurn ? (prev?.liveText || '') : '');
    if (!otherActiveTurn) {
      nextInFlight = false;
      nextLiveTurnId = null;
      nextLiveText = '';
      nextLiveAt = 0;
    }
    if (resolvedText) {
      nextText = resolvedText;
      nextKind = kind;
      nextAt = Math.max(ts, prev?.at || 0);
      nextTurnId = normalizedTurnId || prev?.turnId || null;
      nextFinalizedEmptyTurnId = null;
    } else if (!otherActiveTurn) {
      // Turn ended cleanly with zero assistant text — clear stale prior-turn text
      // so the Signal Stream never displays an older turn's reply as this turn's response.
      nextText = '';
      nextAt = ts;
      nextTurnId = normalizedTurnId;
      nextFinalizedEmptyTurnId = normalizedTurnId || '__empty__';
    }
    hasAction = true;
  } else if (cancelTurn) {
    const matchesActive = !normalizedTurnId || !prev?.liveTurnId || prev.liveTurnId === normalizedTurnId;
    if (matchesActive && (prev?.inFlight || prev?.liveText || prev?.liveTurnId)) {
      nextInFlight = false;
      nextLiveTurnId = null;
      nextLiveText = '';
      nextLiveAt = 0;
      hasAction = true;
    }
  } else if (cleanedText) {
    const otherActiveTurn = Boolean(!live && prev?.inFlight && prev.liveTurnId && normalizedTurnId && prev.liveTurnId !== normalizedTurnId);
    if (live) {
      nextInFlight = true;
      nextLiveText = cleanedText;
      nextLiveAt = Math.max(ts, prev?.liveAt || 0);
      nextLiveTurnId = normalizedTurnId || prev?.liveTurnId || null;
    } else if (!otherActiveTurn && prev?.inFlight && (!normalizedTurnId || !prev.liveTurnId || prev.liveTurnId === normalizedTurnId)) {
      nextLiveText = cleanedText;
      nextLiveAt = Math.max(ts, prev?.liveAt || 0);
    }
    if (!otherActiveTurn) {
      nextText = cleanedText;
      nextKind = kind;
      nextAt = Math.max(ts, prev?.at || 0);
      if (normalizedTurnId) nextTurnId = normalizedTurnId;
      nextFinalizedEmptyTurnId = null;
      hasAction = true;
    }
  }

  if (cleanedAsk) {
    const parsedExpiresAt = Number.isFinite(Number(askExpiresAt)) && Number(askExpiresAt) > 0
      ? Number(askExpiresAt)
      : (typeof askExpiresAt === 'string' && askExpiresAt ? (Date.parse(askExpiresAt) || 0) : 0);
    nextAskQuestion = cleanedAsk;
    nextAskRequestId = askRequestId || prev?.askRequestId || null;
    nextAskTurnId = askTurnId || prev?.askTurnId || null;
    nextAskExpiresAt = parsedExpiresAt || prev?.askExpiresAt || 0;
    nextAskAt = Math.max(ts, prev?.askAt || 0);
    hasAction = true;
  }

  if (!hasAction) return false;

  // Standalone ask-clearing drops the entry when no reply or turn state remains.
  if (clearAsk && !beginTurn && !finalizeTurn && !cancelTurn && !cleanedText && !cleanedAsk
      && !nextText && !nextLiveText && !nextInFlight && !nextFinalizedEmptyTurnId) {
    const { [catalogKey]: _drop, ...rest } = map;
    store.yeaftSessionReplyPreviewByKey = rest;
    return true;
  }

  // Skip no-op map clones on streaming deltas once the 280-char preview has stabilized.
  if (prev
    && prev.text === nextText
    && (prev.turnId || null) === nextTurnId
    && prev.kind === nextKind
    && (prev.liveText || '') === nextLiveText
    && (prev.liveTurnId || null) === nextLiveTurnId
    && Boolean(prev.inFlight) === nextInFlight
    && (prev.finalizedEmptyTurnId || null) === nextFinalizedEmptyTurnId
    && (prev.askQuestion || '') === nextAskQuestion
    && (prev.askRequestId || null) === nextAskRequestId
    && (prev.askTurnId || null) === nextAskTurnId
    && (prev.askExpiresAt || 0) === nextAskExpiresAt) {
    return false;
  }

  const nextEntry = {
    text: nextText,
    turnId: nextTurnId,
    kind: nextKind,
    at: nextAt,
    liveText: nextLiveText,
    liveAt: nextLiveAt,
    liveTurnId: nextLiveTurnId,
    inFlight: nextInFlight,
    turnStartedAt: nextTurnStartedAt,
    finalizedEmptyTurnId: nextFinalizedEmptyTurnId,
    askQuestion: nextAskQuestion,
    askRequestId: nextAskRequestId,
    askTurnId: nextAskTurnId,
    askExpiresAt: nextAskExpiresAt,
    askAt: nextAskAt,
    updatedAt: now,
  };

  const nextMap = { ...map, [catalogKey]: nextEntry };
  const keys = Object.keys(nextMap);
  if (keys.length > MAX_YEAFT_REPLY_PREVIEWS) {
    keys.sort((a, b) => (nextMap[a]?.updatedAt || 0) - (nextMap[b]?.updatedAt || 0));
    const excess = keys.length - MAX_YEAFT_REPLY_PREVIEWS;
    for (let i = 0; i < excess; i++) {
      if (keys[i] !== catalogKey) delete nextMap[keys[i]];
    }
  }
  store.yeaftSessionReplyPreviewByKey = nextMap;
  return true;
}

export function clearYeaftSessionReplyPreview(store, catalogKey = null) {
  if (!store) return false;
  if (!catalogKey) {
    if (!store.yeaftSessionReplyPreviewByKey || Object.keys(store.yeaftSessionReplyPreviewByKey).length === 0) {
      return false;
    }
    store.yeaftSessionReplyPreviewByKey = {};
    return true;
  }
  const map = store.yeaftSessionReplyPreviewByKey;
  if (!map || !map[catalogKey]) return false;
  const { [catalogKey]: _removed, ...rest } = map;
  store.yeaftSessionReplyPreviewByKey = rest;
  return true;
}

/**
 * Clear pending AskUser previews for an Agent (or all Agents when agentId is falsy)
 * without discarding completed reply previews.
 */
export function clearYeaftAgentAskPreviews(store, agentId = null) {
  const map = store?.yeaftSessionReplyPreviewByKey;
  if (!map) return false;
  let changed = false;
  const nextMap = {};
  for (const [key, entry] of Object.entries(map)) {
    const sep = key.lastIndexOf(':');
    const matchesAgent = !agentId
      ? key.startsWith('yeaft:')
      : (key.startsWith('yeaft:') && sep > 6 && key.slice(6, sep) === agentId);
    const hasEphemeralRuntime = Boolean(
      entry?.askQuestion
      || entry?.askRequestId
      || entry?.askTurnId
      || entry?.inFlight
      || entry?.liveText
      || entry?.liveTurnId,
    );
    if (matchesAgent && hasEphemeralRuntime) {
      changed = true;
      if (entry.text || entry.finalizedEmptyTurnId) {
        nextMap[key] = {
          ...entry,
          liveText: '',
          liveAt: 0,
          liveTurnId: null,
          inFlight: false,
          askQuestion: '',
          askRequestId: null,
          askTurnId: null,
          askExpiresAt: 0,
          askAt: 0,
        };
      }
      continue;
    }
    nextMap[key] = entry;
  }
  if (!changed) return false;
  store.yeaftSessionReplyPreviewByKey = nextMap;
  return true;
}
