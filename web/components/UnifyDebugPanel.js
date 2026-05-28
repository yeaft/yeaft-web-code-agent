/**
 * UnifyDebugPanel — feat-6af5f9f1 PR B.
 *
 * Replaces the previous inline debug block in UnifyPage.js. Renders the
 * Unify engine's per-Turn debug records as:
 *
 *   Turn header  (user prompt + vp + group + totals + [copy turn])
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
export default {
  name: 'UnifyDebugPanel',
  data() {
    return {
      // Per-turn expand state, keyed by turnId.
      expandedTurns: {},
      // Per-loop expand state, keyed by `${turnId}#${loopNumber}`.
      expandedLoops: {},
      // Per-section expand state, keyed by `${turnId}#${section}`.
      expandedSections: {},
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
    // feat-always-on-trajectory-store: watch unifyAgentId. The mount-time
    // hydration silently no-ops when the panel is opened before the
    // agent socket finishes connecting (loadUnifyDebugHistory bails on
    // !this.unifyAgentId). Without this watcher the panel stays empty
    // for that whole session because mounted() never runs again.
    //
    // Condition is `now && now !== prev` (not just `now && !prev`) so an
    // agent A → agent B switch also re-fetches; otherwise the panel would
    // keep showing agent A's trajectory after the user switches.
    'store.unifyAgentId'(now, prev) {
      if (now && now !== prev && this.store && typeof this.store.loadUnifyDebugHistory === 'function') {
        this.store.loadUnifyDebugHistory({ limit: 5, dreamLimit: 5 });
      }
    },
  },
  computed: {
    store() {
      return window.Pinia?.useChatStore?.() || null;
    },
    turns() {
      return (this.store && this.store.unifyDebugTurnsForActiveGroup) || [];
    },
    // feat-6af5f9f1 PR C: toolbar bindings.
    searchQuery: {
      get() { return this.store ? (this.store.unifyDebugSearch || '') : ''; },
      set(v) { this.store && this.store.setUnifyDebugSearch(v); },
    },
    groupFilter: {
      get() {
        if (!this.store) return '';
        const g = this.store.unifyDebugGroupFilter;
        // null (default — fall through to main pane filter) maps to ''
        // in the dropdown so the placeholder option is selected.
        return g === null || g === undefined ? '' : g;
      },
      set(v) {
        if (!this.store) return;
        if (!v) this.store.setUnifyDebugGroupFilter(null);
        else this.store.setUnifyDebugGroupFilter(v);
      },
    },
    availableGroups() {
      return (this.store && this.store.unifyDebugAvailableGroups) || [];
    },
    turnTotal() {
      return (this.store && this.store.unifyDebugTurnTotal) || 0;
    },
    showingMatchedHint() {
      // Only render the "M of N" hint when filters/search are active and
      // hiding something — otherwise it's just visual noise.
      return this.turnTotal > this.turns.length;
    },
    toolStats() {
      return this.store?.unifyToolStats || null;
    },
    toolStatsLoading() {
      return !!this.store?.unifyToolStatsLoading;
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
    // v0.1.755: latest dream pass for the active group (auto + manual share
    // this surface; user only cares about the most recent run).
    dreamLatest() {
      return (this.store && this.store.unifyDreamLatestForActiveGroup) || null;
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
    // PR feat-dream-debug-panel-full: full per-event timeline for the
    // active group. Empty array when no events have been recorded yet.
    // Sorted oldest-first (matches the store getter's merge order).
    dreamEvents() {
      const list = (this.store && this.store.unifyDreamEventsForActiveGroup) || [];
      return Array.isArray(list) ? list : [];
    },
    dreamEventCount() {
      return this.dreamEvents.length;
    },
  },
  mounted() {
    // fix-vp-multi-thread (bug 4): hydrate from the agent's persistent
    // SQLite trace as soon as the panel is mounted. Previously the panel
    // only ever showed turns observed live via `unify_output` events, so
    // anything before the panel was opened was invisible — even though
    // the trace had captured it. Pull the most recent 5 request loops and
    // 5 dream events so the panel is useful from frame 1 without flooding.
    if (this.store && typeof this.store.loadUnifyDebugHistory === 'function') {
      this.store.loadUnifyDebugHistory({ limit: 5, dreamLimit: 5 });
    }
  },
  methods: {
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
        if (evt.groupId) parts.push(`group ${evt.groupId}`);
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
        if (typeof evt.groups === 'number') parts.push(`${evt.groups} groups`);
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
        const skip = new Set(['type', 'phase', 'groupId', 'target', 'ts', 'at']);
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
      if (phase === 'load-diff') return 'runDream -> loadGroupDiff';
      if (phase === 'triage') return status ? `triageGroupSegments · ${status}` : 'triageGroupSegments';
      if (phase === 'merge') return 'mergeByTarget';
      if (phase === 'apply') return status ? `applyMergedTarget · ${status}` : 'applyMergedTarget';
      if (phase === 'done') return 'runDream completed';
      if (phase === 'result') return 'web-bridge -> unify_dream_result';
      return phase;
    },
    dreamEventLocation(evt) {
      if (!evt) return '-';
      if (evt.target) return evt.target;
      if (evt.scope) return evt.scope;
      if (evt.groupId) return `group/${evt.groupId}`;
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
      if (typeof evt.groupsProcessed === 'number') parts.push(`groups ${evt.groupsProcessed}`);
      if (typeof evt.groupsSkipped === 'number') parts.push(`skipped groups ${evt.groupsSkipped}`);
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
    truncate(text, max) {
      const s = String(text || '');
      if (s.length <= max) return s;
      return s.slice(0, max) + '…';
    },
    toolsForLoop(turn, loopNumber) {
      const all = (turn && turn.tools) || [];
      return all.filter(t => t && t.loopNumber === loopNumber);
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
    setActiveTab(tab) {
      this.activeTab = tab === 'toolStats' || tab === 'dream' ? tab : 'requests';
      if (this.activeTab === 'toolStats' && !this.toolStats && !this.toolStatsLoading) {
        this.refreshToolStats();
      }
    },
    refreshToolStats() {
      if (this.store && typeof this.store.fetchUnifyToolStats === 'function') {
        this.store.fetchUnifyToolStats();
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
      // Tool output lives on the NEXT loop's messages[] as a `tool` role
      // entry with toolCallId. Search loops in order.
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
      lines.push(`- Group: ${turn.groupId || '-'}`);
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
        lines.push(`- in/out/total: ${u.inputTokens || 0} / ${u.outputTokens || 0} / ${u.totalTokens || 0}`);
        lines.push(`- latency: ${this.formatMs(loop.latencyMs)}  ttfb: ${this.formatMs(loop.ttfbMs)}`);
        lines.push(`- stopReason: ${loop.stopReason || '-'}`);
        const tools = this.toolsForLoop(turn, loop.loopNumber);
        if (tools.length > 0) {
          lines.push('');
          lines.push(`### Tools (${tools.length})`);
          for (const t of tools) {
            lines.push(`- ${t.name}  ${t.isError ? 'ERROR' : 'ok'}  ${this.formatMs(t.durationMs)}`);
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
    <div class="unify-debug-panel">
      <div class="unify-debug-header">
        <span class="unify-debug-title">{{ $t('unify.debug') }}</span>
        <span v-if="copiedFlash" class="unify-debug-copied-flash">{{ copiedFlash }}</span>
      </div>

      <div class="unify-debug-tabs" role="tablist" :aria-label="$t('unify.debug')">
        <button
          type="button"
          class="unify-debug-tab"
          :class="{ active: activeTab === 'toolStats' }"
          role="tab"
          :aria-selected="activeTab === 'toolStats'"
          @click="setActiveTab('toolStats')"
        >
          {{ $t('unify.debugTabToolStats') }}
        </button>
        <button
          type="button"
          class="unify-debug-tab"
          :class="{ active: activeTab === 'dream' }"
          role="tab"
          :aria-selected="activeTab === 'dream'"
          @click="setActiveTab('dream')"
        >
          {{ $t('unify.debugTabDream') }}
          <span class="unify-debug-tab-count" v-if="dreamEventCount > 0">{{ dreamEventCount }}</span>
        </button>
        <button
          type="button"
          class="unify-debug-tab"
          :class="{ active: activeTab === 'requests' }"
          role="tab"
          :aria-selected="activeTab === 'requests'"
          @click="setActiveTab('requests')"
        >
          {{ $t('unify.debugTabRequestLog') }}
          <span class="unify-debug-tab-count" v-if="turns.length > 0">
            <template v-if="showingMatchedHint">{{ turns.length }} / {{ turnTotal }}</template>
            <template v-else>{{ turns.length }}</template>
          </span>
        </button>
      </div>

      <div v-if="activeTab === 'toolStats'" class="unify-debug-tool-stats" role="tabpanel">
        <div class="unify-debug-tool-stats-header">
          <div>
            <div class="unify-debug-tool-stats-title">{{ $t('unify.toolStats.title') }}</div>
            <div v-if="toolStatsFetchedAtLabel" class="unify-debug-tool-stats-meta">
              {{ $t('unify.toolStats.fetchedAt') }} {{ toolStatsFetchedAtLabel }}
            </div>
          </div>
          <button class="unify-debug-show-btn" @click="refreshToolStats" :disabled="toolStatsLoading">
            {{ $t('unify.toolStats.refresh') }}
          </button>
        </div>
        <div v-if="toolStats && toolStats.error" class="tool-stats-error">{{ toolStats.error }}</div>
        <div v-else-if="toolStatsLoading && !toolStats" class="tool-stats-loading">{{ $t('unify.toolStats.loading') }}</div>
        <div v-else-if="!toolStats" class="tool-stats-empty">{{ $t('unify.toolStats.notLoaded') }}</div>
        <template v-else>
          <div v-if="toolStats.notice" class="tool-stats-banner">{{ toolStats.notice }}</div>
          <div class="unify-debug-tool-stats-table-wrap">
            <table class="tool-stats-table">
              <thead>
                <tr>
                  <th>{{ $t('unify.toolStats.col.name') }}</th>
                  <th class="num">{{ $t('unify.toolStats.col.calls') }}</th>
                  <th class="num">{{ $t('unify.toolStats.col.errors') }}</th>
                  <th class="num">{{ $t('unify.toolStats.col.errRate') }}</th>
                  <th class="num">{{ $t('unify.toolStats.col.p50') }}</th>
                  <th class="num">{{ $t('unify.toolStats.col.p95') }}</th>
                  <th class="num">{{ $t('unify.toolStats.col.avg') }}</th>
                  <th>{{ $t('unify.toolStats.col.last') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="rankedToolRows.length === 0">
                  <td colspan="8" class="tool-stats-empty-row">{{ $t('unify.toolStats.empty') }}</td>
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
          <div class="unify-debug-unused-tools" v-if="unusedToolRows.length > 0">
            <div class="unify-debug-section-title">{{ $t('unify.toolStats.tabUnused') }}</div>
            <span v-for="name in unusedToolRows" :key="name" class="unify-debug-unused-tool">{{ name }}</span>
          </div>
        </template>
      </div>

      <div v-else-if="activeTab === 'dream'" class="unify-debug-dream-panel" role="tabpanel">
        <div class="unify-debug-toolbar">
          <select
            v-if="availableGroups.length > 1"
            class="unify-debug-group-select"
            v-model="groupFilter"
          >
            <option value="">{{ $t('unify.debugGroupFollowMain') }}</option>
            <option value="__all__">{{ $t('unify.debugGroupAll') }}</option>
            <option v-for="g in availableGroups" :key="g" :value="g">{{ g }}</option>
          </select>
        </div>

        <div class="unify-debug-dream-summary">
          <div class="unify-debug-dream-summary-title">{{ $t('unify.dreamDebug.title') }}</div>
          <div v-if="dreamLatest" class="unify-debug-dream-summary-grid">
            <span>{{ $t('unify.dreamDebug.trigger') }}</span>
            <strong>{{ dreamLatestKindLabel || '-' }}</strong>
            <span>{{ $t('unify.dreamDebug.status') }}</span>
            <strong :class="'status-' + dreamLatest.status">{{ dreamLatestLabel }}</strong>
            <span>{{ $t('unify.dreamDebug.started') }}</span>
            <strong>{{ formatTimestamp(dreamLatest.startedAt) || '-' }}</strong>
            <span>{{ $t('unify.dreamDebug.finished') }}</span>
            <strong>{{ formatTimestamp(dreamLatest.finishedAt) || '-' }}</strong>
          </div>
          <div v-else class="unify-debug-dream-event-empty">{{ $t('unify.dreamDebug.noLatest') }}</div>
        </div>

        <div class="unify-debug-dream-events" v-if="dreamEvents.length > 0">
          <div class="unify-debug-dream-event-header">
            <span>{{ $t('unify.dreamDebug.time') }}</span>
            <span>{{ $t('unify.dreamDebug.phase') }}</span>
            <span>{{ $t('unify.dreamDebug.trigger') }}</span>
            <span>{{ $t('unify.dreamDebug.call') }}</span>
            <span>{{ $t('unify.dreamDebug.location') }}</span>
            <span>{{ $t('unify.dreamDebug.result') }}</span>
          </div>
          <div
            v-for="(evt, idx) in dreamEvents"
            :key="evt.at + ':dream-tab:' + idx"
            class="unify-debug-dream-event detailed"
            :class="'status-' + dreamEventStatus(evt)"
          >
            <span class="unify-debug-dream-event-time">{{ formatTimestamp(evt.at) }}</span>
            <span class="unify-debug-dream-event-phase">{{ evt.phase || 'unknown' }}</span>
            <span class="unify-debug-dream-event-detail">{{ dreamEventTrigger(evt) }}</span>
            <span class="unify-debug-dream-event-detail">{{ dreamEventCall(evt) }}</span>
            <span class="unify-debug-dream-event-detail">{{ dreamEventLocation(evt) }}</span>
            <span class="unify-debug-dream-event-detail">{{ dreamEventResult(evt) }}</span>
          </div>
        </div>
        <div v-else class="unify-debug-dream-events">
          <div class="unify-debug-dream-event-empty">{{ $t('unify.dreamDebug.noEvents') }}</div>
        </div>
      </div>

      <template v-else>
        <!-- feat-6af5f9f1 PR C: search + independent group filter toolbar -->
        <div class="unify-debug-toolbar">
          <input
            type="search"
            class="unify-debug-search"
            v-model="searchQuery"
            :placeholder="$t('unify.debugSearchPlaceholder')"
          />
          <select
            v-if="availableGroups.length > 1"
            class="unify-debug-group-select"
            v-model="groupFilter"
          >
            <option value="">{{ $t('unify.debugGroupFollowMain') }}</option>
            <option value="__all__">{{ $t('unify.debugGroupAll') }}</option>
            <option v-for="g in availableGroups" :key="g" :value="g">{{ g }}</option>
          </select>
        </div>

        <!-- v0.1.755 + PR feat-dream-debug-panel-full: Dream pass status
             for the focused group. The header row shows the most recent
             pass (auto or manual); clicking it expands a timeline of every
             dream_progress event observed for this scope so users can see
             per-phase progress + the final result with errors. -->
        <div class="unify-debug-dream-row" v-if="dreamLatest || dreamEvents.length > 0" @click="toggleDream">
        <svg
          class="unify-debug-dream-chevron"
          :class="{ expanded: dreamExpanded }"
          viewBox="0 0 24 24" width="12" height="12"
        >
          <path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
        </svg>
        <span class="unify-debug-dream-label">Dream</span>
        <span v-if="dreamLatest" class="unify-debug-dream-kind" :class="'kind-' + dreamLatestKindLabel">{{ dreamLatestKindLabel }}</span>
        <span v-if="dreamLatest" class="unify-debug-dream-status" :class="'status-' + dreamLatest.status">{{ dreamLatestLabel }}</span>
        <span v-else class="unify-debug-dream-status">{{ dreamEvents.length }} events</span>
        <span class="unify-debug-dream-time" v-if="dreamLatest && dreamLatest.finishedAt">{{ formatTimestamp(dreamLatest.finishedAt) }}</span>
        <span class="unify-debug-dream-time" v-else-if="dreamLatest && dreamLatest.startedAt">{{ formatTimestamp(dreamLatest.startedAt) }}</span>
      </div>
      <div class="unify-debug-dream-events" v-if="dreamExpanded && dreamEvents.length > 0">
        <div
          v-for="(evt, idx) in dreamEvents"
          :key="evt.at + ':' + idx"
          class="unify-debug-dream-event"
          :class="'status-' + dreamEventStatus(evt)"
        >
          <span class="unify-debug-dream-event-time">{{ formatTimestamp(evt.at) }}</span>
          <span class="unify-debug-dream-event-phase">{{ evt.phase || 'unknown' }}</span>
          <span class="unify-debug-dream-event-detail">{{ dreamEventDetail(evt) }}</span>
        </div>
      </div>
      <div class="unify-debug-dream-events" v-else-if="dreamExpanded && dreamEvents.length === 0">
        <div class="unify-debug-dream-event-empty">No dream events yet for this group.</div>
      </div>

      <div class="unify-debug-turns" v-if="turns.length > 0">
        <div v-for="turn in turns" :key="turn.turnId" class="unify-debug-turn">
          <!-- Turn header -->
          <div class="unify-debug-turn-header" @click="toggleTurn(turn.turnId)">
            <svg class="unify-debug-turn-chevron" :class="{ expanded: expandedTurns[turn.turnId] }" viewBox="0 0 24 24" width="12" height="12">
              <path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
            </svg>
            <span class="unify-debug-turn-prompt">{{ truncate(turn.userPrompt, 80) || '(no prompt)' }}</span>
            <span class="unify-debug-turn-stats">
              <span v-if="turn.vpId" class="unify-debug-turn-vp">{{ turn.vpId }}</span>
              <span v-if="turn.groupId" class="unify-debug-turn-group">{{ turn.groupId }}</span>
              <span class="unify-debug-turn-loopcount">{{ turn.loopCount || (turn.loops && turn.loops.length) || 0 }}L</span>
              <span class="unify-debug-turn-time">{{ formatMs(turn.totalMs) }}</span>
              <span class="unify-debug-turn-tokens">{{ formatTokens(turn.totalTokens) }} tok</span>
            </span>
            <button class="unify-debug-copy-btn" @click.stop="copyTurnAsMarkdown(turn)" title="Copy turn as markdown">copy</button>
          </div>

          <!-- Turn body -->
          <div class="unify-debug-turn-body" v-if="expandedTurns[turn.turnId]">
            <!-- Turn-level: System prompt (constant within a turn) -->
            <div class="unify-debug-section" v-if="turn.loops && turn.loops.length > 0 && turn.loops[0].systemPrompt">
              <div class="unify-debug-section-row">
                <span class="unify-debug-section-title">{{ $t('unify.systemPrompt') }}</span>
                <span class="unify-debug-section-meta">{{ turn.loops[0].systemPrompt.length }} chars</span>
                <button class="unify-debug-copy-btn" @click="copyText(turn.loops[0].systemPrompt, 'system prompt')">copy</button>
                <button class="unify-debug-show-btn" @click="toggleSection(turn.turnId, 'sys')">
                  {{ isSectionExpanded(turn.turnId, 'sys') ? 'hide' : 'show' }}
                </button>
              </div>
              <pre v-if="isSectionExpanded(turn.turnId, 'sys')" class="unify-debug-pre">{{ turn.loops[0].systemPrompt }}</pre>
            </div>

            <!-- Turn-level: Memory loaded -->
            <div class="unify-debug-section" v-if="turn.memoryLoaded && turn.memoryLoaded.length > 0">
              <div class="unify-debug-section-row">
                <span class="unify-debug-section-title">Memory loaded</span>
                <span class="unify-debug-section-meta">{{ turn.memoryLoaded.length }}</span>
                <button class="unify-debug-copy-btn" @click="copyText(turn.memoryLoaded, 'memory loaded')">copy</button>
                <button class="unify-debug-show-btn" @click="toggleSection(turn.turnId, 'mem')">
                  {{ isSectionExpanded(turn.turnId, 'mem') ? 'hide' : 'show' }}
                </button>
              </div>
              <ul v-if="isSectionExpanded(turn.turnId, 'mem')" class="unify-debug-mem-list">
                <li v-for="m in turn.memoryLoaded" :key="m.id">
                  <code>{{ m.id }}</code>
                  <span class="unify-debug-mem-meta">score={{ m.score == null ? '-' : m.score.toFixed(3) }} · kind={{ m.kind || '-' }}</span>
                </li>
              </ul>
            </div>

            <!-- Turn-level: Memory adjust (post-turn AMS edits, including evictions) -->
            <div class="unify-debug-section" v-if="turn.memoryAdjust">
              <div class="unify-debug-section-row">
                <span class="unify-debug-section-title">Memory adjust</span>
                <span class="unify-debug-section-meta">
                  +{{ turn.memoryAdjust.added }} -{{ turn.memoryAdjust.evicted }}
                  <span v-if="turn.memoryAdjust.skipped">skipped={{ turn.memoryAdjust.skipped }}</span>
                  · {{ turn.memoryAdjust.reason }}
                </span>
                <button class="unify-debug-copy-btn" @click="copyText(turn.memoryAdjust, 'memory adjust')">copy</button>
              </div>
            </div>

            <!-- Loops -->
            <div class="unify-debug-loop" v-for="loop in (turn.loops || [])" :key="loop.loopNumber">
              <div class="unify-debug-loop-header" @click="toggleLoop(turn.turnId, loop.loopNumber)">
                <svg class="unify-debug-turn-chevron" :class="{ expanded: isLoopExpanded(turn.turnId, loop.loopNumber) }" viewBox="0 0 24 24" width="10" height="10">
                  <path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
                </svg>
                <span class="unify-debug-loop-num">Loop {{ loop.loopNumber }}</span>
                <span class="unify-debug-loop-model">{{ loop.model }}</span>
                <span class="unify-debug-loop-stats">
                  <span title="input tokens">↑{{ loop.usage?.inputTokens || 0 }}</span>
                  <span title="output tokens">↓{{ loop.usage?.outputTokens || 0 }}</span>
                  <span title="total tokens">⊕{{ loop.usage?.totalTokens || 0 }}</span>
                  <span>{{ formatMs(loop.latencyMs) }}</span>
                  <span class="unify-debug-loop-meta">{{ loopMetaSummary(loop) }}</span>
                </span>
                <button
                  v-if="assistantResponseForLoop(loop)"
                  class="unify-debug-show-btn small"
                  @click.stop="showAssistantResponse(turn.turnId, loop.loopNumber)"
                >{{ $t('unify.debugViewAssistantResponse') }}</button>
              </div>

              <div class="unify-debug-loop-body" v-if="isLoopExpanded(turn.turnId, loop.loopNumber)">
                <!-- Tools — list-only, copy-on-demand -->
                <div class="unify-debug-section" v-if="toolsForLoop(turn, loop.loopNumber).length > 0">
                  <div class="unify-debug-section-title">Tools ({{ toolsForLoop(turn, loop.loopNumber).length }})</div>
                  <div class="unify-debug-tool-row" v-for="(t, ti) in toolsForLoop(turn, loop.loopNumber)" :key="ti">
                    <span class="unify-debug-tool-num">#{{ ti + 1 }}</span>
                    <span class="unify-debug-tool-name">{{ t.name }}</span>
                    <span class="unify-debug-tool-status" :class="t.isError ? 'err' : 'ok'">{{ t.isError ? '✗' : '✓' }}</span>
                    <span class="unify-debug-tool-time">{{ formatMs(t.durationMs) }}</span>
                    <button class="unify-debug-copy-btn small" @click="copyToolInput(turn, t)">copy in</button>
                    <button class="unify-debug-copy-btn small" @click="copyToolOutput(turn, t)">copy out</button>
                  </div>
                </div>

                <!-- Reflections inside this loop -->
                <div class="unify-debug-section" v-for="(refl, ri) in reflectionsForLoop(turn, loop.loopNumber)" :key="'refl-' + ri">
                  <div class="unify-debug-section-row">
                    <span class="unify-debug-section-title">↻ Reflection ({{ refl.trigger }}, {{ refl.status }})</span>
                    <span class="unify-debug-section-meta" v-if="refl.durationMs">{{ formatMs(refl.durationMs) }}</span>
                    <button class="unify-debug-copy-btn" @click="copyText(refl.content || refl.error || '', 'reflection')">copy</button>
                  </div>
                  <pre v-if="refl.content" class="unify-debug-pre unify-debug-pre-soft">{{ refl.content }}</pre>
                  <div v-else-if="refl.error" class="unify-debug-error">{{ refl.error }}</div>
                </div>

                <!-- Assistant text -->
                <div class="unify-debug-section" v-if="assistantResponseForLoop(loop)">
                  <div class="unify-debug-section-row">
                    <span class="unify-debug-section-title">{{ $t('unify.debugAssistantResponse') }}</span>
                    <span class="unify-debug-section-meta">{{ assistantResponseForLoop(loop).length }} chars</span>
                    <button class="unify-debug-copy-btn" @click="copyText(assistantResponseForLoop(loop), 'assistant text')">copy</button>
                    <button class="unify-debug-show-btn" @click="toggleSection(turn.turnId, 'asst-' + loop.loopNumber)">
                      {{ isSectionExpanded(turn.turnId, 'asst-' + loop.loopNumber) ? 'hide' : 'show' }}
                    </button>
                  </div>
                  <pre v-if="isSectionExpanded(turn.turnId, 'asst-' + loop.loopNumber)" class="unify-debug-pre">{{ assistantResponseForLoop(loop) }}</pre>
                </div>

                <!-- Raw API request / response — copy-only, never inlined -->
                <div class="unify-debug-section unify-debug-raw-row" v-if="loop.rawRequest || loop.rawResponse">
                  <span class="unify-debug-section-title">Raw</span>
                  <button v-if="loop.rawRequest" class="unify-debug-copy-btn" @click="copyText(loop.rawRequest, 'raw request')">copy req</button>
                  <button v-if="loop.rawResponse" class="unify-debug-copy-btn" @click="copyText(loop.rawResponse, 'raw response')">copy res</button>
                  <span class="unify-debug-section-meta">
                    <span v-if="loop.rawRequest">{{ loop.rawRequest.method }} {{ loop.rawRequest.url }}</span>
                    <span v-if="loop.rawResponse">· status={{ loop.rawResponse.status }}</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

        <div class="unify-debug-empty" v-else>
          {{ $t('unify.noDebugData') }}
        </div>
      </template>
    </div>
  `,
};
