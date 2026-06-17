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

const { defineStore } = Pinia;

import { sortSessionsByActivity } from './helpers/session-order.js';
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
    sessions: {},       // keyed by session id
    /** @type {string[]} */
    sessionOrder: [],   // render order (matches snapshot order)
    /** @type {string|null} */
    activeSessionId: null,
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
      // Global pinned sessions are grouped first; both groups sort by real
      // activity time descending on initial load/refresh and after true updates.
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
        if (pinnedIds.has(s.id) || s.pinned) pinned.push(s);
        else unpinned.push(s);
      }
      return [...sortSessionsByActivity(pinned), ...sortSessionsByActivity(unpinned)];
    sessionCount(state) {
      return state.sessionOrder.length;
    },
    sessionById: (state) => (id) => state.sessions[id] || null,
    activeSession(state) {
      return state.activeSessionId ? (state.sessions[state.activeSessionId] || null) : null;
    },
    isEmpty(state) {
      return state.sessionOrder.length === 0;
    },
    /**
     * True iff the active session has no roster members — the UI uses this to
     * drive the "invite VP" modal on the `no_default_vp` path.
     */
    activeNeedsInvite(state) {
      const s = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
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
          nextMap[s.id] = this._normalize(s, null, isPinnedRow(this.sessions[s.id]));
          nextOrder.push(s.id);
        }
        this.sessions = nextMap;
        this.sessionOrder = nextOrder;
      } else {
        // Per-agent replacement: drop only rows owned by this agent,
        // then merge in the new ones, preserving snapshot order.
        const nextMap = { ...this.sessions };
        const incomingIds = new Set();
        for (const s of arr) {
          if (!s || !s.id) continue;
          incomingIds.add(s.id);
          nextMap[s.id] = this._normalize(s, agentId, isPinnedRow(this.sessions[s.id]));
        }
        // Remove this agent's previously-known sessions that aren't in
        // the new snapshot (handles delete / archive).
        for (const id of this.sessionOrder) {
          const prev = this.sessions[id];
          if (prev && prev.agentId === agentId && !incomingIds.has(id)) {
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
          if (s && s.id && nextMap[s.id] && !preservedSet.has(s.id)) {
            appended.push(s.id);
          }
        }
        this.sessions = nextMap;
        this.sessionOrder = [...preserved, ...appended];
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
      const lastViewedSession = lastViewed ? this.sessions[lastViewed] : null;
      const lastViewedMatchesAgent = lastViewedSession
        && (!agentId || lastViewedSession.agentId === agentId);
      if (this.activeSessionId && !this.sessions[this.activeSessionId]) {
        this.activeSessionId = lastViewedMatchesAgent
          ? lastViewed
          : (this.sessionOrder[0] || null);
      } else if (!this.activeSessionId && this.sessionOrder.length > 0) {
        this.activeSessionId = lastViewedMatchesAgent
          ? lastViewed
          : this.sessionOrder[0];
      }
      // Sanitize the chat store's parallel filter so a persisted
      // yeaftActiveSessionFilter pointing at a now-deleted session does not
      // render the main pane as empty until the user clicks.
      const chat = _getChatStoreSafe();
      if (chat) {
        if (chat.yeaftActiveSessionFilter && !this.sessions[chat.yeaftActiveSessionFilter]) {
          chat.yeaftActiveSessionFilter = lastViewedMatchesAgent
            ? lastViewed
            : (this.sessionOrder[0] || null);
        } else if (!chat.yeaftActiveSessionFilter && lastViewedMatchesAgent) {
          chat.yeaftActiveSessionFilter = lastViewed;
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
          const row = this.sessions[s.id];
          if (row && row.pinned) pinnedInSnapshot.add(s.id);
        }
        const isOwnedByAgent = (id) => {
          const row = this.sessions[id];
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
      const prev = this.sessions[sessionId];
      if (!prev) {
        const stub = this._normalize({
          id: sessionId,
          name: payload.name || sessionId,
          roster: Array.isArray(payload.roster) ? payload.roster : [],
          defaultVpId: payload.defaultVpId || null,
        });
        this.sessions[sessionId] = stub;
        this.sessionOrder.push(sessionId);
        return;
      }
      this.sessions[sessionId] = {
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
        this.setActive(session.id);
      }
      const opSessionId = result.sessionId || result.groupId;
      if (result.ok && (result.op === 'archive' || result.op === 'delete') && opSessionId) {
        delete this.sessions[opSessionId];
        this.sessionOrder = this.sessionOrder.filter(id => id !== opSessionId);
        if (this.activeSessionId === opSessionId) {
          this.activeSessionId = this.sessionOrder[0] || null;
        }
      }
      if (result.ok && result.op === 'update_config' && opSessionId) {
        const prev = this.sessions[opSessionId];
        if (prev) {
          this.sessions[opSessionId] = {
            ...prev,
            config: result.config && typeof result.config === 'object' ? { ...result.config } : {},
          };
        }
      }
    },

    /** Insert or merge a single session record. */
    applySnapshotUpsert(session, agentId = null) {
      if (!session || !session.id) return;
      const existed = !!this.sessions[session.id];
      const effectiveAgentId = agentId || (this.sessions[session.id] && this.sessions[session.id].agentId) || null;
      const prev = this.sessions[session.id] || {};
      this.sessions[session.id] = {
        ...prev,
        ...this._normalize(session, effectiveAgentId, isPinnedRow(prev)),
      };
      if (!existed) this.sessionOrder.push(session.id);
    },

    setActive(sessionId) {
      if (sessionId && this.sessions[sessionId]) {
        this.activeSessionId = sessionId;
      } else {
        this.activeSessionId = null;
      }
     * Move the selected session to the top of its visual group while preserving
     * the relative order of every other row. This matches Chat session list
     * activation: selecting C in [A, B, C, D] yields [C, A, B, D], not a swap.
     *
     * Pinned rows stay in the pinned block; unpinned rows stay below pinned.
     */
    moveSessionToFront(sessionId) {
      if (!sessionId || !this.sessions[sessionId]) return;
      const currentIndex = this.sessionOrder.indexOf(sessionId);
      if (currentIndex <= 0) return;

      const chat = _getChatStoreSafe();
      const pinnedIds = (chat && Array.isArray(chat.pinnedSessions))
        ? new Set(chat.pinnedSessions)
        : new Set();
      for (const id of this.sessionOrder) {
        const row = this.sessions[id];
        if (row && row.pinned) pinnedIds.add(id);
      }
      const targetPinned = pinnedIds.has(sessionId);

      const nextOrder = this.sessionOrder.filter(id => id !== sessionId);
      const insertAt = targetPinned
        ? 0
        : nextOrder.findIndex(id => !pinnedIds.has(id));
      if (insertAt === -1) nextOrder.push(sessionId);
      else nextOrder.splice(insertAt, 0, sessionId);
      this.sessionOrder = nextOrder;
    },

    /**
     * Apply the server-confirmed pin state for one Yeaft session row.
     * The chat store still owns the cross-provider `pinnedSessions` cache;
     * this metadata is the session-list source needed for DB hydration,
     * snapshot reconciliation, and stable pinned-first movement.
     */
    applyPinState(sessionId, pinned) {
      if (!sessionId || !this.sessions[sessionId]) return;
      this.sessions[sessionId] = {
        ...this.sessions[sessionId],
        pinned: !!pinned,
      };
    },

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
      };
    },
  },
});
