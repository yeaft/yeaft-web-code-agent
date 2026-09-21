/**
 * vp.js — Virtual Person (VP) store. task-334-ui-a §3.1 + 334h live-diff.
 *
 * Receives `vp_snapshot` (one-shot) plus `vp_updated` / `vp_removed` live
 * diff events from the agent VpLoader (see agent/yeaft/vp/vp-bridge.js).
 *
 * Per ruling §1 (D1=(b)): wire-format payloads from agent already use
 * `vpId / displayName`; this store consumes them as-is.
 *
 * Per ruling §2 (D2):
 *   • color  → web-derived via fallbackColor(vpId) (12-color palette)
 *   • avatar → web-derived (displayName[0] / vpId[0])
 *   • subtitle → agent-sent (= role)
 *   • personaHash → agent-sent (dev-1 334a-followup)
 *
 * task-334h: `lastChange` records the most recent live-diff event so
 * components (e.g. 334-ui-b badge) can react to persona.edit vs traits.edit
 * vs manual.reload vs file.removed without re-reading the full store.
 */

const { defineStore } = Pinia;

// 12 modern default avatar motifs. The mapping is deterministic:
// vpId -> fixed known-VP entry when present, otherwise 32-bit hash -> one of
// these 12 entries. The concrete colors live in CSS variables so light and dark
// themes can use distinct palettes without duplicating picker logic.
export const VP_AVATAR_MOTIFS = [
  { key: 'rat', label: 'Rat', glyph: 'R', background: 'var(--vp-avatar-rat-bg)', foreground: 'var(--vp-avatar-rat-fg)' },
  { key: 'ox', label: 'Ox', glyph: 'O', background: 'var(--vp-avatar-ox-bg)', foreground: 'var(--vp-avatar-ox-fg)' },
  { key: 'tiger', label: 'Tiger', glyph: 'T', background: 'var(--vp-avatar-tiger-bg)', foreground: 'var(--vp-avatar-tiger-fg)' },
  { key: 'rabbit', label: 'Rabbit', glyph: 'B', background: 'var(--vp-avatar-rabbit-bg)', foreground: 'var(--vp-avatar-rabbit-fg)' },
  { key: 'dragon', label: 'Dragon', glyph: 'D', background: 'var(--vp-avatar-dragon-bg)', foreground: 'var(--vp-avatar-dragon-fg)' },
  { key: 'snake', label: 'Snake', glyph: 'S', background: 'var(--vp-avatar-snake-bg)', foreground: 'var(--vp-avatar-snake-fg)' },
  { key: 'horse', label: 'Horse', glyph: 'H', background: 'var(--vp-avatar-horse-bg)', foreground: 'var(--vp-avatar-horse-fg)' },
  { key: 'goat', label: 'Goat', glyph: 'G', background: 'var(--vp-avatar-goat-bg)', foreground: 'var(--vp-avatar-goat-fg)' },
  { key: 'monkey', label: 'Monkey', glyph: 'M', background: 'var(--vp-avatar-monkey-bg)', foreground: 'var(--vp-avatar-monkey-fg)' },
  { key: 'rooster', label: 'Rooster', glyph: 'K', background: 'var(--vp-avatar-rooster-bg)', foreground: 'var(--vp-avatar-rooster-fg)' },
  { key: 'dog', label: 'Dog', glyph: 'D', background: 'var(--vp-avatar-dog-bg)', foreground: 'var(--vp-avatar-dog-fg)' },
  { key: 'pig', label: 'Pig', glyph: 'P', background: 'var(--vp-avatar-pig-bg)', foreground: 'var(--vp-avatar-pig-fg)' },
];

// The default group roster needs the four common VPs to be visually distinct
// even at 20-24px. Hashes are stable, but adjacent pastel-ish colours are not
// good enough in a dark sidebar, so pin these identities to separated hues.
export const VP_AVATAR_MOTIF_BY_ID = Object.freeze({
  steve: VP_AVATAR_MOTIFS[8],  // amber
  ada: VP_AVATAR_MOTIFS[3],    // magenta
  linus: VP_AVATAR_MOTIFS[0],  // blue
  martin: VP_AVATAR_MOTIFS[4], // green
});

export const VP_PALETTE = VP_AVATAR_MOTIFS.map((motif) => motif.background);

/**
 * Stable per-vpId hash. Same input -> same output. Pure; no Math.random.
 *
 * @param {string} value
 * @returns {number} unsigned 32-bit hash
 */
export function stableVpHash(value) {
  const input = String(value || '');
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Stable per-vpId zodiac motif picker.
 *
 * @param {string} vpId
 * @returns {{key: string, label: string, glyph: string, background: string, foreground: string}}
 */
export function fallbackAvatarMotif(vpId) {
  if (!vpId) return VP_AVATAR_MOTIFS[0];
  const id = String(vpId).toLowerCase();
  return VP_AVATAR_MOTIF_BY_ID[id]
    || VP_AVATAR_MOTIFS[stableVpHash(id) % VP_AVATAR_MOTIFS.length];
}

/**
 * Stable per-vpId background picker. Same input -> same output. Pure.
 *
 * @param {string} vpId
 * @returns {string} CSS background
 */
export function fallbackColor(vpId) {
  return fallbackAvatarMotif(vpId).background;
}

/**
 * Stable text color for VP identity labels. Uses the motif foreground rather
 * than the old gradient background so lists can be text-only and still keep
 * per-VP hue separation.
 *
 * @param {string} vpId
 * @returns {string} CSS color
 */
export function fallbackTextColor(vpId) {
  return fallbackAvatarMotif(vpId).foreground;
}

/**
 * Read the current UI locale without making VP consumers own i18n plumbing.
 * The Pinia chat-store read is reactive; localStorage is only a startup/test
 * fallback before the chat store has been installed.
 *
 * @returns {string}
 */
function currentVpLocale() {
  const chat = (typeof window !== 'undefined' && window.Pinia && window.Pinia.useChatStore)
    ? window.Pinia.useChatStore()
    : null;
  return (chat && typeof chat.locale === 'string')
    ? chat.locale
    : ((typeof localStorage !== 'undefined' && localStorage.getItem('locale')) || '');
}

/**
 * Resolve the localized one-line capability summary used by VP lists.
 * Older/custom VP records may not have description fields yet, so role is the
 * compatibility fallback rather than rendering an empty second line.
 *
 * @param {object|null|undefined} vp
 * @param {string} locale
 * @returns {string}
 */
export function localizedVpDescription(vp, locale = '') {
  if (!vp) return '';
  const preferZh = String(locale || '').startsWith('zh');
  if (preferZh) return vp.descriptionZh || vp.roleZh || vp.description || vp.role || '';
  return vp.description || vp.role || vp.descriptionZh || vp.roleZh || '';
}

export const useVpStore = defineStore('vp', {
  state: () => ({
    /** @type {Record<string, object>} */
    vps: {},          // keyed by vpId
    /** @type {string[]} */
    vpOrder: [],      // insertion order
    emptyLibrary: false,
    lastSnapshotAt: 0,
    /** @type {'idle'|'loading'|'ready'|'error'} */
    snapshotStatus: 'idle',
    snapshotAgentId: null,
    snapshotRequestId: null,
    snapshotError: '',
    /**
     * fix-session-restore-modal-unify: which agent the last snapshot came
     * from. Multi-agent deployments need this so callers (e.g.
     * SessionCreateModal's agent dropdown watcher) can detect when the
     * cached roster belongs to a *different* agent than the one currently
     * being targeted, and force a fresh subscribe.
     *
     * `null` means we haven't observed a stamped snapshot yet (legacy
     * single-agent path, or no snapshot received at all).
     * @type {string|null}
     */
    lastVpSnapshotAgentId: null,
    /**
     * task-334h: last live-diff event observed. Shape:
     *   { vpId: string, kind: 'updated'|'removed', reason: string|null, at: number }
     * Consumers watch this for badge refresh / toast cues without
     * recomputing the full list. null before any live event.
     */
    lastChange: null,
  }),

  getters: {
    vpList(state) {
      return state.vpOrder.map(id => state.vps[id]).filter(Boolean);
    },
    vpCount(state) {
      return state.vpOrder.length;
    },
    vpById: (state) => (id) => state.vps[id] || null,
    // task-fix (5-bugs): bilingual display. Locale is read reactively from
    // the chat store (which is itself Pinia-reactive). zh-* locales prefer
    // displayNameZh; others fall back to displayName, then vpId.
    //
    // History: this getter used to read `localStorage.getItem('locale')`
    // directly. localStorage is not reactive, so when the user flipped
    // the language dropdown the getter result stayed cached against
    // `state.vps` (the only declared reactive dep) and the VP list label
    // would not update until the next vp_snapshot arrived. Reading from
    // `chatStore.locale` (a Pinia state field) re-establishes reactivity.
    vpLabel: (state) => (id) => {
      const v = state.vps[id];
      if (!v) return id;
      const locale = currentVpLocale();
      if (locale.startsWith('zh') && v.displayNameZh) return v.displayNameZh;
      return v.displayName || v.vpId || id;
    },
    vpDescription: (state) => (id) => localizedVpDescription(state.vps[id], currentVpLocale()),
    vpInitial: (state) => (id) => {
      const v = state.vps[id];
      const preferZh = currentVpLocale().startsWith('zh');
      const src = (v && (v.avatar
        || (preferZh && v.displayNameZh)
        || v.displayName
        || v.vpId)) || id || '?';
      return String(src).charAt(0).toUpperCase() || '?';
    },
    vpColor: (state) => (id) => {
      const v = state.vps[id];
      if (v && v.color) return v.color;
      return fallbackColor(id);
    },
    vpTextColor: () => (id) => fallbackTextColor(id),
    vpAvatarMotif: () => (id) => fallbackAvatarMotif(id),
  },

  actions: {
    /**
     * Apply a full vp_snapshot payload. Replaces entire collection.
     *
     * @param {object} payload — the vp_snapshot event ({ vps[], emptyLibrary })
     * @param {string|null} [agentId] — fix-session-restore-modal-unify:
     *   which agent the snapshot came from. Stamped on `lastVpSnapshotAgentId`
     *   so consumers can detect when their cached roster is from a
     *   *different* agent than the one currently being targeted.
     */
    applySnapshot(payload, agentId = null, requestId = null) {
      const activeAgentId = this.snapshotAgentId || null;
      if (activeAgentId && agentId && agentId !== activeAgentId) return false;
      // New Agents echo requestId. Old Agents omit it; accept that response only
      // when its envelope still belongs to the active Agent scope.
      if (requestId && this.snapshotRequestId && requestId !== this.snapshotRequestId) return false;
      const arr = (payload && Array.isArray(payload.vps)) ? payload.vps : [];
      this._setActiveSnapshot({
        vps: arr,
        emptyLibrary: !!(payload && payload.emptyLibrary),
        agentId: agentId || activeAgentId || null,
        requestId: requestId || this.snapshotRequestId || null,
        receivedAt: Date.now(),
      });
      return true;
    },

    beginSnapshot(agentId, requestId) {
      // The flat collection is the active Agent view. Clear it on every scope
      // transition so stale rows can neither render nor become a submit roster.
      this.vps = {};
      this.vpOrder = [];
      this.emptyLibrary = false;
      this.lastVpSnapshotAgentId = null;
      this.snapshotStatus = 'loading';
      this.snapshotAgentId = agentId || null;
      this.snapshotRequestId = requestId || null;
      this.snapshotError = '';
    },

    failSnapshot(agentId, requestId, error = '') {
      if (!this.snapshotRequestId || !requestId || requestId !== this.snapshotRequestId) return false;
      if (agentId && this.snapshotAgentId && agentId !== this.snapshotAgentId) return false;
      this.snapshotStatus = 'error';
      this.snapshotAgentId = agentId || this.snapshotAgentId || null;
      this.snapshotRequestId = requestId || this.snapshotRequestId || null;
      this.snapshotError = String(error || 'VP library request failed');
      return true;
    },

    _setActiveSnapshot({ vps, emptyLibrary, agentId, requestId, receivedAt }) {
      this.vps = {};
      this.vpOrder = [];
      for (const vp of vps || []) this._upsertInternal(vp);
      this.emptyLibrary = !!emptyLibrary;
      this.lastSnapshotAt = receivedAt || Date.now();
      this.lastVpSnapshotAgentId = agentId || null;
      this.snapshotStatus = 'ready';
      this.snapshotAgentId = agentId || null;
      this.snapshotRequestId = requestId || null;
      this.snapshotError = '';
    },

    /** Insert or merge a single VP record (live-diff — 334h). */
    upsert(vp, reason = null, agentId = null) {
      if (agentId && this.snapshotAgentId && agentId !== this.snapshotAgentId) return false;
      this._upsertInternal(vp);
      if (vp && vp.vpId) {
        this.lastChange = {
          vpId: vp.vpId,
          kind: 'updated',
          reason: reason || null,
          at: Date.now(),
        };
      }
      return true;
    },

    /** Remove a VP by id (live-diff — 334h). */
    remove(vpId, reason = null, agentId = null) {
      if (agentId && this.snapshotAgentId && agentId !== this.snapshotAgentId) return false;
      if (!vpId) return false;
      delete this.vps[vpId];
      this.vpOrder = this.vpOrder.filter(id => id !== vpId);
      this.lastChange = {
        vpId,
        kind: 'removed',
        reason: reason || 'file.removed',
        at: Date.now(),
      };
      return true;
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
