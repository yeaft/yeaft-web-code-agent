/**
 * groups.js — Group store (task-334m).
 *
 * Mirrors vp.js shape. Receives:
 *   group_list_updated      — full snapshot (create/rename/archive + session_ready replay)
 *   group_roster_changed    — roster/defaultVpId/name delta (addMember/removeMember/setDefault)
 *   group_crud_result       — op reply with `requestId` + ok/error
 *
 * `activeGroupId` is a pure UI pointer (which group the main pane shows).
 * Default: sticks to the first group in the snapshot, or whatever the caller
 * sets via setActive().
 */

const { defineStore } = Pinia;

export const useGroupsStore = defineStore('groups', {
  state: () => ({
    /** @type {Record<string, object>} */
    groups: {},       // keyed by group id
    /** @type {string[]} */
    groupOrder: [],   // render order (matches snapshot order)
    /** @type {string|null} */
    activeGroupId: null,
    lastSnapshotAt: 0,
    /**
     * Most recent CRUD result for the UI to surface as toast/modal error.
     * Shape: { op, ok, error?:{code,groupId,message}, at }
     */
    lastCrudResult: null,
    /** Pending request ids keyed by client-side requestId → op name. */
    pending: {},
  }),

  getters: {
    groupList(state) {
      return state.groupOrder.map(id => state.groups[id]).filter(Boolean);
    },
    groupCount(state) {
      return state.groupOrder.length;
    },
    groupById: (state) => (id) => state.groups[id] || null,
    activeGroup(state) {
      return state.activeGroupId ? (state.groups[state.activeGroupId] || null) : null;
    },
    isEmpty(state) {
      return state.groupOrder.length === 0;
    },
    /**
     * True iff the active group has no roster members — the UI uses this to
     * drive the "invite VP" modal on the `no_default_vp` path (§Δ30.5).
     */
    activeNeedsInvite(state) {
      const g = state.activeGroupId ? state.groups[state.activeGroupId] : null;
      if (!g) return false;
      return !g.defaultVpId && (!Array.isArray(g.roster) || g.roster.length === 0);
    },
  },

  actions: {
    /** Replace the whole collection from `group_list_updated`. */
    applySnapshot(groups) {
      const arr = Array.isArray(groups) ? groups : [];
      const nextMap = {};
      const nextOrder = [];
      for (const g of arr) {
        if (!g || !g.id) continue;
        nextMap[g.id] = this._normalize(g);
        nextOrder.push(g.id);
      }
      this.groups = nextMap;
      this.groupOrder = nextOrder;
      this.lastSnapshotAt = Date.now();
      // If the active id vanished from the snapshot (archive / rename-to-gone)
      // fall back to the first available group.
      if (this.activeGroupId && !nextMap[this.activeGroupId]) {
        this.activeGroupId = nextOrder[0] || null;
      } else if (!this.activeGroupId && nextOrder.length > 0) {
        this.activeGroupId = nextOrder[0];
      }
    },

    /** Apply a `group_roster_changed` delta (in-place merge). */
    applyRosterChange(payload) {
      if (!payload || !payload.groupId) return;
      const prev = this.groups[payload.groupId];
      if (!prev) {
        // Unknown id — create a stub; snapshot will fill the rest shortly.
        const stub = this._normalize({
          id: payload.groupId,
          name: payload.name || payload.groupId,
          roster: Array.isArray(payload.roster) ? payload.roster : [],
          defaultVpId: payload.defaultVpId || null,
        });
        this.groups[payload.groupId] = stub;
        this.groupOrder.push(payload.groupId);
        return;
      }
      this.groups[payload.groupId] = {
        ...prev,
        name: payload.name || prev.name,
        roster: Array.isArray(payload.roster) ? payload.roster.slice() : prev.roster,
        defaultVpId: payload.defaultVpId != null ? payload.defaultVpId : prev.defaultVpId,
        announcement: typeof payload.announcement === 'string' ? payload.announcement : prev.announcement,
      };
    },

    /** Record a `group_crud_result` for UI feedback. */
    applyCrudResult(result) {
      if (!result) return;
      this.lastCrudResult = { ...result, at: Date.now() };
      if (result.requestId && this.pending[result.requestId]) {
        delete this.pending[result.requestId];
      }
      // On successful create, prefer the newly-created group as active so
      // the main pane flips to it immediately.
      if (result.ok && result.op === 'create' && result.group && result.group.id) {
        this.applySnapshotUpsert(result.group);
        this.activeGroupId = result.group.id;
      }
      if (result.ok && (result.op === 'archive' || result.op === 'delete') && result.groupId) {
        delete this.groups[result.groupId];
        this.groupOrder = this.groupOrder.filter(id => id !== result.groupId);
        if (this.activeGroupId === result.groupId) {
          this.activeGroupId = this.groupOrder[0] || null;
        }
      }
      // On successful update_config, merge the new config into the cached
      // group entry so the UI updates without waiting for the snapshot.
      if (result.ok && result.op === 'update_config' && result.groupId) {
        const prev = this.groups[result.groupId];
        if (prev) {
          this.groups[result.groupId] = {
            ...prev,
            config: result.config && typeof result.config === 'object' ? { ...result.config } : {},
          };
        }
      }
    },

    /** Insert or merge a single group record. */
    applySnapshotUpsert(group) {
      if (!group || !group.id) return;
      const existed = !!this.groups[group.id];
      this.groups[group.id] = {
        ...(this.groups[group.id] || {}),
        ...this._normalize(group),
      };
      if (!existed) this.groupOrder.push(group.id);
    },

    setActive(groupId) {
      if (groupId && this.groups[groupId]) {
        this.activeGroupId = groupId;
      } else {
        this.activeGroupId = null;
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

    _normalize(g) {
      return {
        id: g.id,
        name: g.name || g.id,
        roster: Array.isArray(g.roster) ? g.roster.slice() : [],
        defaultVpId: g.defaultVpId || null,
        announcement: typeof g.announcement === 'string' ? g.announcement : '',
        config: g.config && typeof g.config === 'object' ? { ...g.config } : {},
        createdAt: g.createdAt || null,
      };
    },
  },
});
