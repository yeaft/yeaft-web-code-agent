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
      // fix-yeaft-session-list-and-menu: mirror chat sidebar's "pinned
      // first, then active floats to the top of the unpinned tail"
      // semantics. Pinned ids live on the shared chatStore so chat /
      // yeaft can share one pin registry; if it's missing (test env
      // without window.Pinia) we degrade to no-pin gracefully.
      let pinnedIds = null;
      try {
        if (typeof window !== 'undefined' && window.Pinia && typeof window.Pinia.useChatStore === 'function') {
          const chat = window.Pinia.useChatStore();
          if (chat && Array.isArray(chat.pinnedSessions)) {
            pinnedIds = new Set(chat.pinnedSessions);
          }
        }
      } catch (_) { /* no-pinia env */ }
      if (!pinnedIds) pinnedIds = new Set();
      const pinned = [];
      const unpinned = [];
      for (const s of all) {
        if (pinnedIds.has(s.id)) pinned.push(s);
        else unpinned.push(s);
      }
      // Active floats to the top of unpinned (only if not already pinned).
      if (state.activeSessionId && !pinnedIds.has(state.activeSessionId)) {
        const idx = unpinned.findIndex(s => s.id === state.activeSessionId);
        if (idx > 0) {
          const [active] = unpinned.splice(idx, 1);
          unpinned.unshift(active);
        }
      }
      return [...pinned, ...unpinned];
    },
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
          nextMap[s.id] = this._normalize(s, null);
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
          nextMap[s.id] = this._normalize(s, agentId);
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
      try {
        const chat = window.Pinia?.useChatStore?.();
        if (chat && chat.yeaftActiveSessionFilter && !this.sessions[chat.yeaftActiveSessionFilter]) {
          chat.yeaftActiveSessionFilter = lastViewedMatchesAgent
            ? lastViewed
            : (this.sessionOrder[0] || null);
        } else if (chat && !chat.yeaftActiveSessionFilter && lastViewedMatchesAgent) {
          chat.yeaftActiveSessionFilter = lastViewed;
        }
      } catch (_) {}
      // fix-yeaft-session-list-and-menu: mirror server-decorated pin
      // state from this snapshot into chatStore.pinnedSessions so the
      // shared pinnedSessions array is the single source of truth for
      // both chat and yeaft sort logic. Scoped per-agent: ids belonging
      // to a *different* agent are left alone (their owning agent's
      // snapshot will reconcile them on its own pass), so concurrent
      // pin state across agents stays correct.
      try {
        const chat = window.Pinia?.useChatStore?.();
        if (chat && Array.isArray(chat.pinnedSessions)) {
          const snapshotPinned = new Set();
          for (const s of arr) {
            if (s && s.id && s.pinned) snapshotPinned.add(s.id);
          }
          // Add: ids this snapshot says are pinned that the chat store
          // hasn't recorded yet. Newest at the front (matches
          // togglePin's unshift behavior).
          const existingSet = new Set(chat.pinnedSessions);
          for (const id of snapshotPinned) {
            if (!existingSet.has(id)) chat.pinnedSessions.unshift(id);
          }
          // Remove: ids in chatStore.pinnedSessions that belong to
          // *this* agent's snapshot but are NOT marked pinned in it
          // anymore — server-side unpin should propagate. Ids owned by
          // other agents (or by chat sessions) stay untouched.
          if (agentId) {
            chat.pinnedSessions = chat.pinnedSessions.filter(id => {
              const row = this.sessions[id];
              if (!row) return true;                 // unknown / chat session
              if (row.agentId !== agentId) return true; // other agent's pin
              return snapshotPinned.has(id);        // this agent's pin: obey snapshot
            });
          }
          try { localStorage.setItem('pinned-sessions', JSON.stringify(chat.pinnedSessions)); } catch (_) {}
        }
      } catch (_) {}
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
      const session = result.session || result.group || null;
      if (result.ok && result.op === 'create' && session && session.id) {
        this.applySnapshotUpsert(session, agentId);
        this.activeSessionId = session.id;
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
      this.sessions[session.id] = {
        ...(this.sessions[session.id] || {}),
        ...this._normalize(session, effectiveAgentId),
      };
      if (!existed) this.sessionOrder.push(session.id);
    },

    setActive(sessionId) {
      if (sessionId && this.sessions[sessionId]) {
        this.activeSessionId = sessionId;
      } else {
        this.activeSessionId = null;
      }
    },

    /** Register a request-id so components can await ok/error. */
    markPending(requestId, op) {
      if (!requestId) return;
      this.pending[requestId] = op;
    },

    clearLastResult() {
      this.lastCrudResult = null;
    },

    _normalize(s, agentId = null) {
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
        pinned: !!s.pinned,
      };
    },
  },
});
