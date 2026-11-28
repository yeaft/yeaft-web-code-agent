/**
 * Lightweight per-Session reply & AskUser preview cache for Yeaft Cosmos Signal Stream
 * and background Session telemetry.
 *
 * Tracks preview ownership by user-turn root (`userTurnId` / fallback execution root)
 * and per-execution slots (`turnId`) using monotonic lifecycle sequence numbers rather
 * than cross-turn timestamp comparisons. This prevents:
 *   - late `result` frames from overwriting newer completed replies,
 *   - parallel user turns from bleeding across user-message boundaries,
 *   - tool-only sibling VPs in the same fan-out root from erasing another VP's reply,
 *   - reconnect / stale snapshots from retaining orphaned in-flight previews.
 *
 * Scoped strictly by canonical catalog key (`yeaft:<agentId>:<sessionId>`), bounded
 * to prevent unbounded memory growth, deduplicated against unchanged streaming frames,
 * and cleared on turn deletion, session deletion, agent runtime reset, or logout.
 */

export const MAX_YEAFT_REPLY_PREVIEWS = 160;
const MAX_PREVIEW_CHARS = 280;
const MAX_ROOTS_PER_SESSION = 12;
const PENDING_EXEC_KEY = '__pending__';
const ANON_EXEC_KEY = '__anon__';

const RUNNING_VP_STATES = new Set(['typing', 'thinking', 'retrying', 'streaming', 'tool']);

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

/**
 * Shared predicate for a visible user-turn boundary row across extraction and projection.
 * Checks raw trimmed text or attachments (before Markdown stripping) so punctuation-only
 * or attachment-only user prompts still establish a turn boundary consistently.
 */
export function isUserBoundaryRow(row) {
  if (!row || row.type !== 'user' || row.status === 'error') return false;
  const raw = typeof row.content === 'string'
    ? row.content
    : (typeof row.text === 'string' ? row.text : '');
  return Boolean(raw.trim() || (Array.isArray(row.attachments) && row.attachments.length > 0));
}

/**
 * Determine whether a running Session task will re-enter the model upon completion.
 * Explicit `resultDelivery` is authoritative (never overridden by `kind`); `kind === 'sub_agent'`
 * is used only as a fallback for legacy payloads that omit `resultDelivery`.
 */
export function isModelReentryTask(task) {
  if (!task || task.status !== 'running') return false;
  if (typeof task.resultDelivery === 'string' && task.resultDelivery) {
    return task.resultDelivery === 'model_reentry';
  }
  return task.kind === 'sub_agent';
}

export function extractLatestAssistantPreview(messages, sessionId, turnId = null) {
  if (!Array.isArray(messages) || messages.length === 0) return { text: '', at: 0, turnId: null };
  const targetTurnId = typeof turnId === 'string' && turnId ? turnId : null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (!row) continue;
    const rowSessionId = row.sessionId ?? row.groupId ?? '';
    if (sessionId && rowSessionId !== sessionId) continue;

    if (!targetTurnId && isUserBoundaryRow(row)) {
      // Without an explicit execution ID, never cross a user-message boundary into a prior turn.
      break;
    }

    if (row.type !== 'assistant') continue;
    if (targetTurnId) {
      // Strict execution identity: never fall back to an untagged or differently-owned row.
      if (row.turnId !== targetTurnId) continue;
    } else if (row.isHistory === true) {
      continue;
    }

    const raw = row.presentation?.summary || row.content || row.text || '';
    const cleaned = stripMarkdownPreview(raw);
    if (!cleaned) continue;
    const rawTs = row.turnEndAt || row.timestamp || row.createdAt || 0;
    const at = typeof rawTs === 'number' && Number.isFinite(rawTs)
      ? rawTs
      : (typeof rawTs === 'string' && rawTs ? (Date.parse(rawTs) || 0) : 0);
    return { text: cleaned, at, turnId: row.turnId || null };
  }
  return { text: '', at: 0, turnId: null };
}

function normalizeId(val) {
  return typeof val === 'string' && val ? val : null;
}

function cloneRoots(roots) {
  const out = {};
  if (!roots || typeof roots !== 'object') return out;
  for (const [key, root] of Object.entries(roots)) {
    if (!root || typeof root !== 'object') continue;
    const executions = {};
    for (const [ek, ex] of Object.entries(root.executions || {})) {
      if (ex && typeof ex === 'object') executions[ek] = { ...ex };
    }
    out[key] = { ...root, executions };
  }
  return out;
}

function summarizeRoot(root) {
  const execs = Object.values(root.executions || {});
  let hasLiveExecution = false;
  let hasCompletedExecution = false;
  let bestLive = null;
  let bestCompleted = null;
  for (const ex of execs) {
    if (!ex) continue;
    if (ex.state === 'running') {
      hasLiveExecution = true;
      if (ex.text && (!bestLive || (ex.seq || 0) >= (bestLive.seq || 0))) bestLive = ex;
    } else if (ex.state === 'completed') {
      hasCompletedExecution = true;
      if (ex.text && (!bestCompleted || (ex.seq || 0) >= (bestCompleted.seq || 0))) bestCompleted = ex;
    }
  }
  return {
    ...root,
    hasLiveExecution,
    liveText: bestLive?.text || '',
    liveAt: bestLive?.at || 0,
    liveTurnId: bestLive?.turnId || null,
    finalizedText: bestCompleted?.text || '',
    finalizedAt: bestCompleted?.at || 0,
    finalizedTurnId: bestCompleted?.turnId || null,
    finalizedEmpty: !hasLiveExecution && hasCompletedExecution && !bestCompleted,
  };
}

function pruneRoots(roots, keepRootId = null) {
  const keys = Object.keys(roots);
  if (keys.length <= MAX_ROOTS_PER_SESSION) return roots;
  // Evict oldest non-live roots first; keep live roots and the target root.
  keys.sort((a, b) => {
    const ra = roots[a];
    const rb = roots[b];
    if (a === keepRootId) return 1;
    if (b === keepRootId) return -1;
    if (Boolean(ra?.hasLiveExecution) !== Boolean(rb?.hasLiveExecution)) {
      return ra?.hasLiveExecution ? 1 : -1;
    }
    return (ra?.seq || 0) - (rb?.seq || 0);
  });
  const excess = keys.length - MAX_ROOTS_PER_SESSION;
  for (let i = 0; i < excess; i++) {
    if (keys[i] !== keepRootId) delete roots[keys[i]];
  }
  return roots;
}

function findRootOwningTurn(roots, turnId) {
  if (!turnId) return null;
  for (const [rid, root] of Object.entries(roots)) {
    if (root?.executions && Object.prototype.hasOwnProperty.call(root.executions, turnId)) {
      return rid;
    }
  }
  return null;
}

function mergeRootInto(roots, sourceRootId, targetRootId) {
  if (!sourceRootId || !targetRootId || sourceRootId === targetRootId) return false;
  const src = roots[sourceRootId];
  if (!src) return false;
  const dst = roots[targetRootId];
  if (!dst) {
    roots[targetRootId] = summarizeRoot({ ...src, rootId: targetRootId });
    delete roots[sourceRootId];
    return true;
  }
  const mergedExecs = { ...(dst.executions || {}) };
  for (const [ek, ex] of Object.entries(src.executions || {})) {
    if (ek === PENDING_EXEC_KEY && Object.keys(mergedExecs).some((k) => k !== PENDING_EXEC_KEY)) continue;
    const existing = mergedExecs[ek];
    if (!existing || (ex.seq || 0) > (existing.seq || 0) || (!existing.text && ex.text)) {
      mergedExecs[ek] = { ...ex };
    }
  }
  if (Object.keys(mergedExecs).some((k) => k !== PENDING_EXEC_KEY)) {
    delete mergedExecs[PENDING_EXEC_KEY];
  }
  roots[targetRootId] = summarizeRoot({
    ...dst,
    rootId: targetRootId,
    seq: Math.max(dst.seq || 0, src.seq || 0),
    startedAt: Math.min(dst.startedAt || Infinity, src.startedAt || Infinity),
    executions: mergedExecs,
  });
  delete roots[sourceRootId];
  return true;
}

function pickLatestRoot(roots) {
  let latest = null;
  for (const root of Object.values(roots)) {
    if (!root) continue;
    if (!latest || (root.seq || 0) >= (latest.seq || 0)) latest = root;
  }
  return latest;
}

function pickLatestLiveRoot(roots) {
  let latest = null;
  for (const root of Object.values(roots)) {
    if (!root?.hasLiveExecution) continue;
    if (!latest || (root.seq || 0) >= (latest.seq || 0)) latest = root;
  }
  return latest;
}

function pickLatestCompletedRoot(roots) {
  let latest = null;
  for (const root of Object.values(roots)) {
    if (!root || (!root.finalizedText && !root.finalizedEmpty)) continue;
    if (!latest || (root.seq || 0) >= (latest.seq || 0)) latest = root;
  }
  return latest;
}

/**
 * Derive top-level summary fields from the root table so existing readers and tests
 * observe consistent, root-scoped state.
 */
function deriveTopLevelFromRoots(roots, fallbackText, fallbackAt, fallbackTurnId, fallbackKind) {
  const latestRoot = pickLatestRoot(roots);
  const latestLive = pickLatestLiveRoot(roots);
  const latestCompleted = pickLatestCompletedRoot(roots);

  if (!latestRoot) {
    return {
      latestRootId: null,
      text: fallbackText || '',
      at: fallbackAt || 0,
      turnId: fallbackTurnId || null,
      rootId: null,
      liveText: '',
      liveAt: 0,
      liveTurnId: null,
      inFlight: false,
      turnStartedAt: 0,
      finalizedEmptyTurnId: null,
      kind: fallbackKind || 'assistant',
    };
  }

  // Once roots exist, derive finished/live text exclusively from roots — NEVER fall back
  // to the mixed top-level `fallbackText` (which could contain an interrupted live stream).
  let text = '';
  let at = 0;
  let turnId = null;
  let rootId = latestRoot.rootId;
  let finalizedEmptyTurnId = null;

  if (latestRoot.hasLiveExecution) {
    if (latestRoot.liveText) {
      text = latestRoot.liveText;
      at = latestRoot.liveAt;
      turnId = latestRoot.liveTurnId;
    } else if (latestRoot.finalizedText) {
      text = latestRoot.finalizedText;
      at = latestRoot.finalizedAt;
      turnId = latestRoot.finalizedTurnId;
    } else if (latestCompleted) {
      text = latestCompleted.finalizedText;
      at = latestCompleted.finalizedAt;
      turnId = latestCompleted.finalizedTurnId;
      rootId = latestCompleted.rootId;
    }
  } else if (latestRoot.finalizedText) {
    text = latestRoot.finalizedText;
    at = latestRoot.finalizedAt;
    turnId = latestRoot.finalizedTurnId;
  } else if (latestRoot.finalizedEmpty) {
    text = '';
    at = latestRoot.finalizedAt || latestRoot.startedAt || 0;
    turnId = latestRoot.finalizedTurnId;
    finalizedEmptyTurnId = latestRoot.rootId;
  } else if (latestCompleted) {
    text = latestCompleted.finalizedText;
    at = latestCompleted.finalizedAt;
    turnId = latestCompleted.finalizedTurnId;
    rootId = latestCompleted.rootId;
    if (latestCompleted.finalizedEmpty) finalizedEmptyTurnId = latestCompleted.rootId;
  }

  return {
    latestRootId: latestRoot.rootId,
    text,
    at,
    turnId,
    rootId,
    liveText: latestLive?.liveText || '',
    liveAt: latestLive?.liveAt || 0,
    liveTurnId: latestLive?.liveTurnId || null,
    inFlight: Boolean(latestLive),
    turnStartedAt: latestLive?.startedAt || latestRoot.startedAt || 0,
    finalizedEmptyTurnId,
    kind: fallbackKind || 'assistant',
  };
}

function writePreviewMap(store, map, catalogKey, nextEntry) {
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

/**
 * Return true when the Session still has an unresolved optimistic send (`__pending__`)
 * waiting to be linked/supplemented, rejected, cancelled, or reconciled.
 */
export function hasPendingOptimisticPreviewRoot(store, catalogKey) {
  if (!store || !catalogKey) return false;
  const entry = store.yeaftSessionReplyPreviewByKey?.[catalogKey];
  if (!entry?.roots) return false;
  for (const root of Object.values(entry.roots)) {
    if (root?.executions?.[PENDING_EXEC_KEY]?.state === 'running') return true;
  }
  return false;
}

function entriesStructurallyEqual(prev, next) {
  if (!prev) return false;
  if (prev.text !== next.text
    || (prev.turnId || null) !== (next.turnId || null)
    || (prev.rootId || null) !== (next.rootId || null)
    || (prev.latestRootId || null) !== (next.latestRootId || null)
    || (prev.unreadReplyRootId || null) !== (next.unreadReplyRootId || null)
    || prev.kind !== next.kind
    || (prev.liveText || '') !== (next.liveText || '')
    || (prev.liveTurnId || null) !== (next.liveTurnId || null)
    || Boolean(prev.inFlight) !== Boolean(next.inFlight)
    || (prev.finalizedEmptyTurnId || null) !== (next.finalizedEmptyTurnId || null)
    || (prev.askQuestion || '') !== (next.askQuestion || '')
    || (prev.askRequestId || null) !== (next.askRequestId || null)
    || (prev.askTurnId || null) !== (next.askTurnId || null)
    || (prev.askExpiresAt || 0) !== (next.askExpiresAt || 0)) {
    return false;
  }
  const prevRootKeys = Object.keys(prev.roots || {});
  const nextRootKeys = Object.keys(next.roots || {});
  if (prevRootKeys.length !== nextRootKeys.length) return false;
  for (const rk of nextRootKeys) {
    const pr = prev.roots?.[rk];
    const nr = next.roots[rk];
    if (!pr || pr.hasLiveExecution !== nr.hasLiveExecution
      || pr.liveText !== nr.liveText
      || (pr.liveTurnId || null) !== (nr.liveTurnId || null)
      || pr.finalizedText !== nr.finalizedText
      || (pr.finalizedTurnId || null) !== (nr.finalizedTurnId || null)
      || pr.finalizedEmpty !== nr.finalizedEmpty) {
      return false;
    }
    const pExecKeys = Object.keys(pr.executions || {});
    const nExecKeys = Object.keys(nr.executions || {});
    if (pExecKeys.length !== nExecKeys.length) return false;
    for (const ek of nExecKeys) {
      const pe = pr.executions?.[ek];
      const ne = nr.executions[ek];
      if (!pe || pe.state !== ne.state || pe.text !== ne.text || Boolean(pe.explicitTerminal) !== Boolean(ne.explicitTerminal)) return false;
    }
  }
  return true;
}

export function recordYeaftSessionReplyPreview(store, {
  catalogKey,
  text,
  at = Date.now(),
  kind = 'assistant',
  turnId = null,
  rootId = null,
  aliasRootId = null,
  relation = null,
  live = false,
  fromResult = false,
  beginTurn = false,
  preserveLiveIfInFlight = false,
  onlyIfNoUpdateSince = 0,
  linkRootAlias = false,
  syncTurns = null,
  finalizeTurn = false,
  cancelTurn = false,
  reason = null,
  markUnreadReplyRoot = null,
  clearUnreadReply = false,
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
  const normTurnId = normalizeId(turnId);
  const normRootId = normalizeId(rootId);
  const normAliasRootId = normalizeId(aliasRootId);
  const normUnreadReplyRoot = normalizeId(markUnreadReplyRoot);

  if (beginTurn && onlyIfNoUpdateSince > 0 && prev && (prev.updatedAt || 0) >= onlyIfNoUpdateSince) {
    return false;
  }

  let seq = Number(prev?.seq || 0);
  const nextSeq = () => { seq += 1; return seq; };
  const roots = cloneRoots(prev?.roots);

  let nextUnreadReplyRootId = prev?.unreadReplyRootId || null;
  let nextAskQuestion = prev?.askQuestion || '';
  let nextAskRequestId = prev?.askRequestId || null;
  let nextAskTurnId = prev?.askTurnId || null;
  let nextAskExpiresAt = prev?.askExpiresAt || 0;
  let nextAskAt = prev?.askAt || 0;
  let fallbackText = prev?.text || '';
  let fallbackAt = prev?.at || 0;
  let fallbackTurnId = prev?.turnId || null;
  let nextKind = prev?.kind || kind;
  let hasAction = false;

  if (clearUnreadReply && nextUnreadReplyRootId) {
    nextUnreadReplyRootId = null;
    hasAction = true;
  }
  if (normUnreadReplyRoot && nextUnreadReplyRootId !== normUnreadReplyRoot) {
    nextUnreadReplyRootId = normUnreadReplyRoot;
    hasAction = true;
  }

  // Migrate any legacy flat entry into a completed root before new root operations run.
  if (Object.keys(roots).length === 0 && prev?.text && (beginTurn || finalizeTurn || cancelTurn || live || fromResult || Array.isArray(syncTurns))) {
    const legacyId = prev.turnId ? `turn:${prev.turnId}` : '__legacy__';
    const legacyExecKey = prev.turnId || ANON_EXEC_KEY;
    roots[legacyId] = summarizeRoot({
      rootId: legacyId,
      seq: nextSeq(),
      startedAt: prev.at || prev.updatedAt || 0,
      executions: {
        [legacyExecKey]: {
          turnId: prev.turnId || null,
          state: 'completed',
          text: prev.text,
          at: prev.at || 0,
          seq,
        },
      },
    });
  }

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

  // Merge/re-alias an optimistic clientMessageId root onto its authoritative userTurnId.
  if (linkRootAlias && normRootId && normAliasRootId && normAliasRootId !== normRootId) {
    if (relation === 'supplement') {
      if (roots[normAliasRootId]) {
        delete roots[normAliasRootId];
        hasAction = true;
      }
      if (!roots[normRootId]) {
        roots[normRootId] = summarizeRoot({
          rootId: normRootId,
          seq: nextSeq(),
          startedAt: now,
          executions: {
            [PENDING_EXEC_KEY]: { turnId: null, state: 'running', text: '', at: 0, seq },
          },
        });
        hasAction = true;
      }
    } else if (mergeRootInto(roots, normAliasRootId, normRootId)) {
      hasAction = true;
    }
  }

  // Bulk-sync authoritative `session_turns` snapshot roots and executions.
  if (Array.isArray(syncTurns)) {
    const LIVE_TURN_STATES = new Set(['routing', 'queued', 'running', 'cancelling', 'waiting', 'thinking', 'streaming', 'tool', 'retrying']);
    for (const turn of syncTurns) {
      const utId = normalizeId(turn?.userTurnId);
      if (!utId) continue;
      const msgId = normalizeId(turn?.userMessageId);
      if (msgId && msgId !== utId && roots[msgId]) {
        mergeRootInto(roots, msgId, utId);
        hasAction = true;
      }
      const turnLive = LIVE_TURN_STATES.has(turn.state);
      const execList = Array.isArray(turn.executions) ? turn.executions : [];
      if (!turnLive && !roots[utId]) continue;

      let root = roots[utId];
      if (!root) {
        root = { rootId: utId, seq: nextSeq(), startedAt: now, executions: {} };
        roots[utId] = root;
        hasAction = true;
      } else if (turnLive && !root.hasLiveExecution) {
        // Reopened root (e.g. model_reentry or supplement on a finished root) advances seq.
        root.seq = nextSeq();
        hasAction = true;
      }

      for (const exec of execList) {
        const execTurnId = normalizeId(exec?.turnId);
        if (!execTurnId) continue;
        // Migrate any earlier `turn:<id>` bucket that arrived before `session_turns`.
        const tempKey = `turn:${execTurnId}`;
        if (tempKey !== utId && roots[tempKey]) {
          mergeRootInto(roots, tempKey, utId);
          root = roots[utId];
          hasAction = true;
        }
        const execLive = LIVE_TURN_STATES.has(exec.state);
        const existingExec = root.executions[execTurnId];
        if (!existingExec) {
          if (execLive) {
            delete root.executions[PENDING_EXEC_KEY];
            root.executions[execTurnId] = {
              turnId: execTurnId,
              state: 'running',
              text: '',
              at: 0,
              seq: nextSeq(),
            };
            hasAction = true;
          }
        } else if (execLive && existingExec.state !== 'running') {
          // Do not reopen an explicit non-success terminal execution unless a live retry starts via vp_turn_start.
          if (existingExec.explicitTerminal !== true || existingExec.state === 'completed') {
            delete root.executions[PENDING_EXEC_KEY];
            existingExec.state = 'running';
            existingExec.explicitTerminal = false;
            existingExec.seq = nextSeq();
            hasAction = true;
          }
        } else if (!execLive && existingExec.state === 'running') {
          // A `session_turns` snapshot alone cannot distinguish `end_turn` from
          // `route_forward` or verify that pre-disconnect streamed text is complete.
          // Park in `snapshot_settled` until `vp_turn_end` confirms the disposition.
          existingExec.state = exec.state === 'completed' ? 'snapshot_settled' : 'cancelled';
          existingExec.explicitTerminal = false;
          existingExec.seq = nextSeq();
          hasAction = true;
        }
      }

      if (turnLive && Object.keys(root.executions).length === 0) {
        root.executions[PENDING_EXEC_KEY] = { turnId: null, state: 'running', text: '', at: 0, seq: nextSeq() };
        hasAction = true;
      } else if (!turnLive && root.executions[PENDING_EXEC_KEY]) {
        delete root.executions[PENDING_EXEC_KEY];
        hasAction = true;
      }
      roots[utId] = summarizeRoot(root);
    }
  }

  if (beginTurn) {
    let targetRootId = normRootId || findRootOwningTurn(roots, normTurnId);
    if (!targetRootId && normTurnId) {
      // Legacy agents without `userTurnId`: claim the newest unlinked `__pending__` root
      // created by the preceding user send/echo so it does not stay orphaned after turn end.
      let claimablePending = null;
      for (const root of Object.values(roots)) {
        const execKeys = Object.keys(root?.executions || {});
        if (execKeys.length === 1 && execKeys[0] === PENDING_EXEC_KEY && root.executions[PENDING_EXEC_KEY]?.state === 'running') {
          if (!claimablePending || (root.seq || 0) >= (claimablePending.seq || 0)) {
            claimablePending = root;
          }
        }
      }
      targetRootId = claimablePending ? claimablePending.rootId : `turn:${normTurnId}`;
    }
    if (!targetRootId) {
      const currentLive = pickLatestLiveRoot(roots);
      if (preserveLiveIfInFlight && currentLive) {
        targetRootId = null;
      } else {
        targetRootId = `pending:${nextSeq()}`;
      }
    }
    if (targetRootId) {
      if (normAliasRootId && normAliasRootId !== targetRootId && roots[normAliasRootId]) {
        mergeRootInto(roots, normAliasRootId, targetRootId);
      }
      // If `turn:<id>` was previously created and we now have a real `userTurnId`, merge it in.
      if (normTurnId && targetRootId !== `turn:${normTurnId}` && roots[`turn:${normTurnId}`]) {
        mergeRootInto(roots, `turn:${normTurnId}`, targetRootId);
      }
      let root = roots[targetRootId];
      if (!root) {
        root = { rootId: targetRootId, seq: nextSeq(), startedAt: now, executions: {} };
        roots[targetRootId] = root;
        hasAction = true;
      } else if (!root.hasLiveExecution) {
        // Reopened root becomes the newest root.
        root.seq = nextSeq();
        hasAction = true;
      }
      if (normTurnId) {
        delete root.executions[PENDING_EXEC_KEY];
        const existing = root.executions[normTurnId];
        if (!existing) {
          root.executions[normTurnId] = { turnId: normTurnId, state: 'running', text: '', at: 0, seq: nextSeq() };
          hasAction = true;
        } else if (existing.state !== 'running') {
          existing.state = 'running';
          existing.seq = nextSeq();
          hasAction = true;
        }
      } else if (Object.keys(root.executions).length === 0) {
        root.executions[PENDING_EXEC_KEY] = { turnId: null, state: 'running', text: '', at: 0, seq: nextSeq() };
        hasAction = true;
      }
      roots[targetRootId] = summarizeRoot(root);
    }
  } else if (finalizeTurn) {
    let targetRootId = normRootId || findRootOwningTurn(roots, normTurnId);
    if (normTurnId && targetRootId && targetRootId !== `turn:${normTurnId}` && roots[`turn:${normTurnId}`]) {
      mergeRootInto(roots, `turn:${normTurnId}`, targetRootId);
    }
    if (!targetRootId) targetRootId = normTurnId ? `turn:${normTurnId}` : (pickLatestLiveRoot(roots)?.rootId || pickLatestRoot(roots)?.rootId || '__legacy__');
    let root = roots[targetRootId];
    if (!root) {
      root = { rootId: targetRootId, seq: nextSeq(), startedAt: now, executions: {} };
      roots[targetRootId] = root;
    }
    const execKey = normTurnId || PENDING_EXEC_KEY;
    const prevExec = root.executions[execKey] || null;
    const resolvedText = cleanedText || prevExec?.text || '';
    if (normTurnId) delete root.executions[PENDING_EXEC_KEY];
    root.executions[execKey] = {
      turnId: normTurnId,
      state: 'completed',
      explicitTerminal: true,
      text: resolvedText,
      at: resolvedText ? Math.max(ts, prevExec?.at || 0) : ts,
      seq: nextSeq(),
    };
    roots[targetRootId] = summarizeRoot(root);
    nextKind = kind;
    hasAction = true;
  } else if (cancelTurn) {
    const terminalState = reason === 'route_forward'
      ? 'route_forward'
      : (reason === 'errored' || reason === 'error' ? 'errored' : 'cancelled');
    if (normTurnId) {
      let ownerRootId = normRootId || findRootOwningTurn(roots, normTurnId);
      if (normTurnId && ownerRootId && ownerRootId !== `turn:${normTurnId}` && roots[`turn:${normTurnId}`]) {
        mergeRootInto(roots, `turn:${normTurnId}`, ownerRootId);
      }
      if (!ownerRootId) ownerRootId = `turn:${normTurnId}`;
      let root = roots[ownerRootId];
      if (!root) {
        root = { rootId: ownerRootId, seq: nextSeq(), startedAt: now, executions: {} };
        roots[ownerRootId] = root;
      }
      const ex = root.executions[normTurnId];
      // An explicit non-success terminal event (`route_forward`, `aborted`, `errored`)
      // MUST override `running`, `snapshot_settled`, or any provisional completion.
      const canOverride = !ex
        || ex.state === 'running'
        || ex.state === 'snapshot_settled'
        || (ex.state === 'completed' && ex.explicitTerminal !== true);
      if (canOverride) {
        delete root.executions[PENDING_EXEC_KEY];
        root.executions[normTurnId] = {
          turnId: normTurnId,
          state: terminalState,
          explicitTerminal: true,
          text: ex?.text || '',
          at: ex?.at || 0,
          seq: nextSeq(),
        };
        roots[ownerRootId] = summarizeRoot(root);
        hasAction = true;
      }
    } else if (normRootId && roots[normRootId]) {
      const root = roots[normRootId];
      let touched = false;
      for (const ex of Object.values(root.executions || {})) {
        if (ex && (ex.state === 'running' || ex.state === 'snapshot_settled' || (ex.state === 'completed' && ex.explicitTerminal !== true))) {
          ex.state = terminalState;
          ex.explicitTerminal = true;
          ex.seq = nextSeq();
          touched = true;
        }
      }
      if (touched) {
        roots[normRootId] = summarizeRoot(root);
        hasAction = true;
      }
    } else {
      for (const [rid, root] of Object.entries(roots)) {
        let touched = false;
        for (const ex of Object.values(root.executions || {})) {
          if (ex && ex.state === 'running') {
            ex.state = terminalState;
            ex.seq = nextSeq();
            touched = true;
          }
        }
        if (touched) {
          roots[rid] = summarizeRoot(root);
          hasAction = true;
        }
      }
    }
  } else if (cleanedText) {
    if (fromResult) {
      // A `result` frame may ONLY fill or refine its OWN execution — never overwrite
      // a newer root or re-arm an already settled turn as running.
      const existingOwner = normRootId || findRootOwningTurn(roots, normTurnId);
      const latestCompleted = pickLatestCompletedRoot(roots);
      const latestRoot = pickLatestRoot(roots);
      if (existingOwner && roots[existingOwner]) {
        const root = roots[existingOwner];
        const execKey = normTurnId || ANON_EXEC_KEY;
        const prevExec = root.executions[execKey] || null;
        if (prevExec && prevExec.state !== 'running' && prevExec.state !== 'completed') {
          // Do not fill aborted / errored / route_forward executions.
        } else if (!prevExec || !prevExec.text || prevExec.state === 'running') {
          if (normTurnId) delete root.executions[PENDING_EXEC_KEY];
          root.executions[execKey] = {
            turnId: normTurnId,
            state: prevExec ? prevExec.state : 'completed',
            text: cleanedText,
            at: Math.max(ts, prevExec?.at || 0),
            seq: nextSeq(),
          };
          roots[existingOwner] = summarizeRoot(root);
          nextKind = kind;
          hasAction = true;
        }
      } else if (!latestRoot && !latestCompleted) {
        // Cold cache: result arrived first without prior vp_turn_start/vp_turn_end.
        const targetId = normRootId || (normTurnId ? `turn:${normTurnId}` : '__legacy__');
        const execKey = normTurnId || ANON_EXEC_KEY;
        roots[targetId] = summarizeRoot({
          rootId: targetId,
          seq: nextSeq(),
          startedAt: now,
          executions: {
            [execKey]: { turnId: normTurnId, state: 'completed', text: cleanedText, at: ts, seq },
          },
        });
        nextKind = kind;
        hasAction = true;
      }
    } else if (live) {
      let targetRootId = normRootId || findRootOwningTurn(roots, normTurnId);
      if (!targetRootId) targetRootId = normTurnId ? `turn:${normTurnId}` : (pickLatestLiveRoot(roots)?.rootId || `pending:${nextSeq()}`);
      if (normTurnId && targetRootId !== `turn:${normTurnId}` && roots[`turn:${normTurnId}`]) {
        mergeRootInto(roots, `turn:${normTurnId}`, targetRootId);
      }
      let root = roots[targetRootId];
      if (!root) {
        root = { rootId: targetRootId, seq: nextSeq(), startedAt: now, executions: {} };
        roots[targetRootId] = root;
      }
      const execKey = normTurnId || PENDING_EXEC_KEY;
      const prevExec = root.executions[execKey] || null;
      if (normTurnId) delete root.executions[PENDING_EXEC_KEY];
      // Do not re-arm an already settled execution if a late streaming delta arrives out of order.
      const nextState = prevExec && prevExec.state !== 'running' ? prevExec.state : 'running';
      root.executions[execKey] = {
        turnId: normTurnId,
        state: nextState,
        text: cleanedText,
        at: Math.max(ts, prevExec?.at || 0),
        seq: prevExec?.text === cleanedText ? (prevExec.seq || nextSeq()) : nextSeq(),
      };
      roots[targetRootId] = summarizeRoot(root);
      nextKind = kind;
      hasAction = true;
    } else {
      // Legacy/direct write (e.g. direct tests or manual seed without live/finalizeTurn).
      if (Object.keys(roots).length > 0 || normTurnId || normRootId) {
        const targetId = normRootId || findRootOwningTurn(roots, normTurnId) || (normTurnId ? `turn:${normTurnId}` : '__legacy__');
        const execKey = normTurnId || ANON_EXEC_KEY;
        const prevRoot = roots[targetId];
        const prevExec = prevRoot?.executions?.[execKey] || null;
        const rootSeq = prevRoot ? prevRoot.seq : nextSeq();
        const root = prevRoot || { rootId: targetId, seq: rootSeq, startedAt: now, executions: {} };
        root.executions[execKey] = {
          turnId: normTurnId,
          state: prevExec?.state === 'running' ? 'running' : 'completed',
          text: cleanedText,
          at: Math.max(ts, prevExec?.at || 0),
          seq: prevExec?.text === cleanedText ? (prevExec.seq || nextSeq()) : nextSeq(),
        };
        roots[targetId] = summarizeRoot(root);
      } else {
        fallbackText = cleanedText;
        fallbackAt = Math.max(ts, prev?.at || 0);
        if (normTurnId) fallbackTurnId = normTurnId;
      }
      nextKind = kind;
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

  const latestAfter = pickLatestRoot(roots);
  pruneRoots(roots, latestAfter?.rootId || null);
  const derived = deriveTopLevelFromRoots(roots, fallbackText, fallbackAt, fallbackTurnId, nextKind);

  // Standalone ask-clearing drops the entry when no reply or turn state remains.
  if (clearAsk && !beginTurn && !finalizeTurn && !cancelTurn && !linkRootAlias && !Array.isArray(syncTurns)
      && !normUnreadReplyRoot && !clearUnreadReply
      && !cleanedText && !cleanedAsk
      && !derived.text && !derived.liveText && !derived.inFlight && !derived.finalizedEmptyTurnId
      && Object.keys(roots).length === 0) {
    const { [catalogKey]: _drop, ...rest } = map;
    store.yeaftSessionReplyPreviewByKey = rest;
    return true;
  }

  const nextEntry = {
    seq,
    latestRootId: derived.latestRootId,
    unreadReplyRootId: nextUnreadReplyRootId,
    roots,
    text: derived.text,
    turnId: derived.turnId,
    rootId: derived.rootId,
    kind: derived.kind,
    at: derived.at,
    liveText: derived.liveText,
    liveAt: derived.liveAt,
    liveTurnId: derived.liveTurnId,
    inFlight: derived.inFlight,
    turnStartedAt: derived.turnStartedAt,
    finalizedEmptyTurnId: derived.finalizedEmptyTurnId,
    askQuestion: nextAskQuestion,
    askRequestId: nextAskRequestId,
    askTurnId: nextAskTurnId,
    askExpiresAt: nextAskExpiresAt,
    askAt: nextAskAt,
    updatedAt: now,
  };

  if (entriesStructurallyEqual(prev, nextEntry)) {
    return false;
  }

  return writePreviewMap(store, map, catalogKey, nextEntry);
}

/**
 * Reconcile cached in-flight reply previews against an authoritative `vp_status_snapshot`.
 * Any running execution in the snapshot's scope not confirmed live by `statuses` is retired
 * cleanly so reconnects into another Session never leave stale `inFlight` previews behind.
 */
export function reconcileYeaftReplyPreviewsFromStatuses(store, {
  agentId = null,
  sessionId = null,
  statuses = [],
} = {}) {
  const map = store?.yeaftSessionReplyPreviewByKey;
  if (!map || !agentId) return false;

  const liveTurnsBySession = new Map();
  const legacyRunningSessions = new Set();
  for (const status of (Array.isArray(statuses) ? statuses : [])) {
    if (!status) continue;
    const sid = status.sessionId || status.groupId || sessionId || null;
    if (!sid) continue;
    if (Array.isArray(status.threads)) {
      for (const thread of status.threads) {
        const st = thread?.state || thread?.status;
        if (!RUNNING_VP_STATES.has(st)) continue;
        if (thread?.turnId) {
          if (!liveTurnsBySession.has(sid)) liveTurnsBySession.set(sid, new Set());
          liveTurnsBySession.get(sid).add(thread.turnId);
        } else {
          legacyRunningSessions.add(sid);
        }
      }
    } else if (RUNNING_VP_STATES.has(status.state)) {
      if (status.turnId) {
        if (!liveTurnsBySession.has(sid)) liveTurnsBySession.set(sid, new Set());
        liveTurnsBySession.get(sid).add(status.turnId);
      } else {
        legacyRunningSessions.add(sid);
      }
    }
  }

  let changed = false;
  const nextMap = { ...map };
  for (const [key, entry] of Object.entries(map)) {
    if (!key.startsWith('yeaft:')) continue;
    const sep = key.lastIndexOf(':');
    if (sep <= 6) continue;
    const entryAgentId = key.slice(6, sep);
    const entrySessionId = key.slice(sep + 1);
    if (entryAgentId !== agentId) continue;
    if (sessionId != null && entrySessionId !== sessionId) continue;
    if (!entry?.inFlight && !Object.values(entry?.roots || {}).some((r) => r?.hasLiveExecution)) continue;

    const liveTurnIds = liveTurnsBySession.get(entrySessionId) || null;
    const hasLegacyRunning = legacyRunningSessions.has(entrySessionId);
    const hasAnyRunningInSession = Boolean((liveTurnIds && liveTurnIds.size > 0) || hasLegacyRunning);

    const roots = cloneRoots(entry.roots);
    let seq = Number(entry.seq || 0);
    let entryMutated = false;
    for (const [rid, root] of Object.entries(roots)) {
      let rootTouched = false;
      for (const ex of Object.values(root.executions || {})) {
        if (!ex || ex.state !== 'running') continue;
        const stillLive = ex.turnId
          ? Boolean(hasLegacyRunning || liveTurnIds?.has(ex.turnId))
          : hasAnyRunningInSession;
        if (!stillLive) {
          ex.state = 'cancelled';
          seq += 1;
          ex.seq = seq;
          rootTouched = true;
        }
      }
      if (rootTouched) {
        roots[rid] = summarizeRoot(root);
        entryMutated = true;
      }
    }
    if (!entryMutated && entry.inFlight && !hasAnyRunningInSession) {
      entryMutated = true;
    }
    if (!entryMutated) continue;

    const hadRoots = Object.keys(entry.roots || {}).length > 0;
    const derived = deriveTopLevelFromRoots(
      roots,
      hadRoots ? '' : (entry.inFlight ? '' : entry.text),
      hadRoots ? 0 : (entry.inFlight ? 0 : entry.at),
      hadRoots ? null : (entry.inFlight ? null : entry.turnId),
      entry.kind,
    );
    nextMap[key] = {
      ...entry,
      seq,
      latestRootId: derived.latestRootId,
      roots,
      text: derived.text,
      turnId: derived.turnId,
      rootId: derived.rootId,
      at: derived.at,
      liveText: derived.liveText,
      liveAt: derived.liveAt,
      liveTurnId: derived.liveTurnId,
      inFlight: derived.inFlight,
      turnStartedAt: derived.turnStartedAt,
      finalizedEmptyTurnId: derived.finalizedEmptyTurnId,
      updatedAt: Date.now(),
    };
    changed = true;
  }

  if (!changed) return false;
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
 * Clear pending AskUser previews and ephemeral in-flight live state for an Agent
 * (or all Agents when agentId is falsy) without discarding completed reply previews.
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
      || entry?.liveTurnId
      || Object.values(entry?.roots || {}).some((r) => r?.hasLiveExecution),
    );
    if (matchesAgent && hasEphemeralRuntime) {
      changed = true;
      const roots = cloneRoots(entry.roots);
      let seq = Number(entry.seq || 0);
      for (const [rid, root] of Object.entries(roots)) {
        let rootTouched = false;
        for (const ex of Object.values(root.executions || {})) {
          if (ex && ex.state === 'running') {
            ex.state = 'cancelled';
            seq += 1;
            ex.seq = seq;
            rootTouched = true;
          }
        }
        if (rootTouched) {
          const summarized = summarizeRoot(root);
          if (!summarized.hasLiveExecution && !summarized.finalizedText && !summarized.finalizedEmpty) {
            delete roots[rid];
          } else {
            roots[rid] = summarized;
          }
        }
      }
      const hadRoots = Object.keys(entry.roots || {}).length > 0;
      const derived = deriveTopLevelFromRoots(
        roots,
        hadRoots ? '' : (entry.inFlight ? '' : entry.text),
        hadRoots ? 0 : (entry.inFlight ? 0 : entry.at),
        hadRoots ? null : (entry.inFlight ? null : entry.turnId),
        entry.kind,
      );
      if (derived.text || derived.finalizedEmptyTurnId || Object.keys(roots).length > 0) {
        nextMap[key] = {
          ...entry,
          seq,
          latestRootId: derived.latestRootId,
          roots,
          text: derived.text,
          turnId: derived.turnId,
          rootId: derived.rootId,
          at: derived.at,
          liveText: '',
          liveAt: 0,
          liveTurnId: null,
          inFlight: false,
          finalizedEmptyTurnId: derived.finalizedEmptyTurnId,
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
