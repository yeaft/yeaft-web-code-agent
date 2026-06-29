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

function projectDreamDebugEvent(chat, event) {
  if (!chat || typeof chat.handleYeaftOutput !== 'function' || !event) return;
  chat.handleYeaftOutput({ event });
}

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

export const useVpStore = defineStore('vp', {
  state: () => ({
    /** @type {Record<string, object>} */
    vps: {},          // keyed by vpId
    /** @type {string[]} */
    vpOrder: [],      // insertion order
    emptyLibrary: false,
    lastSnapshotAt: 0,
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
    /**
     * R6 G3 — per-VP dream activity state. Populated from
     * yeaft_dream_status (status='running') and yeaft_dream_result
     * (status='success' | 'error') events. Shape:
     *   {
     *     status: 'idle'|'running'|'success'|'error',
     *     lastRunAt: number|null,    // set on success/error
     *     lastResult: object|null,   // raw payload for success
     *     lastError: string|null,    // error message
     *   }
     * Inline status surfaces read this for dream activity without polling.
     * @type {Record<string, object>}
     */
    dreamStatus: {},
    /**
     * v0.1.754 — per-GROUP dream activity state. Same shape as
     * `dreamStatus` but keyed by groupId instead of vpId. Populated
     * from yeaft_dream_status / yeaft_dream_result events that carry a
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
    vpTextColor: () => (id) => fallbackTextColor(id),
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
    /**
     * Apply a full vp_snapshot payload. Replaces entire collection.
     *
     * @param {object} payload — the vp_snapshot event ({ vps[], emptyLibrary })
     * @param {string|null} [agentId] — fix-session-restore-modal-unify:
     *   which agent the snapshot came from. Stamped on `lastVpSnapshotAgentId`
     *   so consumers can detect when their cached roster is from a
     *   *different* agent than the one currently being targeted.
     */
    applySnapshot(payload, agentId = null) {
      this.vps = {};
      this.vpOrder = [];
      const arr = (payload && Array.isArray(payload.vps)) ? payload.vps : [];
      for (const vp of arr) this._upsertInternal(vp);
      this.emptyLibrary = !!(payload && payload.emptyLibrary);
      this.lastSnapshotAt = Date.now();
      this.lastVpSnapshotAgentId = agentId || null;
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
     * Send yeaft_dream_trigger over WS. Optimistically marks the VP as
     * 'running'; the agent will subsequently emit yeaft_dream_status
     * (running) and yeaft_dream_result (success|error).
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
        chat.sendWsMessage({ type: 'yeaft_dream_trigger', vpId });
      }
    },

    /**
     * Per-group manual dream trigger (added v0.1.754 to give users a
     * way to kick the dream scheduler after seeing the Resident layer
     * stuck on a session bootstrap seed). Sends
     * `{ type: 'yeaft_dream_trigger', sessionId }` over WS; the agent's
     * `handleYeaftDreamTrigger` routes to `triggerDreamForScopes(['sessions/X'])`
     * so unrelated sessions are not processed. Status flows back via
     * yeaft_dream_status / yeaft_dream_result events tagged with
     * `sessionId` instead of `vpId`.
     *
     * @param {string} groupId legacy in-store argument name for sessionId
     */
    triggerGroupDream(groupId, meta = {}) {
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
          type: 'yeaft_dream_result',
          groupId,
          success: false,
          skipped: true,
          skippedReason: 'chat-store-unavailable',
          trigger: 'manual',
          error: null,
        });
        return;
      }
      const frame = { type: 'yeaft_dream_trigger', sessionId: groupId };
      // Route by the session's owning agent (dream is session-scoped). Falls
      // back to currentAgent; server also defaults to client.currentAgent.
      const dreamAgentId = meta && meta.agentId
        ? meta.agentId
        : (typeof chat.agentIdForSession === 'function'
          ? chat.agentIdForSession(groupId)
          : chat.currentAgent);
      if (dreamAgentId) frame.agentId = dreamAgentId;
      const sent = chat.sendWsMessage(frame);
      if (sent === false) {
        projectDreamDebugEvent(chat, {
          type: 'yeaft_dream_result',
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
     * Apply yeaft_dream_status event (status='running' from agent).
     * Routes by which id field the event carries (vpId vs sessionId).
     * Legacy `groupId` is still accepted for older agent builds.
     */
    applyDreamStatus(event) {
      if (!event) return;
      const sessionId = event.sessionId;
      if (sessionId) {
        this.groupDreamStatus = {
          ...this.groupDreamStatus,
          [sessionId]: {
            ...(this.groupDreamStatus[sessionId] || {}),
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
     * Apply yeaft_dream_result event (success or error). Routes by
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
        sessionsProcessed: typeof event.sessionsProcessed === 'number' ? event.sessionsProcessed : null,
        sessionsSkipped: typeof event.sessionsSkipped === 'number' ? event.sessionsSkipped : null,
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
      const sessionId = event.sessionId;
      if (sessionId) {
        this.groupDreamStatus = {
          ...this.groupDreamStatus,
          [sessionId]: {
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
