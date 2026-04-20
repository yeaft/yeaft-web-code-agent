/**
 * vp.js — Virtual Person (VP) store. task-334-ui-a §3.1.
 *
 * Receives `vp_snapshot` (one-shot, snapshot-only this slice) plus stub
 * upsert/remove paths reserved for 334h live-diff.
 *
 * Per ruling §1 (D1=(b)): wire-format payloads from agent already use
 * `vpId / displayName`; this store consumes them as-is.
 *
 * Per ruling §2 (D2):
 *   • color  → web-derived via fallbackColor(vpId) (12-color palette)
 *   • avatar → web-derived (displayName[0] / vpId[0])
 *   • subtitle → agent-sent (= role)
 *   • personaHash → agent-sent (dev-1 334a-followup)
 */

const { defineStore } = Pinia;

// 12-color palette (mirrors --vp-palette-1..12 in unify-vp.css).
// Pre-vetted ≥4.5:1 contrast against white text in both light and dark.
export const VP_PALETTE = [
  '#5B8DEF', '#E07A5F', '#81B29A', '#F2CC8F', '#8367C7', '#5DB6A8',
  '#E8A87C', '#C38D9E', '#3D5A80', '#EE6C4D', '#98C1D9', '#293241',
];

/**
 * Stable per-vpId color picker. Same input → same output. Pure.
 * Uses a deterministic 32-bit FNV-style hash (no Math.random).
 *
 * @param {string} vpId
 * @returns {string} hex color
 */
export function fallbackColor(vpId) {
  if (!vpId) return VP_PALETTE[0];
  let h = 0;
  for (let i = 0; i < vpId.length; i++) {
    h = (h * 31 + vpId.charCodeAt(i)) >>> 0;
  }
  return VP_PALETTE[h % VP_PALETTE.length];
}

export const useVpStore = defineStore('vp', {
  state: () => ({
    /** @type {Record<string, object>} */
    vps: {},          // keyed by vpId
    /** @type {string[]} */
    vpOrder: [],      // insertion order
    emptyLibrary: false,
    lastSnapshotAt: 0,
  }),

  getters: {
    vpList(state) {
      return state.vpOrder.map(id => state.vps[id]).filter(Boolean);
    },
    vpCount(state) {
      return state.vpOrder.length;
    },
    vpById: (state) => (id) => state.vps[id] || null,
    vpLabel: (state) => (id) => {
      const v = state.vps[id];
      return v ? (v.displayName || v.vpId || id) : id;
    },
    vpInitial: (state) => (id) => {
      const v = state.vps[id];
      const src = (v && (v.avatar || v.displayName || v.vpId)) || id || '?';
      return String(src).charAt(0).toUpperCase() || '?';
    },
    vpColor: (state) => (id) => {
      const v = state.vps[id];
      if (v && v.color) return v.color;
      return fallbackColor(id);
    },
  },

  actions: {
    /** Apply a full vp_snapshot payload. Replaces entire collection. */
    applySnapshot(payload) {
      this.vps = {};
      this.vpOrder = [];
      const arr = (payload && Array.isArray(payload.vps)) ? payload.vps : [];
      for (const vp of arr) this._upsertInternal(vp);
      this.emptyLibrary = !!(payload && payload.emptyLibrary);
      this.lastSnapshotAt = Date.now();
    },

    /** Insert or merge a single VP record (live-diff seam — 334h). */
    upsert(vp) {
      this._upsertInternal(vp);
    },

    /** Remove a VP by id (live-diff seam — 334h). */
    remove(vpId) {
      if (!vpId) return;
      delete this.vps[vpId];
      this.vpOrder = this.vpOrder.filter(id => id !== vpId);
    },

    _upsertInternal(vp) {
      if (!vp || !vp.vpId) return;
      const existed = !!this.vps[vp.vpId];
      this.vps[vp.vpId] = { ...(this.vps[vp.vpId] || {}), ...vp };
      if (!existed) this.vpOrder.push(vp.vpId);
      // emptyLibrary auto-clears once anything is inserted.
      if (this.emptyLibrary) this.emptyLibrary = false;
    },
  },
});
