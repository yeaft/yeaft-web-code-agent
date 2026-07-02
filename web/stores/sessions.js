/**
 * sessions.js — Session store (renamed from groups; web rename W2).
 *
 * Mirrors vp.js shape. Receives:
 *   group_list_updated      — full snapshot (create/rename/archive + session_ready replay)
 *   group_roster_changed    — roster/defaultVpId/name delta (addMember/removeMember/setDefault)
 *   group_crud_result       — op reply with `requestId` + ok/error
 *
 * Wire-type back-compat: the agent still emits `group_*` envelope types
 * (it dual-emits internally). Inside the web layer we call them sessions.
 * Inbound payloads may carry either `sessionId` (new) or `groupId` (legacy);
 * both are accepted, prefer sessionId.
 *
 * `activeSessionId` is a pure UI pointer (which session the main pane shows).
 */

import { compareSessionsByActivity } from './helpers/session-order.js';

const MANUAL_SESSION_ORDER_KEY = 'yeaft-session-order-by-agent';
const MANUAL_SESSION_ORDER_ALL_KEY = 'yeaft-session-order-global';

function readManualSessionOrder() {
  try {
    if (typeof localStorage === 'undefined') return {};
    const parsed = JSON.parse(localStorage.getItem(MANUAL_SESSION_ORDER_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { return {}; }
}

function writeManualSessionOrder(value) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MANUAL_SESSION_ORDER_KEY, JSON.stringify(value && typeof value === 'object' ? value : {}));
    }
  } catch (_) {}
}

function readManualGlobalSessionOrder() {
  try {
    if (typeof localStorage === 'undefined') return [];
    return normalizeOrderList(JSON.parse(localStorage.getItem(MANUAL_SESSION_ORDER_ALL_KEY) || '[]'));
  } catch (_) { return []; }
}

function writeManualGlobalSessionOrder(value) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MANUAL_SESSION_ORDER_ALL_KEY, JSON.stringify(normalizeOrderList(value)));
    }
  } catch (_) {}
}

function sessionOrderKey(agentId, sessionId) {
  return `${agentId || ''}\u001f${sessionId || ''}`;
}

function sessionKeyFromRow(row) {
  return row && row.agentId && row.id ? sessionOrderKey(row.agentId, row.id) : '';
}

function storeKeyFor(agentId, sessionId) {
  if (!sessionId) return '';
  return agentId ? sessionOrderKey(agentId, sessionId) : String(sessionId);
}

function normalizeSessionId(value) {
  return typeof value === 'string' ? value : String(value || '');
}

function findSessionKey(state, sessionId, agentId = null) {
  const id = normalizeSessionId(sessionId);
  if (!id) return '';
  const directKey = storeKeyFor(agentId, id);
  if (directKey && state.sessions[directKey]) return directKey;
  if (state.sessions[id]) return id;
  if (state.activeSessionKey && state.sessions[state.activeSessionKey]?.id === id) return state.activeSessionKey;
  const keys = state.sessionOrder.filter(key => state.sessions[key]?.id === id);
  if (agentId) {
    const byAgent = keys.find(key => state.sessions[key]?.agentId === agentId);
    if (byAgent) return byAgent;
  }
  const chat = _getChatStoreSafe();
  if (chat?.currentAgent) {
    const current = keys.find(key => state.sessions[key]?.agentId === chat.currentAgent);
    if (current) return current;
  }
  return keys[0] || '';
}

function normalizeActiveKey(state, sessionId, agentId = null) {
  return findSessionKey(state, sessionId, agentId) || '';
}

function normalizeOrderList(ids) {
  const out = [];
  const seen = new Set();
  for (const rawId of Array.isArray(ids) ? ids : []) {
    const id = typeof rawId === 'string' ? rawId : String(rawId || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function applyManualOrder(ids, orderedIds) {
  const current = normalizeOrderList(ids);
  const currentSet = new Set(current);
  const ordered = normalizeOrderList(orderedIds).filter(id => currentSet.has(id));
  const orderedSet = new Set(ordered);
  return [...ordered, ...current.filter(id => !orderedSet.has(id))];
}

export const __test__ = {
  MANUAL_SESSION_ORDER_KEY,
  MANUAL_SESSION_ORDER_ALL_KEY,
  normalizeOrderList,
  applyManualOrder,
  sessionOrderKey,
};

const { defineStore } = Pinia;

/**
 * Yeaft session pin state may arrive from two server paths:
 * - live agent snapshot decoration: `pinned`
 * - server DB hydration rows: `isPinned` (legacy mapped DB field)
 * Accept both so a reload cannot silently drop persisted pins.
 */
function isPinnedRow(s, fallback = false) {
  if (!s || typeof s !== 'object') return !!fallback;
  if (Object.prototype.hasOwnProperty.call(s, 'pinned')) return s.pinned === true;
  if (Object.prototype.hasOwnProperty.call(s, 'isPinned')) return s.isPinned === true;
  return !!fallback;
}

function isRunningRow(s) {
  if (!s || typeof s !== 'object') return false;
  return s.running === true || s.active === true || s.isActive === true || s.isRunning === true;
}

function latestActivityValue(s) {
  if (!s || typeof s !== 'object') return 0;
  const value = s.latestActivityAt || s.lastActivityAt || s.lastMessageAt || s.updatedAt || 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Resolve the shared chat store iff Pinia is wired up. Returns null in
 * test/SSR environments that don't bootstrap window.Pinia, so every
 * call site can degrade to a no-op without a try/catch of its own.
 *
 * The chat store owns `pinnedSessions` + the `pinned-sessions`
 * localStorage cache; this store treats it as read/write through the
 * `applyServerPinSnapshot` action it exposes.
 */
function _getChatStoreSafe() {
  try {
    if (typeof window !== 'undefined'
        && window.Pinia
        && typeof window.Pinia.useChatStore === 'function') {
      return window.Pinia.useChatStore();
    }
  } catch (_) { /* no-pinia env (tests / SSR) */ }
  return null;
}

export const useSessionsStore = defineStore('sessions', {
  state: () => ({
    /** @type {Record<string, object>} */
    sessions: {},       // keyed by agentId + session id when agentId is known
    /** @type {string[]} */
    sessionOrder: [],   // render order (matches snapshot order)
    /** @type {string|null} */
    activeSessionId: null,
    /** @type {string|null} */
    activeSessionKey: null,
    lastSnapshotAt: 0,
    /**
     * Most recent CRUD result for the UI to surface as toast/modal error.
     * Shape: { op, ok, error?:{code,sessionId,message}, at }
     */
    lastCrudResult: null,
    /** Pending request ids keyed by client-side requestId → op name. */
    pending: {},
  }),

  getters: {
    sessionList(state) {
      const all = state.sessionOrder.map(id => state.sessions[id]).filter(Boolean);
      // Selection is a pure UI pointer. It must not change list order.
      // Global pinned sessions are grouped first; manual sortOrder wins inside
      // each group, then activity time is used for rows without manual order.
      const chat = _getChatStoreSafe();
      const pinnedIds = (chat && Array.isArray(chat.pinnedSessions))
        ? new Set(chat.pinnedSessions)
        : new Set();
      for (const s of all) {
        if (s && s.id && s.pinned) pinnedIds.add(s.id);
      }
      const pinned = [];
      const unpinned = [];
      for (const s of all) {
        // Consult the row metadata too. This keeps pinned-first sorting
        // correct immediately after server hydration, before chatStore's
        // shared `pinnedSessions` cache has been reconciled.
        if (s.pinned || (!s.agentId && pinnedIds.has(s.id))) pinned.push(s);
        else unpinned.push(s);
      }
      const sortRows = (rows) => [...rows].sort((a, b) => {
        const aManual = Number.isFinite(a?.sortOrder) ? a.sortOrder : Number.MAX_SAFE_INTEGER;
        const bManual = Number.isFinite(b?.sortOrder) ? b.sortOrder : Number.MAX_SAFE_INTEGER;
        if (aManual !== bManual) return aManual - bManual;
        return compareSessionsByActivity(a, b);
      });
      const orderedRows = [...sortRows(pinned), ...sortRows(unpinned)];
      const globalOrder = readManualGlobalSessionOrder();
      if (globalOrder.length === 0) return orderedRows;
      const globalIndex = new Map(globalOrder.map((key, index) => [key, index]));
      return orderedRows.sort((a, b) => {
        const aIndex = globalIndex.has(sessionKeyFromRow(a)) ? globalIndex.get(sessionKeyFromRow(a)) : Number.MAX_SAFE_INTEGER;
        const bIndex = globalIndex.has(sessionKeyFromRow(b)) ? globalIndex.get(sessionKeyFromRow(b)) : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;
        return 0;
      });
    },
    sessionCount(state) {
      return state.sessionOrder.length;
    },
    sessionById: (state) => (id, agentId = null) => {
      const key = findSessionKey(state, id, agentId);
      return key ? (state.sessions[key] || null) : null;
    },
    activeSession(state) {
      return state.activeSessionKey ? (state.sessions[state.activeSessionKey] || null) : null;
    },
    hasLoadedSnapshot(state) {
      return state.lastSnapshotAt > 0;
    },
    isEmpty(state) {
      return state.sessionOrder.length === 0;
    },
    /**
     * True iff the active session has no roster members — the UI uses this to
     * drive the "invite VP" modal on the `no_default_vp` path.
     */
    activeNeedsInvite(state) {
      const s = state.activeSessionKey ? state.sessions[state.activeSessionKey] : null;
      if (!s) return false;
      return !s.defaultVpId && (!Array.isArray(s.roster) || s.roster.length === 0);
    },
  },

  actions: {
    /**
     * Replace the slice of sessions owned by `agentId` from a
     * `group_list_updated` / `session_list_updated` snapshot. Sessions
     * from other agents are kept untouched, so the unified sidebar can
     * aggregate sessions across all online agents.
     *
     * When `agentId` is missing (older agent that hasn't been upgraded
     * to stamp it), falls back to the legacy whole-store replacement
     * for back-compat.
     */
    applySnapshot(sessions, agentId = null) {
      const arr = Array.isArray(sessions) ? sessions : [];
      if (!agentId) {
        // Legacy path — single-agent stores only. In a mixed deployment
        // where one upgraded agent stamps agentId and one legacy agent
        // doesn't, the legacy whole-replace would obliterate the
        // upgraded agent's rows. Guard: if any current row already
        // carries an agentId, treat this unstamped snapshot as
        // unsafe and skip it rather than nuke cross-agent state.
        const hasStampedRow = Object.values(this.sessions).some(s => s && s.agentId);
        if (hasStampedRow) return;
        const nextMap = {};
        const nextOrder = [];
        for (const s of arr) {
          if (!s || !s.id) continue;
          const key = storeKeyFor(null, s.id);
          nextMap[key] = this._normalize(s, null, isPinnedRow(this.sessions[key]));
          nextOrder.push(key);
        }
        this.sessions = nextMap;
        this.sessionOrder = nextOrder;
      } else {
        // Per-agent replacement: drop only rows owned by this agent,
        // then merge in the new ones, preserving snapshot order.
        const nextMap = { ...this.sessions };
        const incomingKeys = new Set();
        for (const s of arr) {
          if (!s || !s.id) continue;
          const key = storeKeyFor(agentId, s.id);
          incomingKeys.add(key);
          nextMap[key] = this._normalize(s, agentId, isPinnedRow(this.sessions[key]));
        }
        // Remove this agent's previously-known sessions that aren't in
        // the new snapshot (handles delete / archive).
        for (const id of this.sessionOrder) {
          const prev = this.sessions[id];
          if (prev && prev.agentId === agentId && !incomingKeys.has(id)) {
            delete nextMap[id];
          }
        }
        // fix-yeaft-session-list-and-menu: stable order across cross-agent
        // snapshots. Previously this branch was:
        //   const otherAgents = <ids belonging to other agents>;
        //   const thisAgent   = <every id this snapshot carries>;
        //   sessionOrder = [...otherAgents, ...thisAgent];
        // which physically moved the current agent's entire row block to
        // the end of the list whenever any agent pushed a snapshot. The
        // user-visible bug: switching agents (or just receiving a roster
        // delta echo) would shuffle the sidebar so the user's mental map
        // of "where is session X" no longer matched what they saw.
        //
        // New rule: positional identity is per-id, not per-agent. Any
        // id that was already in sessionOrder keeps its slot. Only ids
        // that are genuinely new (never seen before, in this snapshot
        // for the first time) get appended at the end, in the order
        // they arrive in the snapshot.
        const preserved = this.sessionOrder.filter(id => nextMap[id]);
        const preservedSet = new Set(preserved);
        const appended = [];
        for (const s of arr) {
          if (!s || !s.id) continue;
          const key = storeKeyFor(agentId, s.id);
          if (nextMap[key] && !preservedSet.has(key)) {
            appended.push(key);
          }
        }
        this.sessions = nextMap;
        let nextOrder = [...preserved, ...appended];
        const globalManualOrder = readManualGlobalSessionOrder();
        if (globalManualOrder.length > 0) {
          const nextIdsByKey = new Map(nextOrder
            .map(id => [sessionKeyFromRow(nextMap[id]), id])
            .filter(([key]) => key));
          const orderedIds = globalManualOrder.map(key => nextIdsByKey.get(key)).filter(Boolean);
          const orderedSet = new Set(orderedIds);
          nextOrder = [...orderedIds, ...nextOrder.filter(id => !orderedSet.has(id))];
          const globalIndex = new Map(globalManualOrder.map((key, index) => [key, index]));
          for (const id of nextOrder) {
            const key = sessionKeyFromRow(nextMap[id]);
            if (key && globalIndex.has(key)) {
              nextMap[id] = { ...nextMap[id], sortOrder: globalIndex.get(key) };
            }
          }
        }
        if (agentId) {
          const manualByAgent = readManualSessionOrder();
          const manualOrder = normalizeOrderList(manualByAgent[agentId]);
          if (manualOrder.length > 0) {
            const manualKeys = manualOrder.map(id => storeKeyFor(agentId, id));
            const manualSet = new Set(manualKeys);
            const nextForAgent = applyManualOrder(
              nextOrder.filter(id => nextMap[id]?.agentId === agentId),
              manualKeys,
            );
            const oldHasAgentSlots = this.sessionOrder.some(id => nextMap[id]?.agentId === agentId);
            let manualCursor = 0;
            if (oldHasAgentSlots) {
              nextOrder = this.sessionOrder
                .filter(id => nextMap[id])
                .map((id) => (nextMap[id]?.agentId === agentId ? nextForAgent[manualCursor++] : id))
                .concat(nextForAgent.slice(manualCursor));
            } else {
              nextOrder = nextOrder.map((id) => (nextMap[id]?.agentId === agentId ? nextForAgent[manualCursor++] : id));
            }
            const manualIndex = new Map(manualKeys.map((id, index) => [id, index]));
            for (const id of nextForAgent) {
              if (nextMap[id] && manualSet.has(id)) {
                nextMap[id] = { ...nextMap[id], sortOrder: manualIndex.get(id) };
              }
            }
          }
        }
        this.sessionOrder = nextOrder;
      }
      this.lastSnapshotAt = Date.now();
      // fix-yeaft-session-server-persistence: prefer the user's
      // last-viewed yeaft session over a blind `sessionOrder[0]`
      // fall-back. This is what stops "switch agent + reload" from
      // arbitrarily landing on some other agent's first session
      // (the phantom-default-group bug).
      let lastViewed = null;
      try { lastViewed = localStorage.getItem('lastViewedYeaftSession') || null; }
      catch (_) {}
      // Only trust lastViewed when it belongs to this agent's snapshot —
      // cross-agent fallback is the "create-in-B reverts to A" regression.
      const lastViewedKey = lastViewed ? findSessionKey(this, lastViewed, agentId) : '';
      const lastViewedSession = lastViewedKey ? this.sessions[lastViewedKey] : null;
      const lastViewedMatchesAgent = lastViewedSession
        && (!agentId || lastViewedSession.agentId === agentId);
      const runningSessionKey = this.sessionOrder
        .filter(id => this.sessions[id] && (!agentId || this.sessions[id].agentId === agentId) && this.sessions[id].running)
        .sort((a, b) => latestActivityValue(this.sessions[b]) - latestActivityValue(this.sessions[a]))[0] || null;
      const runningSessionId = runningSessionKey ? this.sessions[runningSessionKey]?.id : null;
      const firstVisibleSession = this.sessionList[0] || null;
      const firstVisibleSessionId = firstVisibleSession?.id || null;
      const firstVisibleSessionKey = firstVisibleSessionId ? findSessionKey(this, firstVisibleSessionId, firstVisibleSession?.raw?.agentId || null) : '';
      const fallbackActiveId = runningSessionId || (lastViewedMatchesAgent ? lastViewed : null) || firstVisibleSessionId;
      const fallbackActiveKey = runningSessionKey || (lastViewedMatchesAgent ? lastViewedKey : '') || firstVisibleSessionKey || normalizeActiveKey(this, fallbackActiveId, agentId);
      const activeAgentId = this.activeSessionKey ? this.sessions[this.activeSessionKey]?.agentId : null;
      if (this.activeSessionId && !findSessionKey(this, this.activeSessionId, activeAgentId)) {
        this.activeSessionId = fallbackActiveId;
        this.activeSessionKey = fallbackActiveKey || null;
      } else if (!this.activeSessionId && this.sessionOrder.length > 0) {
        this.activeSessionId = fallbackActiveId;
        this.activeSessionKey = fallbackActiveKey || null;
      } else if (this.activeSessionId) {
        this.activeSessionKey = normalizeActiveKey(this, this.activeSessionId, activeAgentId) || this.activeSessionKey;
      }
      // Sanitize the chat store's parallel filter so a persisted
      // yeaftActiveSessionFilter pointing at a now-deleted session does not
      // render the main pane as empty until the user clicks. If Yeaft is
      // already visible, go through chat.setActiveSessionFilter() instead of
      // assigning the field directly: the first default selection must trigger
      // the same history/model bootstrap as a manual sidebar click.
      const chat = _getChatStoreSafe();
      if (chat) {
        if (agentId) {
          const nextSessionAgents = { ...(chat.yeaftSessionAgentById || {}) };
          for (const s of arr) {
            if (s && s.id && !nextSessionAgents[s.id]) nextSessionAgents[s.id] = agentId;
          }
          chat.yeaftSessionAgentById = nextSessionAgents;
        }
        const selectedSessionId = this.activeSessionId || fallbackActiveId;
        let nextFilterId = null;
        if (chat.yeaftActiveSessionFilter && !findSessionKey(this, chat.yeaftActiveSessionFilter)) {
          nextFilterId = selectedSessionId;
        } else if (!chat.yeaftActiveSessionFilter && selectedSessionId) {
          nextFilterId = selectedSessionId;
        }
        if (nextFilterId) {
          if (chat.currentView === 'yeaft' && typeof chat.setActiveSessionFilter === 'function') {
            chat.setActiveSessionFilter(nextFilterId, { force: true });
          } else {
            chat.yeaftActiveSessionFilter = nextFilterId;
          }
          this.activeSessionKey = normalizeActiveKey(this, nextFilterId) || this.activeSessionKey;
        }
      }
      // fix-yeaft-session-list-and-menu: mirror server-decorated pin
      // state from this snapshot into chatStore.pinnedSessions so the
      // shared pinnedSessions array is the single source of truth for
      // both chat and yeaft sort logic. Scoped per-agent: ids belonging
      // to a *different* agent are left alone (their owning agent's
      // snapshot will reconcile them on its own pass), so concurrent
      // pin state across agents stays correct.
      //
      // `pinnedSessions` + its localStorage cache are *chat-store-owned* —
      // we delegate to `chat.applyServerPinSnapshot` so this store does
      // NOT become a second writer of that state.
      //
      // NOTE: This relies on `this.sessions` already being the
      // post-snapshot map (committed above by the per-agent / legacy
      // branch). The ownership predicate consults `this.sessions[id]`
      // to ask "is this pinned id one of *this agent's* rows?".
      if (chat && typeof chat.applyServerPinSnapshot === 'function') {
        const pinnedInSnapshot = new Set();
        for (const s of arr) {
          if (!s || !s.id) continue;
          const key = storeKeyFor(agentId, s.id);
          const row = this.sessions[key];
          if (row && row.pinned) pinnedInSnapshot.add(s.id);
        }
        const isOwnedByAgent = (id) => {
          const key = findSessionKey(this, id, agentId);
          const row = key ? this.sessions[key] : null;
          // Unknown id (chat session or not in this store) → foreign.
          if (!row) return false;
          // Different agent's row → foreign, leave alone.
          return row.agentId === agentId;
        };
        chat.applyServerPinSnapshot(agentId, pinnedInSnapshot, isOwnedByAgent);
      }
    },

    /** Apply a `group_roster_changed` delta (in-place merge). */
    applyRosterChange(payload) {
      if (!payload) return;
      const sessionId = payload.sessionId || payload.groupId;
      if (!sessionId) return;
      const agentId = payload.agentId || null;
      const key = findSessionKey(this, sessionId, agentId) || storeKeyFor(agentId, sessionId);
      const prev = this.sessions[key];
      if (!prev) {
        const stub = this._normalize({
          id: sessionId,
          name: payload.name || sessionId,
          roster: Array.isArray(payload.roster) ? payload.roster : [],
          defaultVpId: payload.defaultVpId || null,
        }, agentId);
        this.sessions[key] = stub;
        this.sessionOrder.push(key);
        return;
      }
      this.sessions[key] = {
        ...prev,
        name: payload.name || prev.name,
        roster: Array.isArray(payload.roster) ? payload.roster.slice() : prev.roster,
        defaultVpId: payload.defaultVpId != null ? payload.defaultVpId : prev.defaultVpId,
        announcement: typeof payload.announcement === 'string' ? payload.announcement : prev.announcement,
      };
    },

    /** Record a `group_crud_result` for UI feedback. */
    applyCrudResult(result, agentId = null) {
      if (!result) return;
      this.lastCrudResult = { ...result, at: Date.now() };
      if (result.requestId && this.pending[result.requestId]) {
        delete this.pending[result.requestId];
      }
      if (result.ok && result.op === 'list' && Array.isArray(result.sessions)) {
        this.applySnapshot(result.sessions, agentId);
      }
      const session = result.session || result.group || null;
      if (result.ok && result.op === 'create' && session && session.id) {
        this.applySnapshotUpsert(session, agentId);
        this.setActive(session.id, agentId);
      }
      const opSessionId = result.sessionId || result.groupId;
      const opKey = opSessionId ? findSessionKey(this, opSessionId, agentId) : '';
      if (result.ok && (result.op === 'archive' || result.op === 'delete') && opSessionId) {
        if (opKey) delete this.sessions[opKey];
        this.sessionOrder = this.sessionOrder.filter(id => id !== opKey);
        if (this.activeSessionKey === opKey || this.activeSessionId === opSessionId) {
          this.activeSessionKey = this.sessionOrder[0] || null;
          this.activeSessionId = this.activeSessionKey ? this.sessions[this.activeSessionKey]?.id || null : null;
        }
      }
      if (result.ok && result.op === 'update_config' && opSessionId) {
        const prev = opKey ? this.sessions[opKey] : null;
        if (prev) {
          this.sessions[opKey] = {
            ...prev,
            config: result.config && typeof result.config === 'object' ? { ...result.config } : {},
          };
        }
      }
    },

    /** Insert or merge a single session record. */
    applySnapshotUpsert(session, agentId = null) {
      if (!session || !session.id) return;
      const effectiveAgentId = agentId || session.agentId || null;
      const key = findSessionKey(this, session.id, effectiveAgentId) || storeKeyFor(effectiveAgentId, session.id);
      const existed = !!this.sessions[key];
      const prev = this.sessions[key] || {};
      this.sessions[key] = {
        ...prev,
        ...this._normalize(session, effectiveAgentId, isPinnedRow(prev)),
      };
      if (!existed) this.sessionOrder.push(key);
    },

    setActive(sessionId, agentId = null) {
      const key = findSessionKey(this, sessionId, agentId);
      if (sessionId && key && this.sessions[key]) {
        this.activeSessionId = sessionId;
        this.activeSessionKey = key;
      } else {
        this.activeSessionId = null;
        this.activeSessionKey = null;
      }
    },

    reorderSessionsForAgent(agentId, orderedIds) {
      if (!agentId) return [];
      const idsForAgent = this.sessionOrder.filter(id => this.sessions[id]?.agentId === agentId);
      const nextForAgent = applyManualOrder(idsForAgent, orderedIds.map(id => storeKeyFor(agentId, id)));
      if (nextForAgent.length === 0) return [];
      const nextByAgent = new Map(nextForAgent.map((id, index) => [id, index]));
      let cursor = 0;
      this.sessionOrder = this.sessionOrder.map((id) => (
        this.sessions[id]?.agentId === agentId ? nextForAgent[cursor++] : id
      ));
      for (const id of nextForAgent) {
        this.sessions[id] = { ...this.sessions[id], sortOrder: nextByAgent.get(id) };
      }
      const manualByAgent = readManualSessionOrder();
      const nextSessionIds = nextForAgent.map(id => this.sessions[id]?.id).filter(Boolean);
      manualByAgent[agentId] = nextSessionIds;
      writeManualSessionOrder(manualByAgent);
      return nextSessionIds;
    },

    reorderSessionsGlobally(orderedKeys) {
      const currentKeys = this.sessionOrder
        .map(id => sessionKeyFromRow(this.sessions[id]))
        .filter(Boolean);
      const nextKeys = applyManualOrder(currentKeys, orderedKeys);
      if (nextKeys.length === 0) return [];
      const idByKey = new Map(this.sessionOrder
        .map(id => [sessionKeyFromRow(this.sessions[id]), id])
        .filter(([key]) => key));
      const nextIds = nextKeys.map(key => idByKey.get(key)).filter(Boolean);
      const nextIdSet = new Set(nextIds);
      this.sessionOrder = [...nextIds, ...this.sessionOrder.filter(id => !nextIdSet.has(id))];
      const keyIndex = new Map(nextKeys.map((key, index) => [key, index]));
      for (const id of this.sessionOrder) {
        const key = sessionKeyFromRow(this.sessions[id]);
        if (key && keyIndex.has(key)) {
          this.sessions[id] = { ...this.sessions[id], sortOrder: keyIndex.get(key) };
        }
      }
      writeManualGlobalSessionOrder(nextKeys);
      return nextKeys.map((key) => {
        const id = idByKey.get(key);
        const row = id ? this.sessions[id] : null;
        return row ? { agentId: row.agentId, sessionId: row.id } : null;
      }).filter(Boolean);
    },

    /**
     * Apply the server-confirmed pin state for one Yeaft session row.
     * The chat store still owns the cross-provider `pinnedSessions` cache;
     * this metadata is the session-list source needed for DB hydration,
     * snapshot reconciliation, and stable pinned-first movement.
     */
    applyPinState(sessionId, pinned, agentId = null) {
      const key = findSessionKey(this, sessionId, agentId);
      if (!sessionId || !key || !this.sessions[key]) return;
      this.sessions[key] = {
        ...this.sessions[key],
        pinned: !!pinned,
      };
    },

    /** Register a request-id so components can await ok/error. */
    markPending(requestId, op) {
      if (!requestId) return;
      this.pending[requestId] = op;
    },

    clearLastResult() {
      this.lastCrudResult = null;
    },

    _normalize(s, agentId = null, fallbackPinned = false) {
      return {
        id: s.id,
        name: s.name || s.id,
        roster: Array.isArray(s.roster) ? s.roster.slice() : [],
        defaultVpId: s.defaultVpId || null,
        announcement: typeof s.announcement === 'string' ? s.announcement : '',
        config: s.config && typeof s.config === 'object' ? { ...s.config } : {},
        workDir: typeof s.workDir === 'string' ? s.workDir : '',
        createdAt: s.createdAt || null,
        updatedAt: s.updatedAt || null,
        lastMessageAt: s.lastMessageAt || null,
        running: isRunningRow(s),
        active: isRunningRow(s),
        runningVpCount: Number.isFinite(Number(s.runningVpCount)) ? Number(s.runningVpCount) : 0,
        latestActivityAt: s.latestActivityAt || s.lastActivityAt || s.lastMessageAt || null,
        // Cross-agent unified sidebar: each row stamped with the
        // owning agent so the UI can render the agent badge + route
        // CRUD ops to the right agent. May be null on the legacy
        // single-agent path.
        agentId: agentId || s.agentId || null,
        // fix-yeaft-session-list-and-menu: pin state arrives via the
        // server-decorated snapshot (server/handlers/agent-output.js
        // stamps `pinned:true` from the yeaft_sessions DB row). Mirror
        // it onto the normalized row so applySnapshot can sync into
        // chatStore.pinnedSessions in one pass.
        pinned: isPinnedRow(s, fallbackPinned),
        sortOrder: Number.isFinite(s.sortOrder) ? s.sortOrder : null,
      };
    },
  },
});
