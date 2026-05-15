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
  },
  computed: {
    store() {
      return window.Pinia?.useChatStore?.() || null;
    },
    turns() {
      return (this.store && this.store.unifyDebugTurnsForActiveGroup) || [];
    },
    detailMode() {
      return !!(this.store && this.store.unifyDebugDetailMode);
    },
    detailLabel() {
      // i18n: keep parity with the prior chip behaviour.
      const t = this.$t || ((k) => k);
      return this.detailMode
        ? (t('unify.debugDetail') || 'Detail')
        : (t('unify.debugConcise') || 'Lite');
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
      const parts = ['done'];
      if (typeof d.mergedCount === 'number') parts.push(`merged ${d.mergedCount}`);
      if (typeof d.durationMs === 'number') parts.push(this.formatMs(d.durationMs));
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
        if (!evt.success && evt.error) parts.push(evt.error);
        if (evt.skipped) parts.push(`skipped: ${evt.skippedReason || 'unknown'}`);
      }
      if (evt.error && !parts.includes(evt.error)) parts.unshift(`error: ${evt.error}`);
      return parts.join(' · ');
    },
    // PR feat-dream-debug-panel-full: status label used to colorize a
    // timeline row (matches the same class names as the Dream summary).
    dreamEventStatus(evt) {
      if (!evt) return 'running';
      if (evt.status === 'error' || evt.phase === 'error') return 'error';
      if (evt.status === 'done' || evt.status === 'success' || evt.phase === 'done') return 'success';
      if (evt.phase === 'result') return evt.success ? 'success' : 'error';
      return 'running';
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
    setDetailMode(on) {
      if (this.store && typeof this.store.setUnifyDebugDetailMode === 'function') {
        this.store.setUnifyDebugDetailMode(!!on);
      }
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
        if (loop.response) {
          lines.push('');
          lines.push('### Assistant text');
          lines.push('```');
          lines.push(loop.response);
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
        <span class="unify-debug-count" v-if="turns.length > 0">
          <template v-if="showingMatchedHint">{{ turns.length }} / {{ turnTotal }}</template>
          <template v-else>{{ turns.length }} {{ $t('unify.debugTurns') }}</template>
        </span>
        <button
          class="unify-debug-toggle-chip"
          :class="{ active: detailMode }"
          @click="setDetailMode(!detailMode)"
          :title="detailLabel"
        >{{ detailLabel }}</button>
        <span v-if="copiedFlash" class="unify-debug-copied-flash">{{ copiedFlash }}</span>
      </div>

      <!-- feat-6af5f9f1 PR C: search + independent group filter toolbar -->
      <div class="unify-debug-toolbar">
        <input
          type="search"
          class="unify-debug-search"
          v-model="searchQuery"
          :placeholder="$t('unify.debugSearchPlaceholder') || 'Search turns, tools, prompts…'"
        />
        <select
          v-if="availableGroups.length > 1"
          class="unify-debug-group-select"
          v-model="groupFilter"
        >
          <option value="">{{ $t('unify.debugGroupFollowMain') || 'Follow main pane' }}</option>
          <option value="__all__">{{ $t('unify.debugGroupAll') || 'All groups' }}</option>
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

            <!-- Turn-level: Memory loaded (detail mode only — feat-6af5f9f1 PR C) -->
            <div class="unify-debug-section" v-if="detailMode && turn.memoryLoaded && turn.memoryLoaded.length > 0">
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

            <!-- Turn-level: Memory adjust (post-turn AMS edits, including evictions; detail mode only) -->
            <div class="unify-debug-section" v-if="detailMode && turn.memoryAdjust">
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
                <div class="unify-debug-section" v-if="loop.response">
                  <div class="unify-debug-section-row">
                    <span class="unify-debug-section-title">Assistant text</span>
                    <span class="unify-debug-section-meta">{{ loop.response.length }} chars</span>
                    <button class="unify-debug-copy-btn" @click="copyText(loop.response, 'assistant text')">copy</button>
                    <button class="unify-debug-show-btn" @click="toggleSection(turn.turnId, 'asst-' + loop.loopNumber)">
                      {{ isSectionExpanded(turn.turnId, 'asst-' + loop.loopNumber) ? 'hide' : 'show' }}
                    </button>
                  </div>
                  <pre v-if="isSectionExpanded(turn.turnId, 'asst-' + loop.loopNumber)" class="unify-debug-pre">{{ loop.response }}</pre>
                </div>

                <!-- Raw API request / response — copy-only, never inlined -->
                <div class="unify-debug-section unify-debug-raw-row" v-if="detailMode && (loop.rawRequest || loop.rawResponse)">
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
    </div>
  `,
};
