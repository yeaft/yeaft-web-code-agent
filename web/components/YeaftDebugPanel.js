/**
 * YeaftDebugPanel — feat-6af5f9f1 PR B.
 *
 * Replaces the previous inline debug block in YeaftPage.js. Renders the
 * Yeaft engine's per-Turn debug records as:
 *
 *   Turn header  (user prompt + vp + session + totals + [copy turn])
 *     System prompt        [show] [copy]                turn-level
 *     Memory loaded   [show] [copy]                     turn-level
 *     Memory adjust   [show] [copy]                     turn-level
 *     -- Loop 1   in/out/total tok · ms · tools×N · refl    [chevron]
 *         Tools (N)      one row per tool with [copy in] [copy out]
 *         Reflection T1  [copy]
 *         Assistant text [copy]
 *         [copy req] [copy res]      raw payload — copy-only, never inlined
 *     -- Loop 2 …
 *
 * Vocabulary (locked in):
 *   Turn = one user prompt + all AI responses
 *   Loop = one LLM call inside a Turn
 *   Tool = one tool execution inside a Loop
 *
 * Copy semantics:
 *   - per-tool [copy in] / [copy out] → JSON string
 *   - raw [copy req] / [copy res]     → JSON-stringified payload
 *   - turn   [copy turn]              → markdown summary
 */
import { buildDreamDebugItems, filterDreamDebugItems, previewText } from './dream-debug-model.js';
import { splitTokenBreakdown, apportionToBuckets, formatClockTime } from './yeaft-debug-helpers.js';

export default {
  name: 'YeaftDebugPanel',
  emits: ['close'],
  data() {
    return {
      // Per-turn expand state, keyed by turnId.
      expandedTurns: {},
      // Per-loop expand state, keyed by `${turnId}#${loopNumber}`.
      expandedLoops: {},
      // Per-section expand state, keyed by `${turnId}#${section}`.
      expandedSections: {},
      // Per-tool detail expand state, keyed by turn/loop/tool id.
      expandedToolDetails: {},
      copiedFlash: null, // last copy notice key (for transient feedback)
      copiedFlashAt: 0,
      // feat-6af5f9f1 PR C: snapshot of user's expand state captured the
      // moment they start a search, restored when they clear it. Without
      // this, search would clobber their carefully curated open turns.
      _expandSnapshot: null,
      // PR feat-dream-debug-panel-full: expand state for the Dream row's
      // event timeline. False = collapsed summary line only; true = show
      // full per-event ring buffer below.
      dreamExpanded: false,
      // feat-dream-debug-detail: per-dream-event expand state, keyed by
      // `${at}#${idx}` matching the v-for key used in the template.
      expandedDreamEvents: {},
      expandedDreamSegments: {},
      activeDreamItemKey: null,
      dreamItemSearch: '',
      activeTab: 'requests', // 'toolStats' | 'dream' | 'requests'
    };
  },
  watch: {
    // PR C: when search becomes active, auto-expand all matching turns
    // and their first loop so the user sees content immediately. When
    // cleared, restore the snapshot.
    searchQuery(now, prev) {
      const wasActive = !!(prev && prev.trim());
      const isActive = !!(now && now.trim());
      if (!wasActive && isActive) {
        // Entering search: snapshot current state, then auto-expand.
        this._expandSnapshot = {
          turns: { ...this.expandedTurns },
          loops: { ...this.expandedLoops },
        };
        const turnsOpen = {};
        const loopsOpen = {};
        for (const turn of this.turns) {
          turnsOpen[turn.turnId] = true;
          if (turn.loops && turn.loops.length > 0) {
            loopsOpen[`${turn.turnId}#${turn.loops[0].loopNumber}`] = true;
          }
        }
        this.expandedTurns = turnsOpen;
        this.expandedLoops = loopsOpen;
      } else if (wasActive && !isActive && this._expandSnapshot) {
        // Cleared: restore.
        this.expandedTurns = this._expandSnapshot.turns;
        this.expandedLoops = this._expandSnapshot.loops;
        this._expandSnapshot = null;
      } else if (isActive) {
        // Search refined: keep all matching turns expanded.
        const turnsOpen = { ...this.expandedTurns };
        for (const turn of this.turns) {
          if (turnsOpen[turn.turnId] === undefined) turnsOpen[turn.turnId] = true;
        }
        this.expandedTurns = turnsOpen;
      }
    },
    // feat-always-on-trajectory-store: watch yeaftAgentId. The mount-time
    // hydration silently no-ops when the panel is opened before the
    // agent socket finishes connecting (loadYeaftDebugHistory bails on
    // !this.yeaftAgentId). Without this watcher the panel stays empty
    // for that whole session because mounted() never runs again.
    //
    // Condition is `now && now !== prev` (not just `now && !prev`) so an
    // agent A → agent B switch also re-fetches; otherwise the panel would
    // keep showing agent A's trajectory after the user switches.
    'store.yeaftAgentId'(now, prev) {
      if (now && now !== prev && this.store && typeof this.store.loadYeaftDebugHistory === 'function') {
        this.store.loadYeaftDebugHistory({ limit: 5, dreamLimit: 5 });
      }
    },
  },
  computed: {
    store() {
      return window.Pinia?.useChatStore?.() || null;
    },
    sessionsStore() {
      return window.Pinia?.useSessionsStore?.() || null;
    },
    turns() {
      const turns = (this.store && this.store.yeaftDebugTurnsForActiveSession) || [];
      return turns.map((turn) => this.decorateTurnTokenBreakdowns(turn));
    },
    // feat-6af5f9f1 PR C: toolbar bindings.
    searchQuery: {
      get() { return this.store ? (this.store.yeaftDebugSearch || '') : ''; },
      set(v) { this.store && this.store.setYeaftDebugSearch(v); },
    },
    sessionFilter: {
      get() {
        if (!this.store) return '';
        const g = this.store.yeaftDebugSessionFilter;
        // null (default — fall through to main pane filter) maps to ''
        // in the dropdown so the placeholder option is selected.
        return g === null || g === undefined ? '' : g;
      },
      set(v) {
        if (!this.store) return;
        if (!v) this.store.setYeaftDebugSessionFilter(null);
        else this.store.setYeaftDebugSessionFilter(v);
      },
    },
    availableSessions() {
      return (this.store && this.store.yeaftDebugAvailableSessions) || [];
    },
    turnTotal() {
      return (this.store && this.store.yeaftDebugTurnTotal) || 0;
    },
    showingMatchedHint() {
      // Only render the "M of N" hint when filters/search are active and
      // hiding something — otherwise it's just visual noise.
      return this.turnTotal > this.turns.length;
    },
    toolStats() {
      return this.store?.yeaftToolStats || null;
    },
    toolStatsLoading() {
      return !!this.store?.yeaftToolStatsLoading;
    },
    rankedToolRows() {
      const snap = this.toolStats?.snapshot || {};
      const rows = Object.entries(snap).map(([name, rec]) => ({ name, ...rec }));
      const seen = new Set(rows.map(r => r.name));
      const registered = Array.isArray(this.toolStats?.registered) ? this.toolStats.registered : [];
      for (const name of registered) {
        if (typeof name !== 'string' || !name || seen.has(name)) continue;
        rows.push({
          name,
          callCount: 0,
          errorCount: 0,
          errorRate: 0,
          avgMs: 0,
          p50Ms: 0,
          p95Ms: 0,
          lastCalledAt: null,
          lastError: null,
        });
        seen.add(name);
      }
      rows.sort((a, b) => {
        const diff = (b.callCount || 0) - (a.callCount || 0);
        return diff !== 0 ? diff : a.name.localeCompare(b.name);
      });
      return rows;
    },
    unusedToolRows() {
      return Array.isArray(this.toolStats?.unused) ? this.toolStats.unused : [];
    },
    toolStatsFetchedAtLabel() {
      const t = this.toolStats?.fetchedAt;
      if (!t) return '';
      try { return new Date(t).toLocaleTimeString(); } catch { return ''; }
    },
    // v0.1.755: latest dream pass for the active session (auto + manual share
    // this surface; user only cares about the most recent run).
    dreamLatest() {
      return (this.store && this.store.yeaftDreamLatestForActiveSession) || null;
    },
    dreamLatestLabel() {
      const d = this.dreamLatest;
      if (!d) return '';
      if (d.status === 'running') {
        return `running · ${d.phase || '...'}`;
      }
      if (d.status === 'error') {
        return `error · ${d.error || 'unknown'}`;
      }
      if (d.status === 'skipped') {
        return 'skipped';
      }
      const parts = ['done'];
      if (typeof d.mergedCount === 'number') parts.push(`merged ${d.mergedCount}`);
      const metrics = this.formatDreamMetrics(d);
      if (metrics) parts.push(metrics);
      return parts.join(' · ');
    },
    dreamLatestKindLabel() {
      const d = this.dreamLatest;
      if (!d) return '';
      return d.manual ? 'manual' : 'auto';
    },
    dreamSnapshot() {
      return (this.store && this.store.yeaftDreamSnapshotForActiveSession) || null;
    },
    dreamPromptLoad() {
      return (this.store && this.store.yeaftDreamPromptLoadForActiveSession) || null;
    },
    dreamPromptLoadSummary() {
      const d = this.dreamPromptLoad;
      const text = d && typeof d.summary === 'string' ? d.summary.trim() : '';
      return text && d.truncated ? `${text}\n... truncated` : text;
    },
    dreamSnapshotSummary() {
      const s = this.dreamSnapshot;
      const text = s && typeof s.summaryText === 'string' ? s.summaryText.trim() : '';
      return text && s.summaryTruncated ? `${text}\n... truncated` : text;
    },
    dreamSnapshotMemory() {
      const s = this.dreamSnapshot;
      const text = s && typeof s.memoryText === 'string' ? s.memoryText.trim() : '';
      return text && s.memoryTruncated ? `${text}\n... truncated` : text;
    },
    // PR feat-dream-debug-panel-full: full per-event timeline for the
    // active session. Empty array when no events have been recorded yet.
    // Sorted oldest-first (matches the store getter's merge order).
    dreamEvents() {
      const list = (this.store && this.store.yeaftDreamEventsForActiveSession) || [];
      return Array.isArray(list) ? list : [];
    },
    dreamEventCount() {
      return this.dreamEvents.length;
    },
    dreamSessionTitles() {
      const titles = {};
      const add = (id, value) => {
        const title = String(value || '').trim();
        if (id && title) titles[id] = title;
      };
      const sessions = this.sessionsStore?.sessions || {};
      for (const session of Object.values(sessions)) {
        if (!session || !session.id) continue;
        add(session.id, session.name || session.title);
        add(`sessions/${session.id}`, session.name || session.title);
      }
      const activeFilter = this.store?.yeaftActiveSessionFilter;
      if (activeFilter) add(activeFilter, this.store?.yeaftActiveSessionName || this.store?.currentSessionTitle);
      return titles;
    },
    allDreamItems() {
      const store = this.store || {};
      const eventsByScope = store.yeaftDreamEvents || {};
      const events = Object.values(eventsByScope).flatMap((list) => Array.isArray(list) ? list : []);
      return buildDreamDebugItems({
        latest: store.yeaftDreamLatest || {},
        snapshots: store.yeaftDreamSnapshots || {},
        promptLoads: store.yeaftDreamPromptLoads || {},
        events,
        sessionTitles: this.dreamSessionTitles,
      });
    },
    dreamItems() {
      return filterDreamDebugItems(this.allDreamItems, this.dreamItemSearch);
    },
    activeDreamItem() {
      if (!this.activeDreamItemKey) return null;
      return this.dreamItems.find((item) => item.key === this.activeDreamItemKey) || null;
    },
    activeDreamRequestEvents() {
      const item = this.activeDreamItem;
      if (!item) return [];
      return item.events.filter((evt) => evt && (
        evt.request || evt.response || evt.rawRequest || evt.rawResponse || evt.systemPrompt || this.dreamLoopUserContent(evt)
      ));
    },
  },
  mounted() {
    // fix-vp-multi-thread (bug 4): hydrate from the agent's persistent
    // SQLite trace as soon as the panel is mounted. Previously the panel
    // only ever showed turns observed live via `yeaft_output` events, so
    // anything before the panel was opened was invisible — even though
    // the trace had captured it. Pull the most recent 5 request loops and
    // 5 dream events so the panel is useful from frame 1 without flooding.
    if (this.store && typeof this.store.loadYeaftDebugHistory === 'function') {
      this.store.loadYeaftDebugHistory({ limit: 5, dreamLimit: 5 });
    }
  },
  methods: {
    debugSessionId(turn) {
      return this.formatDebugSessionId((turn && (turn.sessionId || turn.groupId)) || '');
    },
    debugDreamSessionId(evt) {
      return this.formatDebugSessionId((evt && (evt.sessionId || evt.groupId)) || '');
    },
    formatDebugSessionId(id) {
      const raw = String(id || '');
      return raw.startsWith('grp_') ? raw.slice(4) : raw;
    },
    toggleTurn(turnId) {
      this.expandedTurns = { ...this.expandedTurns, [turnId]: !this.expandedTurns[turnId] };
    },
    // PR feat-dream-debug-panel-full: toggle the expanded event timeline
    // under the Dream row.
    toggleDream() {
      this.dreamExpanded = !this.dreamExpanded;
    },
    // PR feat-dream-debug-panel-full: human-readable one-line detail for
    // a single dream event in the timeline. Falls back to phase + status
    // when no richer detail is available so every event shows something.
    dreamEventDetail(evt) {
      if (!evt) return '';
      const phase = evt.phase || 'unknown';
      const parts = [];
      // Per-phase rich detail: prefer the most informative field per phase.
      let matched = true;
      if (phase === 'start') {
        parts.push(evt.manual ? 'manual trigger' : 'auto trigger');
      } else if (phase === 'load-diff') {
        if (this.debugDreamSessionId(evt)) parts.push(`session ${this.debugDreamSessionId(evt)}`);
      } else if (phase === 'triage') {
        if (typeof evt.segments === 'number') parts.push(`${evt.segments} segs`);
        if (typeof evt.actions === 'number') parts.push(`${evt.actions} actions`);
        if (evt.status) parts.push(evt.status);
      } else if (phase === 'merge') {
        if (typeof evt.targets === 'number') parts.push(`${evt.targets} targets`);
      } else if (phase === 'apply') {
        if (evt.target) parts.push(evt.target);
        if (evt.status) parts.push(evt.status);
        if (typeof evt.mergedCount === 'number') parts.push(`merged ${evt.mergedCount}`);
      } else if (phase === 'done') {
        const sessions = typeof evt.sessions === 'number' ? evt.sessions : evt.groups;
        if (typeof sessions === 'number') parts.push(`${sessions} sessions`);
        if (typeof evt.targets === 'number') parts.push(`${evt.targets} targets`);
        if (typeof evt.duration === 'number') parts.push(this.formatMs(evt.duration));
      } else if (phase === 'result') {
        parts.push(evt.success ? 'success' : 'error');
        if (typeof evt.entriesCreated === 'number') parts.push(`entries ${evt.entriesCreated}`);
        if (this.formatDreamMetrics(evt)) parts.push(this.formatDreamMetrics(evt));
        if (!evt.success && evt.error) parts.push(evt.error);
        if (evt.skipped) parts.push(`skipped: ${evt.skippedReason || 'unknown'}`);
      } else {
        matched = false;
      }
      // Generic fallback: if the phase wasn't one we know, OR a known
      // phase produced no parts (runner grew a new field shape), show
      // every scalar field so the panel never silently goes blank. This
      // makes new runner phases visible as soon as they ship instead of
      // requiring a UI update lockstep.
      if (!matched || parts.length === 0) {
        const skip = new Set(['type', 'phase', 'sessionId', 'groupId', 'target', 'ts', 'at']);
        for (const [k, v] of Object.entries(evt)) {
          if (skip.has(k)) continue;
          if (v === null || v === undefined) continue;
          if (typeof v === 'object') continue;
          parts.push(`${k}=${v}`);
        }
      }
      if (evt.error && !parts.includes(evt.error)) parts.unshift(`error: ${evt.error}`);
      return parts.join(' · ');
    },
    // PR feat-dream-debug-panel-full: status label used to colorize a
    // timeline row (matches the same class names as the Dream summary).
    dreamEventStatus(evt) {
      if (!evt) return 'running';
      if (evt.status === 'skipped' || evt.skipped) return 'skipped';
      if (evt.status === 'error' || evt.phase === 'error') return 'error';
      if (evt.status === 'done' || evt.status === 'success' || evt.phase === 'done') return 'success';
      if (evt.phase === 'result') return evt.success ? 'success' : 'error';
      return 'running';
    },
    dreamEventTrigger(evt) {
      if (!evt) return '-';
      if (evt.trigger) return evt.trigger;
      if (evt.source) return evt.source;
      if (evt.manual === true) return 'manual';
      if (evt.manual === false) return 'auto';
      return '-';
    },
    dreamEventCall(evt) {
      if (!evt) return '-';
      const phase = evt.phase || 'unknown';
      const status = evt.status || '';
      if (phase === 'start') return 'scheduler -> runDream';
      if (phase === 'load-diff') return 'runDream -> loadSessionDiff';
      if (phase === 'triage') return status ? `triageSessionSegments · ${status}` : 'triageSessionSegments';
      if (phase === 'merge') return 'mergeByTarget';
      if (phase === 'apply') return status ? `applyMergedTarget · ${status}` : 'applyMergedTarget';
      if (phase === 'done') return 'runDream completed';
      if (phase === 'result') return 'web-bridge -> yeaft_dream_result';
      return phase;
    },
    dreamEventLocation(evt) {
      if (!evt) return '-';
      if (evt.target) return evt.target;
      if (evt.scope) return evt.scope;
      if (this.debugDreamSessionId(evt)) return `session/${this.debugDreamSessionId(evt)}`;
      if (evt.vpId) return `vp/${evt.vpId}`;
      return '-';
    },
    dreamEventResult(evt) {
      if (!evt) return '-';
      const parts = [];
      if (evt.skipped) parts.push(`skipped: ${evt.skippedReason || 'unknown'}`);
      if (evt.reason) parts.push(`reason: ${evt.reason}`);
      if (typeof evt.entriesCreated === 'number') parts.push(`entries ${evt.entriesCreated}`);
      if (typeof evt.targetsApplied === 'number') parts.push(`applied ${evt.targetsApplied}`);
      if (typeof evt.sessionsProcessed === 'number') parts.push(`sessions ${evt.sessionsProcessed}`);
      if (typeof evt.sessionsSkipped === 'number') parts.push(`skipped sessions ${evt.sessionsSkipped}`);
      if (typeof evt.segments === 'number') parts.push(`segments ${evt.segments}`);
      if (typeof evt.actions === 'number') parts.push(`actions ${evt.actions}`);
      if (typeof evt.targets === 'number') parts.push(`targets ${evt.targets}`);
      if (typeof evt.duration === 'number') parts.push(this.formatMs(evt.duration));
      if (this.formatDreamMetrics(evt)) parts.push(this.formatDreamMetrics(evt));
      if (Array.isArray(evt.targetErrors) && evt.targetErrors.length > 0) {
        parts.push(`errors ${evt.targetErrors.length}: ${this.truncate(evt.targetErrors.map(e => e.target ? `${e.target}: ${e.error}` : e.error).join('; '), 160)}`);
      }
      if (evt.error) parts.push(`error: ${evt.error}`);
      return parts.length > 0 ? parts.join(' · ') : this.dreamEventDetail(evt);
    },
    // feat-dream-debug-detail: classify a dream event so the template
    // can render the right body. `loop` = an LLM call (has prompt +
    // response), `turn_close` = pass-level metrics, `dream_run` =
    // overall status, `progress` = phase event.
    dreamEventKind(evt) {
      if (!evt) return 'progress';
      const t = evt.type;
      if (t === 'loop') return 'loop';
      if (t === 'turn_close' || t === 'dream_turn_close') return 'turn_close';
      if (t === 'dream_run' && evt.phase === 'result') return 'result';
      return 'progress';
    },
    isDreamEventExpandable(evt) {
      const kind = this.dreamEventKind(evt);
      if (kind === 'loop') return !!(evt && (evt.systemPrompt || evt.response || (Array.isArray(evt.messages) && evt.messages.length > 0)));
      if (kind === 'turn_close' || kind === 'result') return !!(evt && (evt.metrics || evt.passBreakdown || evt.resultSummary));
      if (kind === 'progress') {
        return !!(evt && (evt.memoryMdPreview || evt.summaryMdPreview));
      }
      return false;
    },
    // Review fix (Fowler+Torvalds Minor): use a stable id so a ring-shift
    // can't land an open-state on the wrong row. `at` (epoch ms) +
    // turnId + (phase|type) is unique-enough for the panel's scale.
    dreamEventKey(evt) {
      if (!evt) return '';
      return `${evt.at || 0}:${evt.turnId || ''}:${evt.phase || evt.type || ''}`;
    },
    toggleDreamEvent(evt) {
      const key = this.dreamEventKey(evt);
      if (!key) return;
      // Review fix (Torvalds Important): prune stale keys so a long
      // session that scrolls thousands of dream events through the
      // bounded ring doesn't leak forever in expandedDreamEvents.
      const live = new Set(this.dreamEvents.map((e) => this.dreamEventKey(e)));
      const next = {};
      for (const [k, v] of Object.entries(this.expandedDreamEvents)) {
        if (live.has(k)) next[k] = v;
      }
      next[key] = !next[key];
      this.expandedDreamEvents = next;
    },
    isDreamEventExpanded(evt) {
      return !!this.expandedDreamEvents[this.dreamEventKey(evt)];
    },
    // Best-effort: render the user message a loop sent to the LLM. Loop
    // events emitted by session-wiring have `messages: [{role:'user',content:str}]`.
    dreamLoopUserContent(evt) {
      const messages = Array.isArray(evt?.messages) ? evt.messages : [];
      for (const m of messages) {
        if (m && m.role === 'user') {
          if (typeof m.content === 'string') return m.content;
          if (m.content != null) return JSON.stringify(m.content, null, 2);
        }
      }
      return '';
    },
    formatPassBreakdown(pb) {
      if (!pb || typeof pb !== 'object') return '';
      const out = [];
      for (const [pass, rec] of Object.entries(pb)) {
        if (!rec) continue;
        const parts = [pass + ':'];
        if (rec.llmCallCount) parts.push(`${rec.llmCallCount} call`);
        if (rec.totalTokens) parts.push(`${this.formatTokens(rec.totalTokens)} tok`);
        if (rec.durationMs) parts.push(this.formatMs(rec.durationMs));
        out.push(parts.join(' '));
      }
      return out.join(' · ');
    },
    copyDreamEventAsMarkdown(evt) {
      if (!evt) return;
      const kind = this.dreamEventKind(evt);
      const lines = [`# Dream event · ${kind} · ${evt.phase || evt.type || '?'}`];
      lines.push(`- at: ${this.formatTimestamp(evt.at)}`);
      if (evt.turnId) lines.push(`- turnId: ${evt.turnId}`);
      if (this.debugDreamSessionId(evt)) lines.push(`- sessionId: ${this.debugDreamSessionId(evt)}`);
      if (evt.target) lines.push(`- target: ${evt.target}`);
      if (kind === 'loop') {
        lines.push(`- pass: ${evt.pass || '-'}`);
        lines.push(`- model: ${evt.model || '-'}`);
        lines.push(`- latency: ${this.formatMs(evt.latencyMs)}`);
        const u = evt.usage || {};
        lines.push(`- tokens: ${this.formatUsageBreakdown(u)}`);
        lines.push('', '## System prompt', '```', evt.systemPrompt || '', '```');
        lines.push('', '## User message', '```', this.dreamLoopUserContent(evt), '```');
        lines.push('', '## Response', '```', evt.response || '', '```');
      } else if (kind === 'turn_close') {
        lines.push(`- loopCount: ${evt.loopCount ?? evt.metrics?.llmCallCount ?? 0}`);
        lines.push(`- totalTokens: ${evt.totalTokens ?? evt.metrics?.totalTokens ?? 0}`);
        lines.push(`- totalMs: ${evt.totalMs ?? evt.metrics?.durationMs ?? 0}`);
        const pb = evt.passBreakdown || evt.metrics?.passBreakdown;
        if (pb) {
          lines.push('', '## Pass breakdown', '```json', JSON.stringify(pb, null, 2), '```');
        }
      } else if (kind === 'result') {
        lines.push(`- status: ${evt.status || '-'}`);
        if (evt.error) lines.push(`- error: ${evt.error}`);
        if (evt.resultSummary) {
          lines.push('', '## Result summary', '```json', JSON.stringify(evt.resultSummary, null, 2), '```');
        }
        if (evt.metrics) {
          lines.push('', '## Metrics', '```json', JSON.stringify(evt.metrics, null, 2), '```');
        }
      } else {
        if (evt.memoryMdPreview) lines.push('', '## memory.md (preview)', '```', evt.memoryMdPreview, '```');
        if (evt.summaryMdPreview) lines.push('', '## summary.md (preview)', '```', evt.summaryMdPreview, '```');
        if (!evt.memoryMdPreview && !evt.summaryMdPreview) {
          lines.push('', '## Raw', '```json', JSON.stringify(evt, null, 2), '```');
        }
      }
      this.copyText(lines.join('\n'), 'dream event');
    },
    toggleLoop(turnId, loopNumber) {
      const key = `${turnId}#${loopNumber}`;
      this.expandedLoops = { ...this.expandedLoops, [key]: !this.expandedLoops[key] };
    },
    toggleSection(turnId, section) {
      const key = `${turnId}#${section}`;
      this.expandedSections = { ...this.expandedSections, [key]: !this.expandedSections[key] };
    },
    isLoopExpanded(turnId, loopNumber) {
      return !!this.expandedLoops[`${turnId}#${loopNumber}`];
    },
    isSectionExpanded(turnId, section) {
      return !!this.expandedSections[`${turnId}#${section}`];
    },
    // ─── Formatting helpers ─────────────────────────────────────
    formatMs(ms) {
      if (ms == null) return '-';
      if (ms < 1000) return `${ms}ms`;
      return `${(ms / 1000).toFixed(1)}s`;
    },
    formatTokens(n) {
      const v = Number(n) || 0;
      if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
      return String(v);
    },
    usageTotalInputTokens(usage) {
      const u = usage || {};
      if (Number.isFinite(Number(u.totalInputTokens))) return Number(u.totalInputTokens);
      return (Number(u.inputTokens) || 0) + (Number(u.cacheReadTokens) || 0) + (Number(u.cacheWriteTokens) || 0);
    },
    usageTotalTokens(usage) {
      const u = usage || {};
      if (Number.isFinite(Number(u.totalTokens))) return Number(u.totalTokens);
      return this.usageTotalInputTokens(u) + (Number(u.outputTokens) || 0);
    },
    formatUsageBreakdown(usage) {
      const u = usage || {};
      const cacheRead = Number(u.cacheReadTokens) || 0;
      const cacheWrite = Number(u.cacheWriteTokens) || 0;
      const totalInput = this.usageTotalInputTokens(u);
      const output = Number(u.outputTokens) || 0;
      const total = this.usageTotalTokens(u);
      let text = `${totalInput} in / ${output} out / ${total} total`;
      if (cacheRead || cacheWrite) {
        if (totalInput === (Number(u.inputTokens) || 0)) {
          text += ` (input includes cache read ${cacheRead}, cache write ${cacheWrite})`;
        } else {
          text += ` (fresh ${Number(u.inputTokens) || 0}, cache read ${cacheRead}, cache write ${cacheWrite})`;
        }
      }
      return text;
    },
    formatDreamMetrics(d) {
      if (!d) return '';
      const parts = [];
      if (typeof d.durationMs === 'number') parts.push(this.formatMs(d.durationMs));
      if (typeof d.llmCallCount === 'number') parts.push(`${d.llmCallCount} LLM calls`);
      if (typeof d.totalTokens === 'number') parts.push(`${this.formatTokens(d.totalTokens)} tok`);
      return parts.join(' · ');
    },
    formatTimestamp(ms) {
      if (!ms) return '';
      try { return new Date(ms).toLocaleTimeString(); } catch { return ''; }
    },
    // feat-debug-timestamp: HH:MM:SS form for per-request rows. Wraps
    // the pure helper so the template only needs `formatClock(loop.at)`.
    formatClock(value) {
      return formatClockTime(value);
    },
    // feat-debug-timestamp: derive a clock time for a loop when the
    // engine didn't stamp `at` (legacy / SQLite-hydrated loops). We
    // synthesize it from the parent turn's openedAt + the cumulative
    // latency of earlier loops in the same turn, so the column still
    // makes sense in chronological terms even for old data.
    loopClockTime(turn, loop) {
      if (loop && typeof loop.at === 'number') return this.formatClock(loop.at);
      if (!turn || typeof turn.openedAt !== 'number') return '';
      const loops = turn.loops || [];
      let cumulative = 0;
      for (const lp of loops) {
        if (!lp) continue;
        if (lp === loop || lp.loopNumber === loop.loopNumber) break;
        if (Number.isFinite(lp.latencyMs)) cumulative += lp.latencyMs;
      }
      if (Number.isFinite(loop.latencyMs)) cumulative += loop.latencyMs;
      return this.formatClock(turn.openedAt + cumulative);
    },
    // feat-debug-token-breakdown: per-loop estimated split between
    // message (user/assistant prose) and tool (tool_use + tool_result)
    // traffic. The real provider totals come from loop.usage; we use
    // the helper to compute a *ratio* and apportion the real totals
    // into the two buckets so the sum still equals usage.totalTokens.
    loopTokenBreakdown(loop) {
      if (!loop) {
        return {
          inputMessage: 0, inputTool: 0,
          outputMessage: 0, outputTool: 0,
          inputTotal: 0, outputTotal: 0, total: 0,
        };
      }
      const est = splitTokenBreakdown(loop);
      const u = loop.usage || {};
      const realIn = Math.max(0, this.usageTotalInputTokens(u));
      const realOut = Math.max(0, Number(u.outputTokens) || 0);
      const realTotal = Math.max(0, this.usageTotalTokens(u) || (realIn + realOut));
      const inSplit = apportionToBuckets(realIn, est.inputMessageTokens, est.inputToolTokens);
      const outSplit = apportionToBuckets(realOut, est.outputMessageTokens, est.outputToolTokens);
      return {
        inputMessage: inSplit.message,
        inputTool: inSplit.tool,
        outputMessage: outSplit.message,
        outputTool: outSplit.tool,
        inputTotal: realIn,
        outputTotal: realOut,
        total: realTotal,
      };
    },
    // feat-debug-token-breakdown: attach per-loop and per-turn
    // breakdowns once per computed-turn construction. The template reads
    // `loop.tokenBreakdown` / `turn.tokenBreakdown` directly so Vue patching
    // does not repeatedly walk large `loop.messages` arrays.
    decorateTurnTokenBreakdowns(turn) {
      if (!turn) return turn;
      const acc = { inputMessage: 0, inputTool: 0, outputMessage: 0, outputTool: 0, inputTotal: 0, outputTotal: 0, total: 0 };
      const loops = ((turn && turn.loops) || []).map((loop) => {
        const b = this.loopTokenBreakdown(loop);
        acc.inputMessage += b.inputMessage;
        acc.inputTool += b.inputTool;
        acc.outputMessage += b.outputMessage;
        acc.outputTool += b.outputTool;
        acc.inputTotal += b.inputTotal;
        acc.outputTotal += b.outputTotal;
        acc.total += b.total;
        return { ...loop, tokenBreakdown: b };
      });
      const tokenBreakdown = {
        ...acc,
        messageTotal: acc.inputMessage + acc.outputMessage,
        toolTotal: acc.inputTool + acc.outputTool,
      };
      return { ...turn, loops, tokenBreakdown };
    },
    truncate(text, max) {
      const s = String(text || '');
      if (s.length <= max) return s;
      return s.slice(0, max) + '…';
    },
    toolsForLoop(turn, loopOrNumber) {
      const loop = typeof loopOrNumber === 'object'
        ? loopOrNumber
        : ((turn?.loops || []).find(l => l && l.loopNumber === loopOrNumber) || { loopNumber: loopOrNumber });
      const loopNumber = loop?.loopNumber || 0;
      const results = ((turn && turn.tools) || []).filter(t => t && t.loopNumber === loopNumber);
      const usedResults = new Set();
      const calls = Array.isArray(loop?.toolCalls) ? loop.toolCalls : [];
      const rows = [];

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i] || {};
        const callId = call.id || call.callId || call.tool_call_id || null;
        let resultIndex = callId
          ? results.findIndex((r, ri) => !usedResults.has(ri) && r.callId === callId)
          : -1;
        if (resultIndex < 0) {
          // Only fall back to name matching for legacy records that have no
          // call id. Never attach another modern call's result by name: loops
          // commonly contain several same-name tools running in parallel.
          resultIndex = results.findIndex((r, ri) => !usedResults.has(ri)
            && !r.callId
            && r.name === call.name);
        }
        const result = resultIndex >= 0 ? results[resultIndex] : null;
        if (resultIndex >= 0) usedResults.add(resultIndex);
        rows.push(this.normalizeToolDebugRow(loopNumber, call, result, i));
      }

      for (let i = 0; i < results.length; i++) {
        if (usedResults.has(i)) continue;
        rows.push(this.normalizeToolDebugRow(loopNumber, null, results[i], rows.length));
      }
      return rows;
    },
    normalizeToolDebugRow(loopNumber, call, result, index) {
      const hasResult = !!result;
      const input = call && Object.prototype.hasOwnProperty.call(call, 'input') ? call.input : undefined;
      const callId = (call && (call.id || call.callId || call.tool_call_id)) || result?.callId || null;
      const name = (call && call.name) || result?.name || '?';
      return {
        loopNumber,
        index,
        callId,
        name,
        input,
        rawCall: call || null,
        rawResult: result || null,
        hasResult,
        isRunning: !hasResult,
        isError: !!result?.isError,
        durationMs: result?.durationMs || 0,
        toolOutput: result?.toolOutput == null ? null : String(result.toolOutput),
      };
    },
    toolDetailKey(turnId, loopNumber, tool, index = 0) {
      return `${turnId}#${loopNumber}#${tool?.callId || tool?.name || 'tool'}#${index}`;
    },
    isToolDetailExpanded(turnId, loopNumber, tool, index) {
      return !!this.expandedToolDetails[this.toolDetailKey(turnId, loopNumber, tool, index)];
    },
    toggleToolDetail(turnId, loopNumber, tool, index) {
      const key = this.toolDetailKey(turnId, loopNumber, tool, index);
      this.expandedToolDetails = { ...this.expandedToolDetails, [key]: !this.expandedToolDetails[key] };
    },
    toolStatusClass(tool) {
      if (tool?.isRunning) return 'running';
      return tool?.isError ? 'err' : 'ok';
    },
    toolStatusLabel(tool) {
      if (tool?.isRunning) return this.$t ? this.$t('yeaft.debugToolRunning') : 'running';
      return tool?.isError ? '✗' : '✓';
    },
    toolInputText(tool) {
      if (!tool) return '';
      if (tool.input !== undefined) return JSON.stringify(tool.input ?? null, null, 2);
      if (tool.rawCall) return JSON.stringify(tool.rawCall, null, 2);
      return JSON.stringify(tool.rawResult || tool, null, 2);
    },
    toolOutputText(tool) {
      if (!tool) return '';
      if (tool.isRunning) return this.$t ? this.$t('yeaft.debugToolRunningNoResult') : 'Running; no result yet';
      if (tool.toolOutput != null) return tool.toolOutput;
      if (tool.rawResult) return JSON.stringify(tool.rawResult, null, 2);
      return '';
    },
    reflectionsForLoop(turn, loopNumber) {
      const all = (turn && turn.reflections) || [];
      return all.filter(r => r && (r.loopNumber === loopNumber
        // Fallback: deferred T2 emits without a stable loopNumber land
        // under the originating turn but no specific loop. Show under
        // the last loop in that case so they aren't lost.
        || (r.loopNumber == null && loopNumber === turn.loopCount)));
    },
    loopMetaSummary(loop) {
      const tools = (loop.toolCalls || []).length;
      return tools > 0 ? `tools×${tools}` : 'end_turn';
    },
    assistantResponseForLoop(loop) {
      if (!loop) return '';
      if (loop.response) return typeof loop.response === 'string' ? loop.response : JSON.stringify(loop.response, null, 2);
      const messages = Array.isArray(loop.messages) ? loop.messages : [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m || m.role !== 'assistant') continue;
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
          const parts = m.content
            .map(part => {
              if (!part) return '';
              if (typeof part === 'string') return part;
              if (typeof part.text === 'string') return part.text;
              return '';
            })
            .filter(Boolean);
          if (parts.length > 0) return parts.join('\n');
        }
        if (m.content != null) return JSON.stringify(m.content, null, 2);
      }
      return '';
    },
    showAssistantResponse(turnId, loopNumber) {
      const loopKey = `${turnId}#${loopNumber}`;
      const sectionKey = `${turnId}#asst-${loopNumber}`;
      this.expandedLoops = { ...this.expandedLoops, [loopKey]: true };
      this.expandedSections = { ...this.expandedSections, [sectionKey]: true };
    },
    setActiveDreamItem(key) {
      this.activeDreamItemKey = this.activeDreamItemKey === key ? null : (key || null);
    },
    isDreamSegmentExpanded(segment) {
      return !!this.expandedDreamSegments[segment?.id];
    },
    toggleDreamSegment(segment) {
      if (!segment?.id) return;
      this.expandedDreamSegments = {
        ...this.expandedDreamSegments,
        [segment.id]: !this.expandedDreamSegments[segment.id],
      };
    },
    dreamPreview(value, limit = 180) {
      return previewText(value, limit);
    },
    formatDebugValue(value) {
      if (value == null) return '';
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    },
    setActiveTab(tab) {
      this.activeTab = tab === 'toolStats' || tab === 'dream' ? tab : 'requests';
      if (this.activeTab === 'toolStats' && !this.toolStats && !this.toolStatsLoading) {
        this.refreshToolStats();
      }
    },
    refreshToolStats() {
      if (this.store && typeof this.store.fetchYeaftToolStats === 'function') {
        this.store.fetchYeaftToolStats();
      }
    },
    formatPct(rate) {
      if (!Number.isFinite(rate) || rate === 0) return '0%';
      return `${(rate * 100).toFixed(1)}%`;
    },
    formatLastCalled(iso) {
      if (typeof iso !== 'string' || !iso) return 'never';
      const t = Date.parse(iso);
      if (Number.isNaN(t)) return iso;
      const ageMs = Date.now() - t;
      if (ageMs < 60_000) return 'just now';
      if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
      if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
      return `${Math.floor(ageMs / 86_400_000)}d ago`;
    },

    // ─── Copy helpers ──────────────────────────────────────────
    copyText(text, label) {
      const s = (text == null) ? '' : (typeof text === 'string' ? text : JSON.stringify(text, null, 2));
      try {
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(s);
        } else {
          // Fallback for old browsers / non-secure contexts.
          const ta = document.createElement('textarea');
          ta.value = s;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); } catch { /* ignore */ }
          document.body.removeChild(ta);
        }
        this.copiedFlash = label || 'copied';
        this.copiedFlashAt = Date.now();
        setTimeout(() => {
          if (Date.now() - this.copiedFlashAt >= 1400) this.copiedFlash = null;
        }, 1500);
      } catch { /* swallow — copy is best-effort */ }
    },
    copyToolInput(turn, tool) {
      if (tool && (tool.input !== undefined || tool.rawCall || tool.rawResult)) {
        this.copyText(this.toolInputText(tool), 'tool input');
        return;
      }
      // Find the matching toolCalls entry inside the loops to fetch
      // input args verbatim. Fall back to the tool record if not found.
      for (const loop of turn.loops || []) {
        for (const tc of loop.toolCalls || []) {
          if (tc && tc.id === tool.callId) {
            this.copyText(JSON.stringify(tc.input ?? null, null, 2), 'tool input');
            return;
          }
        }
      }
      this.copyText(JSON.stringify(tool, null, 2), 'tool record');
    },
    copyToolOutput(turn, tool) {
      if (tool && (tool.isRunning || tool.rawResult || tool.toolOutput != null)) {
        this.copyText(this.toolOutputText(tool), 'tool output');
        return;
      }
      // Prefer the raw debug tool record. `loop.messages[]` contains the
      // model-context copy, which may be intentionally truncated.
      if (tool && tool.toolOutput != null) {
        this.copyText(tool.toolOutput, 'tool output');
        return;
      }
      // Legacy traces do not have raw toolOutput; fall back to the model
      // snapshot so older debug rows remain copyable.
      for (const loop of turn.loops || []) {
        for (const m of loop.messages || []) {
          if (m && m.role === 'tool' && m.toolCallId === tool.callId) {
            this.copyText(typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2), 'tool output');
            return;
          }
        }
      }
      this.copyText('(tool output not in snapshot)', 'tool output');
    },
    copyTurnAsMarkdown(turn) {
      const lines = [];
      lines.push(`# Turn ${turn.turnId}`);
      lines.push('');
      lines.push(`- VP: ${turn.vpId || '-'}`);
      lines.push(`- Session: ${this.debugSessionId(turn) || '-'}`);
      lines.push(`- Loops: ${turn.loopCount || (turn.loops && turn.loops.length) || 0}`);
      lines.push(`- Total: ${this.formatMs(turn.totalMs)} / ${this.formatTokens(turn.totalTokens)} tok`);
      lines.push('');
      lines.push('## User prompt');
      lines.push('');
      lines.push('```');
      lines.push(turn.userPrompt || '');
      lines.push('```');
      lines.push('');
      if (turn.memoryLoaded && turn.memoryLoaded.length > 0) {
        lines.push(`## Memory loaded (${turn.memoryLoaded.length})`);
        for (const m of turn.memoryLoaded) {
          lines.push(`- ${m.id || '?'}  score=${m.score == null ? '-' : m.score.toFixed(3)}  kind=${m.kind || '-'}`);
        }
        lines.push('');
      }
      if (turn.memoryAdjust) {
        const a = turn.memoryAdjust;
        lines.push(`## Memory adjust  (reason: ${a.reason || '-'})`);
        lines.push(`- added: ${a.added || 0}`);
        lines.push(`- evicted: ${a.evicted || 0}`);
        lines.push(`- skipped: ${a.skipped || 0}`);
        lines.push('');
      }
      const loops = turn.loops || [];
      for (const loop of loops) {
        lines.push(`## Loop ${loop.loopNumber}  ${loop.model}`);
        const u = loop.usage || {};
        lines.push(`- in/out/total: ${this.formatUsageBreakdown(u)}`);
        lines.push(`- latency: ${this.formatMs(loop.latencyMs)}  ttfb: ${this.formatMs(loop.ttfbMs)}`);
        lines.push(`- stopReason: ${loop.stopReason || '-'}`);
        const tools = this.toolsForLoop(turn, loop.loopNumber);
        if (tools.length > 0) {
          lines.push('');
          lines.push(`### Tools (${tools.length})`);
          for (const t of tools) {
            const status = t.isRunning ? 'running' : (t.isError ? 'ERROR' : 'ok');
            lines.push(`- ${t.name}  ${status}  ${t.isRunning ? '-' : this.formatMs(t.durationMs)}`);
          }
        }
        const assistantText = this.assistantResponseForLoop(loop);
        if (assistantText) {
          lines.push('');
          lines.push('### Assistant text');
          lines.push('```');
          lines.push(assistantText);
          lines.push('```');
        }
        lines.push('');
      }
      this.copyText(lines.join('\n'), 'turn markdown');
    },
  },
  template: `
    <div class="yeaft-debug-panel">
      <div class="yeaft-debug-header">
        <span class="yeaft-debug-title">{{ $t('yeaft.debug') }}</span>
        <div class="yeaft-debug-header-actions">
          <span v-if="copiedFlash" class="yeaft-debug-copied-flash">{{ copiedFlash }}</span>
          <button
            type="button"
            class="yeaft-debug-close"
            @click="$emit('close')"
            :title="$t('yeaft.debugClose')"
            :aria-label="$t('yeaft.debugClose')"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M18.3 5.71 12 12l6.3 6.29-1.41 1.41L10.59 13.41 4.29 19.7 2.88 18.29 9.17 12 2.88 5.71 4.29 4.3l6.3 6.29 6.3-6.29 1.41 1.41z"/></svg>
          </button>
        </div>
      </div>

      <div class="yeaft-debug-tabs" role="tablist" :aria-label="$t('yeaft.debug')">
        <button
          type="button"
          class="yeaft-debug-tab"
          :class="{ active: activeTab === 'toolStats' }"
          role="tab"
          :aria-selected="activeTab === 'toolStats'"
          @click="setActiveTab('toolStats')"
        >
          {{ $t('yeaft.debugTabToolStats') }}
        </button>
        <button
          type="button"
          class="yeaft-debug-tab"
          :class="{ active: activeTab === 'dream' }"
          role="tab"
          :aria-selected="activeTab === 'dream'"
          @click="setActiveTab('dream')"
        >
          {{ $t('yeaft.debugTabDream') }}
          <span class="yeaft-debug-tab-count" v-if="dreamEventCount > 0">{{ dreamEventCount }}</span>
        </button>
        <button
          type="button"
          class="yeaft-debug-tab"
          :class="{ active: activeTab === 'requests' }"
          role="tab"
          :aria-selected="activeTab === 'requests'"
          @click="setActiveTab('requests')"
        >
          {{ $t('yeaft.debugTabRequestLog') }}
          <span class="yeaft-debug-tab-count" v-if="turns.length > 0">
            <template v-if="showingMatchedHint">{{ turns.length }} / {{ turnTotal }}</template>
            <template v-else>{{ turns.length }}</template>
          </span>
        </button>
      </div>

      <div v-if="activeTab === 'toolStats'" class="yeaft-debug-tool-stats" role="tabpanel">
        <div class="yeaft-debug-tool-stats-header">
          <div>
            <div class="yeaft-debug-tool-stats-title">{{ $t('yeaft.toolStats.title') }}</div>
            <div v-if="toolStatsFetchedAtLabel" class="yeaft-debug-tool-stats-meta">
              {{ $t('yeaft.toolStats.fetchedAt') }} {{ toolStatsFetchedAtLabel }}
            </div>
          </div>
          <button class="yeaft-debug-show-btn" @click="refreshToolStats" :disabled="toolStatsLoading">
            {{ $t('yeaft.toolStats.refresh') }}
          </button>
        </div>
        <div v-if="toolStats && toolStats.error" class="tool-stats-error">{{ toolStats.error }}</div>
        <div v-else-if="toolStatsLoading && !toolStats" class="tool-stats-loading">{{ $t('yeaft.toolStats.loading') }}</div>
        <div v-else-if="!toolStats" class="tool-stats-empty">{{ $t('yeaft.toolStats.notLoaded') }}</div>
        <template v-else>
          <div v-if="toolStats.notice" class="tool-stats-banner">{{ toolStats.notice }}</div>
          <div class="yeaft-debug-tool-stats-table-wrap">
            <table class="tool-stats-table">
              <thead>
                <tr>
                  <th>{{ $t('yeaft.toolStats.col.name') }}</th>
                  <th class="num">{{ $t('yeaft.toolStats.col.calls') }}</th>
                  <th class="num">{{ $t('yeaft.toolStats.col.errors') }}</th>
                  <th class="num">{{ $t('yeaft.toolStats.col.errRate') }}</th>
                  <th class="num">{{ $t('yeaft.toolStats.col.p50') }}</th>
                  <th class="num">{{ $t('yeaft.toolStats.col.p95') }}</th>
                  <th class="num">{{ $t('yeaft.toolStats.col.avg') }}</th>
                  <th>{{ $t('yeaft.toolStats.col.last') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="rankedToolRows.length === 0">
                  <td colspan="8" class="tool-stats-empty-row">{{ $t('yeaft.toolStats.empty') }}</td>
                </tr>
                <tr v-for="row in rankedToolRows" :key="row.name">
                  <td class="tool-stats-name">{{ row.name }}</td>
                  <td class="num">{{ row.callCount }}</td>
                  <td class="num">{{ row.errorCount }}</td>
                  <td class="num">{{ formatPct(row.errorRate) }}</td>
                  <td class="num">{{ formatMs(row.p50Ms) }}</td>
                  <td class="num">{{ formatMs(row.p95Ms) }}</td>
                  <td class="num">{{ formatMs(row.avgMs) }}</td>
                  <td class="tool-stats-last">{{ formatLastCalled(row.lastCalledAt) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="yeaft-debug-unused-tools" v-if="unusedToolRows.length > 0">
            <div class="yeaft-debug-section-title">{{ $t('yeaft.toolStats.tabUnused') }}</div>
            <span v-for="name in unusedToolRows" :key="name" class="yeaft-debug-unused-tool">{{ name }}</span>
          </div>
        </template>
      </div>

      <div v-else-if="activeTab === 'dream'" class="yeaft-debug-dream-panel" role="tabpanel">
        <div class="yeaft-debug-dream-toolbar">
          <input
            v-model="dreamItemSearch"
            type="search"
            class="yeaft-debug-dream-search"
            :placeholder="$t('yeaft.dreamDebug.searchPlaceholder')"
          />
          <span class="yeaft-debug-dream-count">{{ dreamItems.length }} / {{ allDreamItems.length }}</span>
        </div>
        <div class="yeaft-debug-dream-list" v-if="dreamItems.length > 0" :aria-label="$t('yeaft.dreamDebug.itemList')">
          <article
            v-for="item in dreamItems"
            :key="item.key"
            class="yeaft-debug-dream-accordion-item"
            :class="{ expanded: activeDreamItem && activeDreamItem.key === item.key }"
          >
            <button
              type="button"
              class="yeaft-debug-dream-item"
              :aria-expanded="activeDreamItem && activeDreamItem.key === item.key ? 'true' : 'false'"
              @click="setActiveDreamItem(item.key)"
            >
              <span class="yeaft-debug-dream-item-main">
                <span class="yeaft-debug-dream-item-title" :title="item.scope">{{ item.title }}</span>
                <span class="yeaft-debug-dream-item-summary">{{ item.subtitle || $t('yeaft.dreamDebug.noSummary') }}</span>
              </span>
              <span class="yeaft-debug-dream-item-meta">
                <span class="yeaft-debug-dream-item-status" :class="'status-' + item.status">{{ item.status }}</span>
                <span class="yeaft-debug-dream-item-segments">{{ item.segmentCount }} {{ $t('yeaft.dreamDebug.segments') }}</span>
                <span class="yeaft-debug-dream-item-time">{{ formatTimestamp(item.lastAt) || '-' }}</span>
              </span>
              <span class="yeaft-debug-dream-item-toggle" aria-hidden="true">{{ activeDreamItem && activeDreamItem.key === item.key ? '−' : '+' }}</span>
            </button>
              <section class="yeaft-debug-dream-detail" v-if="activeDreamItem && activeDreamItem.key === item.key">
              <div class="yeaft-debug-dream-detail-header">
                <div>
                  <div class="yeaft-debug-dream-detail-title">{{ activeDreamItem.title }}</div>
                  <div class="yeaft-debug-dream-detail-subtitle">
                    {{ activeDreamItem.status }} · {{ formatTimestamp(activeDreamItem.lastAt) || '-' }}
                  </div>
                </div>
              </div>

              <div class="yeaft-debug-dream-detail-body">
                <section class="yeaft-debug-dream-card">
                  <div class="yeaft-debug-dream-card-title">{{ $t('yeaft.dreamDebug.overview') }}</div>
                  <div class="yeaft-debug-dream-summary-grid">
                    <span>{{ $t('yeaft.dreamDebug.scope') }}</span>
                    <strong>{{ activeDreamItem.scope }}</strong>
                    <span>{{ $t('yeaft.dreamDebug.sessionId') }}</span>
                    <strong>{{ activeDreamItem.sessionId }}</strong>
                    <span>{{ $t('yeaft.dreamDebug.lastDream') }}</span>
                    <strong>{{ formatTimestamp(activeDreamItem.snapshot && activeDreamItem.snapshot.lastDreamAt) || formatTimestamp(activeDreamItem.lastAt) || '-' }}</strong>
                    <span>{{ $t('yeaft.dreamDebug.messagesCovered') }}</span>
                    <strong>{{ (activeDreamItem.snapshot && activeDreamItem.snapshot.messageCount) || 0 }}</strong>
                    <span>{{ $t('yeaft.dreamDebug.segments') }}</span>
                    <strong>{{ activeDreamItem.segmentCount }}</strong>
                    <span>{{ $t('yeaft.dreamDebug.loadedAt') }}</span>
                    <strong>{{ formatTimestamp(activeDreamItem.snapshot && activeDreamItem.snapshot.loadedAt) || '-' }}</strong>
                  </div>
                </section>

                <section class="yeaft-debug-dream-card">
                  <div class="yeaft-debug-dream-card-title">{{ $t('yeaft.dreamDebug.layers') }}</div>
                  <details class="yeaft-debug-dream-layer" open>
                    <summary>{{ $t('yeaft.dreamDebug.summaryLayer') }}</summary>
                    <pre v-if="activeDreamItem.snapshot && activeDreamItem.snapshot.summaryText" class="yeaft-debug-pre yeaft-debug-scroll-pre">{{ activeDreamItem.snapshot.summaryText }}</pre>
                    <div v-else class="yeaft-debug-dream-event-empty">{{ $t('yeaft.dreamDebug.noSummary') }}</div>
                  </details>
                  <details class="yeaft-debug-dream-layer">
                    <summary>memory.md</summary>
                    <pre v-if="activeDreamItem.snapshot && activeDreamItem.snapshot.memoryText" class="yeaft-debug-pre yeaft-debug-scroll-pre">{{ activeDreamItem.snapshot.memoryText }}</pre>
                    <div v-else class="yeaft-debug-dream-event-empty">{{ $t('yeaft.dreamDebug.noOutput') }}</div>
                  </details>
                  <details class="yeaft-debug-dream-layer">
                    <summary>{{ $t('yeaft.dreamDebug.promptLoadTitle') }}</summary>
                    <pre v-if="activeDreamItem.promptLoad && activeDreamItem.promptLoad.summary" class="yeaft-debug-pre yeaft-debug-scroll-pre">{{ activeDreamItem.promptLoad.summary }}</pre>
                    <div v-else class="yeaft-debug-dream-event-empty">{{ $t('yeaft.dreamDebug.noPromptLoad') }}</div>
                  </details>
                </section>

                <section class="yeaft-debug-dream-card">
                  <div class="yeaft-debug-dream-card-title">{{ $t('yeaft.dreamDebug.segmentTitle') }}</div>
                  <div v-if="activeDreamItem.segments.length > 0" class="yeaft-debug-dream-segments">
                    <article v-for="segment in activeDreamItem.segments" :key="segment.id" class="yeaft-debug-dream-segment">
                      <button type="button" class="yeaft-debug-dream-segment-head" @click="toggleDreamSegment(segment)">
                        <span class="yeaft-debug-dream-segment-toggle" aria-hidden="true">{{ isDreamSegmentExpanded(segment) ? '−' : '+' }}</span>
                        <span class="yeaft-debug-dream-segment-identity">
                          <strong class="yeaft-debug-dream-segment-id">{{ segment.id }}</strong>
                          <em class="yeaft-debug-dream-segment-kind">{{ segment.kind }}</em>
                        </span>
                        <span class="yeaft-debug-dream-segment-tags">{{ segment.tags.join(', ') || '-' }}</span>
                      </button>
                      <div class="yeaft-debug-dream-segment-meta">
                        <span>{{ $t('yeaft.dreamDebug.sourceMessages') }}: {{ segment.sourceMessages.join(', ') || '-' }}</span>
                        <span>{{ $t('yeaft.dreamDebug.createdAt') }}: {{ formatTimestamp(segment.createdAt) || '-' }}</span>
                        <span>{{ $t('yeaft.dreamDebug.updatedAt') }}: {{ formatTimestamp(segment.updatedAt) || '-' }}</span>
                      </div>
                      <p v-if="!isDreamSegmentExpanded(segment)" class="yeaft-debug-dream-segment-preview">{{ dreamPreview(segment.content) }}</p>
                      <div v-else class="yeaft-debug-dream-segment-content">{{ segment.content }}</div>
                    </article>
                  </div>
                  <div v-else class="yeaft-debug-dream-event-empty">{{ $t('yeaft.dreamDebug.noSegments') }}</div>
                </section>

                <section class="yeaft-debug-dream-card">
                  <div class="yeaft-debug-dream-card-title">{{ $t('yeaft.dreamDebug.requestResponse') }}</div>
                  <div v-if="activeDreamRequestEvents.length > 0" class="yeaft-debug-dream-events">
                    <details v-for="evt in activeDreamRequestEvents" :key="dreamEventKey(evt)" class="yeaft-debug-dream-layer">
                      <summary>{{ dreamEventPhaseLabel(evt) }} · {{ formatTimestamp(evt.at || evt.ts) || '-' }}</summary>
                      <div class="yeaft-debug-section" v-if="evt.systemPrompt">
                        <div class="yeaft-debug-section-row"><span class="yeaft-debug-section-title">System prompt</span></div>
                        <pre class="yeaft-debug-pre yeaft-debug-scroll-pre">{{ evt.systemPrompt }}</pre>
                      </div>
                      <div class="yeaft-debug-section" v-if="dreamLoopUserContent(evt)">
                        <div class="yeaft-debug-section-row"><span class="yeaft-debug-section-title">Request</span></div>
                        <pre class="yeaft-debug-pre yeaft-debug-scroll-pre">{{ dreamLoopUserContent(evt) }}</pre>
                      </div>
                      <div class="yeaft-debug-section" v-if="evt.response || evt.rawResponse">
                        <div class="yeaft-debug-section-row"><span class="yeaft-debug-section-title">Response</span></div>
                        <pre class="yeaft-debug-pre yeaft-debug-scroll-pre">{{ formatDebugValue(evt.response || evt.rawResponse) }}</pre>
                      </div>
                      <div class="yeaft-debug-section">
                        <div class="yeaft-debug-section-row"><span class="yeaft-debug-section-title">Raw event</span></div>
                        <pre class="yeaft-debug-pre yeaft-debug-scroll-pre">{{ formatDebugValue(evt) }}</pre>
                      </div>
                    </details>
                  </div>
                  <div v-else class="yeaft-debug-dream-event-empty">{{ $t('yeaft.dreamDebug.noRequestResponse') }}</div>
                </section>
              </div>
            </section>
          </article>
        </div>
        <div v-else class="yeaft-debug-empty">{{ allDreamItems.length ? $t('yeaft.dreamDebug.noSearchResults') : $t('yeaft.dreamDebug.empty') }}</div>
      </div>

      <div v-else-if="activeTab === 'requests' && turns.length > 0" class="yeaft-debug-turns">
        <div v-for="turn in turns" :key="turn.turnId" class="yeaft-debug-turn">
          <!-- Turn header -->
          <div class="yeaft-debug-turn-header" @click="toggleTurn(turn.turnId)">
            <svg class="yeaft-debug-turn-chevron" :class="{ expanded: expandedTurns[turn.turnId] }" viewBox="0 0 24 24" width="12" height="12">
              <path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
            </svg>
            <span class="yeaft-debug-turn-prompt">{{ truncate(turn.userPrompt, 80) || '(no prompt)' }}</span>
            <span class="yeaft-debug-turn-stats">
              <span v-if="turn.vpId" class="yeaft-debug-turn-vp">{{ turn.vpId }}</span>
              <span v-if="debugSessionId(turn)" class="yeaft-debug-turn-group">{{ debugSessionId(turn) }}</span>
              <span class="yeaft-debug-turn-loopcount">{{ turn.loopCount || (turn.loops && turn.loops.length) || 0 }}L</span>
              <span class="yeaft-debug-turn-time">{{ formatMs(turn.totalMs) }}</span>
              <span
                class="yeaft-debug-turn-tokens"
                :title="'message ' + turn.tokenBreakdown.messageTotal + ' · tool ' + turn.tokenBreakdown.toolTotal + ' (estimated split)'"
              >
                {{ formatTokens(turn.totalTokens) }} tok
                <span class="yeaft-debug-tokens-split">
                  (msg {{ formatTokens(turn.tokenBreakdown.messageTotal) }} · tool {{ formatTokens(turn.tokenBreakdown.toolTotal) }})
                </span>
              </span>
              <span v-if="turn.openedAt" class="yeaft-debug-turn-clock" :title="$t('yeaft.debugTurnStartedAt') || 'turn started at'">{{ formatClock(turn.openedAt) }}</span>
            </span>
            <button class="yeaft-debug-copy-btn" @click.stop="copyTurnAsMarkdown(turn)" title="Copy turn as markdown">copy</button>
          </div>

          <!-- Turn body -->
          <div class="yeaft-debug-turn-body" v-if="expandedTurns[turn.turnId]">
            <!-- Turn-level: System prompt (constant within a turn) -->
            <div class="yeaft-debug-section" v-if="turn.loops && turn.loops.length > 0 && turn.loops[0].systemPrompt">
              <div class="yeaft-debug-section-row">
                <span class="yeaft-debug-section-title">{{ $t('yeaft.systemPrompt') }}</span>
                <span class="yeaft-debug-section-meta">{{ turn.loops[0].systemPrompt.length }} chars</span>
                <button class="yeaft-debug-copy-btn" @click="copyText(turn.loops[0].systemPrompt, 'system prompt')">copy</button>
                <button class="yeaft-debug-show-btn" @click="toggleSection(turn.turnId, 'sys')">
                  {{ isSectionExpanded(turn.turnId, 'sys') ? 'hide' : 'show' }}
                </button>
              </div>
              <pre v-if="isSectionExpanded(turn.turnId, 'sys')" class="yeaft-debug-pre">{{ turn.loops[0].systemPrompt }}</pre>
            </div>

            <!-- Turn-level: Memory loaded -->
            <div class="yeaft-debug-section" v-if="turn.memoryLoaded && turn.memoryLoaded.length > 0">
              <div class="yeaft-debug-section-row">
                <span class="yeaft-debug-section-title">Memory loaded</span>
                <span class="yeaft-debug-section-meta">{{ turn.memoryLoaded.length }}</span>
                <button class="yeaft-debug-copy-btn" @click="copyText(turn.memoryLoaded, 'memory loaded')">copy</button>
                <button class="yeaft-debug-show-btn" @click="toggleSection(turn.turnId, 'mem')">
                  {{ isSectionExpanded(turn.turnId, 'mem') ? 'hide' : 'show' }}
                </button>
              </div>
              <ul v-if="isSectionExpanded(turn.turnId, 'mem')" class="yeaft-debug-mem-list">
                <li v-for="m in turn.memoryLoaded" :key="m.id">
                  <code>{{ m.id }}</code>
                  <span class="yeaft-debug-mem-meta">score={{ m.score == null ? '-' : m.score.toFixed(3) }} · kind={{ m.kind || '-' }}</span>
                </li>
              </ul>
            </div>

            <!-- Turn-level: Memory adjust (post-turn AMS edits, including evictions) -->
            <div class="yeaft-debug-section" v-if="turn.memoryAdjust">
              <div class="yeaft-debug-section-row">
                <span class="yeaft-debug-section-title">Memory adjust</span>
                <span class="yeaft-debug-section-meta">
                  +{{ turn.memoryAdjust.added }} -{{ turn.memoryAdjust.evicted }}
                  <span v-if="turn.memoryAdjust.skipped">skipped={{ turn.memoryAdjust.skipped }}</span>
                  · {{ turn.memoryAdjust.reason }}
                </span>
                <button class="yeaft-debug-copy-btn" @click="copyText(turn.memoryAdjust, 'memory adjust')">copy</button>
              </div>
            </div>

            <!-- Loops -->
            <div class="yeaft-debug-loop" v-for="loop in (turn.loops || [])" :key="loop.loopNumber">
              <div class="yeaft-debug-loop-header" @click="toggleLoop(turn.turnId, loop.loopNumber)">
                <svg class="yeaft-debug-turn-chevron" :class="{ expanded: isLoopExpanded(turn.turnId, loop.loopNumber) }" viewBox="0 0 24 24" width="10" height="10">
                  <path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
                </svg>
                <span class="yeaft-debug-loop-num">Loop {{ loop.loopNumber }}</span>
                <span class="yeaft-debug-loop-model">{{ loop.model }}</span>
                <span class="yeaft-debug-loop-stats">
                  <span
                    :title="'input total ' + loop.tokenBreakdown.inputTotal + ' = message ' + loop.tokenBreakdown.inputMessage + ' + tool ' + loop.tokenBreakdown.inputTool + ' (estimated split)'"
                  >↑{{ usageTotalInputTokens(loop.usage) }}<span class="yeaft-debug-tokens-split">(m{{ loop.tokenBreakdown.inputMessage }}/t{{ loop.tokenBreakdown.inputTool }})</span></span>
                  <span
                    :title="'output total ' + loop.tokenBreakdown.outputTotal + ' = message ' + loop.tokenBreakdown.outputMessage + ' + tool ' + loop.tokenBreakdown.outputTool + ' (estimated split)'"
                  >↓{{ loop.usage?.outputTokens || 0 }}<span class="yeaft-debug-tokens-split">(m{{ loop.tokenBreakdown.outputMessage }}/t{{ loop.tokenBreakdown.outputTool }})</span></span>
                  <span :title="formatUsageBreakdown(loop.usage)">⊕{{ usageTotalTokens(loop.usage) }}</span>
                  <span>{{ formatMs(loop.latencyMs) }}</span>
                  <span class="yeaft-debug-loop-meta">{{ loopMetaSummary(loop) }}</span>
                  <span
                    v-if="loopClockTime(turn, loop)"
                    class="yeaft-debug-loop-clock"
                    :title="loop.at ? ($t('yeaft.debugRequestAt') || 'request time') : ($t('yeaft.debugRequestAtDerived') || 'derived from turn start')"
                  >{{ loopClockTime(turn, loop) }}</span>
                </span>
                <button
                  v-if="assistantResponseForLoop(loop)"
                  class="yeaft-debug-show-btn small"
                  @click.stop="showAssistantResponse(turn.turnId, loop.loopNumber)"
                >{{ $t('yeaft.debugViewAssistantResponse') }}</button>
              </div>

              <div class="yeaft-debug-loop-body" v-if="isLoopExpanded(turn.turnId, loop.loopNumber)">
                <!-- Tools — model calls joined with completed results. -->
                <div class="yeaft-debug-section" v-if="toolsForLoop(turn, loop).length > 0">
                  <div class="yeaft-debug-section-title">Tools ({{ toolsForLoop(turn, loop).length }})</div>
                  <div class="yeaft-debug-tool-item" v-for="(t, ti) in toolsForLoop(turn, loop)" :key="toolDetailKey(turn.turnId, loop.loopNumber, t, ti)">
                    <div class="yeaft-debug-tool-row">
                      <span class="yeaft-debug-tool-num">#{{ ti + 1 }}</span>
                      <span class="yeaft-debug-tool-name">{{ t.name }}</span>
                      <span class="yeaft-debug-tool-status" :class="toolStatusClass(t)">{{ toolStatusLabel(t) }}</span>
                      <span class="yeaft-debug-tool-time">{{ t.isRunning ? '—' : formatMs(t.durationMs) }}</span>
                      <button class="yeaft-debug-copy-btn small" @click="copyToolInput(turn, t)">copy in</button>
                      <button class="yeaft-debug-copy-btn small" @click="copyToolOutput(turn, t)">copy out</button>
                      <button class="yeaft-debug-copy-btn small" @click="toggleToolDetail(turn.turnId, loop.loopNumber, t, ti)">
                        {{ isToolDetailExpanded(turn.turnId, loop.loopNumber, t, ti) ? $t('yeaft.debugHideDetails') : $t('yeaft.debugShowDetails') }}
                      </button>
                    </div>
                    <div class="yeaft-debug-tool-detail" v-if="isToolDetailExpanded(turn.turnId, loop.loopNumber, t, ti)">
                      <div class="yeaft-debug-tool-detail-col">
                        <div class="yeaft-debug-tool-detail-title">{{ $t('yeaft.debugToolInput') }}</div>
                        <pre>{{ toolInputText(t) }}</pre>
                      </div>
                      <div class="yeaft-debug-tool-detail-col">
                        <div class="yeaft-debug-tool-detail-title">{{ $t('yeaft.debugToolResult') }}</div>
                        <pre>{{ toolOutputText(t) }}</pre>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Reflections inside this loop -->
                <div class="yeaft-debug-section" v-for="(refl, ri) in reflectionsForLoop(turn, loop.loopNumber)" :key="'refl-' + ri">
                  <div class="yeaft-debug-section-row">
                    <span class="yeaft-debug-section-title">↻ Reflection ({{ refl.trigger }}, {{ refl.status }})</span>
                    <span class="yeaft-debug-section-meta" v-if="refl.durationMs">{{ formatMs(refl.durationMs) }}</span>
                    <button class="yeaft-debug-copy-btn" @click="copyText(refl.content || refl.error || '', 'reflection')">copy</button>
                  </div>
                  <pre v-if="refl.content" class="yeaft-debug-pre yeaft-debug-pre-soft">{{ refl.content }}</pre>
                  <div v-else-if="refl.error" class="yeaft-debug-error">{{ refl.error }}</div>
                </div>

                <!-- Assistant text -->
                <div class="yeaft-debug-section" v-if="assistantResponseForLoop(loop)">
                  <div class="yeaft-debug-section-row">
                    <span class="yeaft-debug-section-title">{{ $t('yeaft.debugAssistantResponse') }}</span>
                    <span class="yeaft-debug-section-meta">{{ assistantResponseForLoop(loop).length }} chars</span>
                    <button class="yeaft-debug-copy-btn" @click="copyText(assistantResponseForLoop(loop), 'assistant text')">copy</button>
                    <button class="yeaft-debug-show-btn" @click="toggleSection(turn.turnId, 'asst-' + loop.loopNumber)">
                      {{ isSectionExpanded(turn.turnId, 'asst-' + loop.loopNumber) ? 'hide' : 'show' }}
                    </button>
                  </div>
                  <pre v-if="isSectionExpanded(turn.turnId, 'asst-' + loop.loopNumber)" class="yeaft-debug-pre">{{ assistantResponseForLoop(loop) }}</pre>
                </div>

                <!-- Raw API request / response — copy-only, never inlined -->
                <div class="yeaft-debug-section yeaft-debug-raw-row" v-if="loop.rawRequest || loop.rawResponse">
                  <span class="yeaft-debug-section-title">Raw</span>
                  <button v-if="loop.rawRequest" class="yeaft-debug-copy-btn" @click="copyText(loop.rawRequest, 'raw request')">copy req</button>
                  <button v-if="loop.rawResponse" class="yeaft-debug-copy-btn" @click="copyText(loop.rawResponse, 'raw response')">copy res</button>
                  <span class="yeaft-debug-section-meta">
                    <span v-if="loop.rawRequest">{{ loop.rawRequest.method }} {{ loop.rawRequest.url }}</span>
                    <span v-if="loop.rawResponse">· status={{ loop.rawResponse.status }}</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

        <div class="yeaft-debug-empty" v-else>
          {{ $t('yeaft.noDebugData') }}
        </div>
      </template>
    </div>
  `,
};
