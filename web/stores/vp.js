/**
 * vp.js — Virtual Person (VP) store. task-334-ui-a §3.1 + 334h live-diff.
 *
 * Receives `vp_snapshot` (one-shot) plus `vp_updated` / `vp_removed` live
 * diff events from the agent VpLoader (see agent/unify/vp/vp-bridge.js).
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

function projectDreamDebugEvent(chat, event) {
  if (!chat || typeof chat.handleUnifyOutput !== 'function' || !event) return;
  chat.handleUnifyOutput({ event });
}

// 12 zodiac-inspired default avatar motifs. The mapping is deterministic:
// vpId -> 32-bit hash -> one of these 12 entries. Existing VP records can still
// override `color`, but the web fallback no longer gives unknown VPs a plain
// flat disk.
export const VP_AVATAR_MOTIFS = [
  { key: 'rat', label: 'Rat', glyph: 'R', background: 'linear-gradient(135deg, #DCEAFE 0%, #8FB6F5 100%)', foreground: '#12305C' },
  { key: 'ox', label: 'Ox', glyph: 'O', background: 'linear-gradient(135deg, #E9DDCF 0%, #B68B63 100%)', foreground: '#2F1D12' },
  { key: 'tiger', label: 'Tiger', glyph: 'T', background: 'linear-gradient(135deg, #FFE2B8 0%, #E0873B 100%)', foreground: '#3B1D07' },
  { key: 'rabbit', label: 'Rabbit', glyph: 'B', background: 'linear-gradient(135deg, #FCE2EA 0%, #D98FAA 100%)', foreground: '#451628' },
  { key: 'dragon', label: 'Dragon', glyph: 'D', background: 'linear-gradient(135deg, #DDF5E7 0%, #58B184 100%)', foreground: '#0F3322' },
  { key: 'snake', label: 'Snake', glyph: 'S', background: 'linear-gradient(135deg, #E5F4C8 0%, #8BB65A 100%)', foreground: '#24330F' },
  { key: 'horse', label: 'Horse', glyph: 'H', background: 'linear-gradient(135deg, #FFE0CF 0%, #CB785E 100%)', foreground: '#3C160D' },
  { key: 'goat', label: 'Goat', glyph: 'G', background: 'linear-gradient(135deg, #EEE7FF 0%, #9B86D9 100%)', foreground: '#251B4B' },
  { key: 'monkey', label: 'Monkey', glyph: 'M', background: 'linear-gradient(135deg, #FFF0B8 0%, #D5A12F 100%)', foreground: '#3A2700' },
  { key: 'rooster', label: 'Rooster', glyph: 'K', background: 'linear-gradient(135deg, #DDF7F5 0%, #58B7B2 100%)', foreground: '#0B3433' },
  { key: 'dog', label: 'Dog', glyph: 'D', background: 'linear-gradient(135deg, #E2E8F0 0%, #8798AD 100%)', foreground: '#172232' },
  { key: 'pig', label: 'Pig', glyph: 'P', background: 'linear-gradient(135deg, #FBE1F4 0%, #C983B5 100%)', foreground: '#3E1737' },
];

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
  return VP_AVATAR_MOTIFS[stableVpHash(vpId) % VP_AVATAR_MOTIFS.length];
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

export const useVpStore = defineStore('vp', {
  state: () => ({
    /** @type {Record<string, object>} */
    vps: {},          // keyed by vpId
    /** @type {string[]} */
    vpOrder: [],      // insertion order
    emptyLibrary: false,
    lastSnapshotAt: 0,
    /**
     * task-334h: last live-diff event observed. Shape:
     *   { vpId: string, kind: 'updated'|'removed', reason: string|null, at: number }
     * Consumers watch this for badge refresh / toast cues without
     * recomputing the full list. null before any live event.
     */
    lastChange: null,
    /**
     * R6 G3 — per-VP dream activity state. Populated from
     * unify_dream_status (status='running') and unify_dream_result
     * (status='success' | 'error') events. Shape:
     *   {
     *     status: 'idle'|'running'|'success'|'error',
     *     lastRunAt: number|null,    // set on success/error
     *     lastResult: object|null,   // raw payload for success
     *     lastError: string|null,    // error message
     *   }
     * VpDetailView reads this for the dream status bar + "Run now" CTA.
     * @type {Record<string, object>}
     */
    dreamStatus: {},
    /**
     * v0.1.754 — per-GROUP dream activity state. Same shape as
     * `dreamStatus` but keyed by groupId instead of vpId. Populated
     * from unify_dream_status / unify_dream_result events that carry a
     * `groupId` field (i.e. triggered via `triggerGroupDream(groupId)`
     * rather than the legacy per-VP path).
     * @type {Record<string, object>}
     */
    groupDreamStatus: {},
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
      const chat = (typeof window !== 'undefined' && window.Pinia && window.Pinia.useChatStore)
        ? window.Pinia.useChatStore()
        : null;
      const locale = (chat && typeof chat.locale === 'string')
        ? chat.locale
        : ((typeof localStorage !== 'undefined' && localStorage.getItem('locale')) || '');
      if (locale.startsWith('zh') && v.displayNameZh) return v.displayNameZh;
      return v.displayName || v.vpId || id;
    },
    vpInitial: (state) => (id) => {
      const v = state.vps[id];
      const chat = (typeof window !== 'undefined' && window.Pinia && window.Pinia.useChatStore)
        ? window.Pinia.useChatStore()
        : null;
      const locale = (chat && typeof chat.locale === 'string')
        ? chat.locale
        : ((typeof localStorage !== 'undefined' && localStorage.getItem('locale')) || '');
      const preferZh = locale.startsWith('zh');
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
    vpAvatarMotif: () => (id) => fallbackAvatarMotif(id),
    /** R6 G3 — dream status row for a vpId (always returns an object). */
    dreamStatusFor: (state) => (id) => {
      return state.dreamStatus[id] || {
        status: 'idle',
        lastRunAt: null,
        lastResult: null,
        lastError: null,
      };
    },
    /** v0.1.754 — dream status row for a groupId (always returns an object). */
    groupDreamStatusFor: (state) => (groupId) => {
      return state.groupDreamStatus[groupId] || {
        status: 'idle',
        lastRunAt: null,
        lastResult: null,
        lastError: null,
      };
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

    /** Insert or merge a single VP record (live-diff — 334h). */
    upsert(vp, reason = null) {
      this._upsertInternal(vp);
      if (vp && vp.vpId) {
        this.lastChange = {
          vpId: vp.vpId,
          kind: 'updated',
          reason: reason || null,
          at: Date.now(),
        };
      }
    },

    /** Remove a VP by id (live-diff — 334h). */
    remove(vpId, reason = null) {
      if (!vpId) return;
      delete this.vps[vpId];
      this.vpOrder = this.vpOrder.filter(id => id !== vpId);
      this.lastChange = {
        vpId,
        kind: 'removed',
        reason: reason || 'file.removed',
        at: Date.now(),
      };
    },

    _upsertInternal(vp) {
      if (!vp || !vp.vpId) return;
      const existed = !!this.vps[vp.vpId];
      this.vps[vp.vpId] = { ...(this.vps[vp.vpId] || {}), ...vp };
      if (!existed) this.vpOrder.push(vp.vpId);
      // emptyLibrary auto-clears once anything is inserted.
      if (this.emptyLibrary) this.emptyLibrary = false;
    },

    // ── R6 G3: Dream trigger + status ────────────────────────────
    /**
     * Send unify_dream_trigger over WS. Optimistically marks the VP as
     * 'running'; the agent will subsequently emit unify_dream_status
     * (running) and unify_dream_result (success|error).
     *
     * @param {string} vpId
     */
    triggerDream(vpId) {
      if (!vpId) return;
      this.dreamStatus = {
        ...this.dreamStatus,
        [vpId]: {
          ...(this.dreamStatus[vpId] || {}),
          status: 'running',
          lastError: null,
        },
      };
      const chat = (window.Pinia && window.Pinia.useChatStore)
        ? window.Pinia.useChatStore()
        : null;
      if (chat && typeof chat.sendWsMessage === 'function') {
        chat.sendWsMessage({ type: 'unify_dream_trigger', vpId });
      }
    },

    /**
     * Per-group manual dream trigger (added v0.1.754 to give users a
     * way to kick the dream scheduler after seeing the Resident layer
     * stuck on a group's bootstrap seed). Sends
     * `{ type: 'unify_dream_trigger', groupId }` over WS; the agent's
     * `handleUnifyDreamTrigger` routes to `triggerDreamForScopes(['group/X'])`
     * so unrelated groups are not processed. Status flows back via
     * unify_dream_status / unify_dream_result events tagged with
     * `groupId` instead of `vpId`.
     *
     * @param {string} groupId
     */
    triggerGroupDream(groupId) {
      if (!groupId) return;
      this.groupDreamStatus = {
        ...this.groupDreamStatus,
        [groupId]: {
          ...(this.groupDreamStatus[groupId] || {}),
          status: 'running',
          lastError: null,
        },
      };
      const chat = (window.Pinia && window.Pinia.useChatStore)
        ? window.Pinia.useChatStore()
        : null;
      const now = Date.now();
      projectDreamDebugEvent(chat, {
        type: 'dream_progress',
        phase: 'start',
        groupId,
        manual: true,
        trigger: 'manual',
        source: 'header-button',
        ts: now,
      });
      if (!chat || typeof chat.sendWsMessage !== 'function') {
        projectDreamDebugEvent(chat, {
          type: 'unify_dream_result',
          groupId,
          success: false,
          skipped: true,
          skippedReason: 'chat-store-unavailable',
          trigger: 'manual',
          error: null,
        });
        return;
      }
      const frame = { type: 'unify_dream_trigger', groupId };
      if (chat.unifyAgentId) frame.agentId = chat.unifyAgentId;
      const sent = chat.sendWsMessage(frame);
      if (sent === false) {
        projectDreamDebugEvent(chat, {
          type: 'unify_dream_result',
          groupId,
          success: false,
          skipped: true,
          skippedReason: 'websocket-not-open',
          trigger: 'manual',
          error: null,
        });
      }
    },

    /**
     * Apply unify_dream_status event (status='running' from agent).
     * Routes by which id field the event carries (vpId vs groupId).
     */
    applyDreamStatus(event) {
      if (!event) return;
      if (event.groupId) {
        const groupId = event.groupId;
        this.groupDreamStatus = {
          ...this.groupDreamStatus,
          [groupId]: {
            ...(this.groupDreamStatus[groupId] || {}),
            status: event.status === 'running' ? 'running' : (event.status || 'idle'),
          },
        };
        return;
      }
      if (!event.vpId) return;
      const vpId = event.vpId;
      this.dreamStatus = {
        ...this.dreamStatus,
        [vpId]: {
          ...(this.dreamStatus[vpId] || {}),
          status: event.status === 'running' ? 'running' : (event.status || 'idle'),
        },
      };
    },

    /**
     * Apply unify_dream_result event (success or error). Routes by
     * which id field the event carries.
     */
    applyDreamResult(event) {
      if (!event) return;
      const ok = !!event.success;
      const skipped = !!event.skipped;
      const result = {
        mergedCount: event.mergedCount ?? null,
        extractedCount: event.extractedCount ?? null,
        // fix/dream-cadence-and-ui-trigger: bridge derives a single
        // scalar `entriesCreated` (count of done targets) so the
        // topbar bubble has a stable field to read; falls back to
        // mergedCount/extractedCount if an older agent build is
        // attached.
        entriesCreated: typeof event.entriesCreated === 'number'
          ? event.entriesCreated
          : (event.mergedCount ?? event.extractedCount ?? 0),
        skipped,
        skippedReason: event.skippedReason || null,
        groupsProcessed: typeof event.groupsProcessed === 'number' ? event.groupsProcessed : null,
        groupsSkipped: typeof event.groupsSkipped === 'number' ? event.groupsSkipped : null,
        targetsApplied: typeof event.targetsApplied === 'number' ? event.targetsApplied : null,
        durationMs: typeof event.durationMs === 'number' ? event.durationMs : null,
        llmCallCount: typeof event.llmCallCount === 'number' ? event.llmCallCount : 0,
        inputTokens: typeof event.inputTokens === 'number' ? event.inputTokens : 0,
        outputTokens: typeof event.outputTokens === 'number' ? event.outputTokens : 0,
        totalTokens: typeof event.totalTokens === 'number' ? event.totalTokens : 0,
        metrics: event.metrics || null,
        passBreakdown: event.passBreakdown || event.metrics?.passBreakdown || null,
        targetErrors: Array.isArray(event.targetErrors) ? event.targetErrors : [],
      };
      const lastError = ok || skipped ? null : (event.error || null);
      const status = skipped ? 'skipped' : (ok ? 'success' : 'error');
      if (event.groupId) {
        const groupId = event.groupId;
        this.groupDreamStatus = {
          ...this.groupDreamStatus,
          [groupId]: {
            status,
            lastRunAt: Date.now(),
            lastResult: result,
            lastError,
          },
        };
        return;
      }
      if (!event.vpId) return;
      const vpId = event.vpId;
      this.dreamStatus = {
        ...this.dreamStatus,
        [vpId]: {
          status,
          lastRunAt: Date.now(),
          lastResult: result,
          lastError,
        },
      };
    },
  },
});
