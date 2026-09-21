/**
 * YeaftDebugPanel — feat-6af5f9f1 PR B.
 *
 * Replaces the previous inline debug block in YeaftPage.js. Renders the
 * Yeaft engine's per-Turn debug records as:
 *
 *   Turn header  (user prompt + vp + session + totals + [copy turn])
 *     Latest loop request body / system prompt [show] [copy] turn-level
 *     Memory loaded   [show] [copy]                     turn-level
 *     Memory adjust   [show] [copy]                     turn-level
 *     -- Loop 1   in/out/total tok · ms · tools×N · refl    [chevron]
 *         Tools (N)      one row per tool with [copy in] [copy out]
 *         Reflection T1  [copy]
 *         Assistant text [copy]
 *         [copy res]                raw response — copy-only
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
import { splitTokenBreakdown, apportionToBuckets, apportionRequestInput, formatClockTime, reconstructDebugRawRequest } from './yeaft-debug-helpers.js';

const INITIAL_REQUEST_HISTORY_LIMIT = 1;
const SEARCH_REQUEST_HISTORY_LIMIT = 5;

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
      activeTab: 'requests', // 'toolStats' | 'requests'
    };
  },
  watch: {
    // Turn-level debug: when the detail round-trip lands for the clicked
    // turn (or the panel switches to a new turn), auto-expand it so the
    // user immediately sees the trace instead of a collapsed header.
    turns(now, prev) {
      const turn = now && now[0];
      if (!turn || !turn.turnId) return;
      const prevId = prev && prev[0] && prev[0].turnId;
      if (prevId === turn.turnId && this.expandedTurns[turn.turnId]) return;
      this.expandedTurns = { ...this.expandedTurns, [turn.turnId]: true };
      this.ensureRequestDetailLoaded(turn.turnId);
    },
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
    sessionsStore() {
      return window.Pinia?.useSessionsStore?.() || null;
    },
    turns() {
      // Turn-level debug: the panel renders exactly the turn the user
      // clicked (the debug action on an AI turn), not a history browser. The
      // store keeps `yeaftDebugPanel.turnId`; the turn record arrives via
      // the precise `yeaft_fetch_debug_history` detail round-trip.
      const panel = (this.store && this.store.yeaftDebugPanel) || {};
      const turn = panel.turnId
        ? (this.store && this.store.yeaftDebugTurnsById && this.store.yeaftDebugTurnsById[panel.turnId])
        : null;
      if (!turn) return [];
      // Detail responses keep Turn summaries and Loop payloads in separate
      // bounded stores. Rejoin them for this exact Turn before rendering;
      // otherwise the header can report `1L` while the expanded body has no
      // system prompt or loop rows at all. Preserve embedded loops only as a
      // compatibility fallback for older live payloads.
      const storedLoops = this.debugLoopsForTurn(turn.turnId);
      const loops = storedLoops.length > 0
        ? storedLoops
        : (Array.isArray(turn.loops) ? turn.loops : []);
      const detail = { ...turn, loops };
      return [{ ...this.decorateTurnTokenBreakdowns(detail), latestRequest: this.latestRequestForTurn(detail) }];
    },
    currentTurnId() {
      return (this.store && this.store.yeaftDebugPanel && this.store.yeaftDebugPanel.turnId) || '';
    },
    currentTurnSessionId() {
      return (this.store && this.store.yeaftDebugPanel && this.store.yeaftDebugPanel.sessionId) || '';
    },
    panelStatus() {
      return (this.store && this.store.yeaftDebugPanel && this.store.yeaftDebugPanel.status) || 'idle';
    },
    panelLoading() {
      return this.panelStatus === 'loading';
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
    requestHistoryLoading() {
      return !!this.store?.yeaftDebugHistoryLoading;
    },
    requestHistoryError() {
      const error = this.store?.yeaftDebugHistoryError || '';
      return error === 'debug_history_timeout'
        ? this.$t('yeaft.debugHistoryUnavailable')
        : error;
    },
    requestHistoryProjectionNotice() {
      return this.store?.yeaftDebugHistoryProjection?.truncated === true
        ? this.$t('yeaft.debugHistoryTruncated')
        : '';
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
  },
  methods: {
    debugSessionId(turn) {
      return this.formatDebugSessionId((turn && (turn.sessionId || turn.groupId)) || '');
    },
    formatDebugSessionId(id) {
      const raw = String(id || '');
      return raw.startsWith('grp_') ? raw.slice(4) : raw;
    },
    toggleTurn(turnId) {
      const willExpand = !this.expandedTurns[turnId];
      this.expandedTurns = { ...this.expandedTurns, [turnId]: willExpand };
      if (willExpand) this.ensureRequestDetailLoaded(turnId);
    },
    debugLoopsForTurn(turnId) {
      const loops = Array.isArray(this.store?.yeaftDebugLoops) ? this.store.yeaftDebugLoops : [];
      return loops.filter(loop => loop && loop.turnId === turnId);
    },
    debugTurnNeedsDetailLoad(turn) {
      if (!turn || !turn.turnId) return false;
      if (!turn.detailsLoaded) return true;

      const loops = this.debugLoopsForTurn(turn.turnId);
      const expectedCount = Math.max(0, Number(turn.loopCount || 0));
      const seen = new Set();
      for (const loop of loops) {
        const n = Number(loop?.loopNumber || 0);
        if (Number.isFinite(n) && n > 0) seen.add(n);
      }
      const maxSeen = seen.size > 0 ? Math.max(...seen) : 0;

      // Live websocket events are best-effort for retry/fallback attempts.
      // A live Turn can therefore be marked detailsLoaded while still showing
      // Loop 1, 3, 4... with Loop 2 only present in the file-backed trace.
      // Expansion is the user's explicit request for detail, so backfill from
      // the agent whenever the loop sequence or turn summary proves a gap.
      if (maxSeen > seen.size) return true;
      if (expectedCount > loops.length) return true;
      for (let n = 1; n <= expectedCount; n++) {
        if (!seen.has(n)) return true;
      }
      return false;
    },
    ensureRequestDetailLoaded(turnId) {
      const turn = this.store?.yeaftDebugTurnsById?.[turnId];
      if (!turn || !this.store || typeof this.store.loadYeaftDebugHistory !== 'function') return;
      if (!this.debugTurnNeedsDetailLoad(turn)) return;
      this.store.loadYeaftDebugHistory({
        limit: INITIAL_REQUEST_HISTORY_LIMIT,
        detailTurnId: turnId,
        groupId: turn.sessionId || null,
      });
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
      const requestSplit = loop.requestInputBreakdown
        ? apportionRequestInput(realIn, loop.requestInputBreakdown)
        : null;
      const outSplit = apportionToBuckets(realOut, est.outputMessageTokens, est.outputToolTokens);
      return {
        inputMessage: inSplit.message,
        inputTool: inSplit.tool,
        inputSystemPrompt: requestSplit?.systemPrompt ?? null,
        inputHistoryMessages: requestSplit?.historyMessages ?? null,
        inputToolDefinitions: requestSplit?.tools ?? null,
        inputCurrentTurn: requestSplit?.currentTurn ?? null,
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
      if (loops.length === 0) {
        acc.inputTotal = Math.max(0, Number(turn.summaryInputTokens) || 0);
        acc.outputTotal = Math.max(0, Number(turn.summaryOutputTokens) || 0);
        acc.total = acc.inputTotal + acc.outputTotal;
      }
      const maxLoop = loops.reduce((best, loop) => {
        const total = Number(loop?.tokenBreakdown?.total) || 0;
        return total > (Number(best?.tokenBreakdown?.total) || 0) ? loop : best;
      }, null);
      const tokenBreakdown = {
        ...acc,
        messageTotal: acc.inputMessage + acc.outputMessage,
        toolTotal: acc.inputTool + acc.outputTool,
      };
      const totalTokens = Math.max(Number(turn.totalTokens) || 0, tokenBreakdown.total || 0);
      if (totalTokens > tokenBreakdown.total) {
        const missing = totalTokens - tokenBreakdown.total;
        tokenBreakdown.total = totalTokens;
        tokenBreakdown.inputTotal += missing;
        tokenBreakdown.inputMessage += missing;
        tokenBreakdown.messageTotal += missing;
      }
      return {
        ...turn,
        loops,
        tokenBreakdown,
        maxLoopTokenBreakdown: maxLoop?.tokenBreakdown || null,
        maxLoopTokenTotal: Number(maxLoop?.tokenBreakdown?.total) || 0,
        maxLoopNumber: maxLoop?.loopNumber || null,
      };
    },
    turnTotalTokens(turn) {
      return Math.max(Number(turn?.totalTokens) || 0, Number(turn?.tokenBreakdown?.total) || 0);
    },
    loopBreakdownMessageTokens(b) {
      return (Number(b?.inputMessage) || 0) + (Number(b?.outputMessage) || 0);
    },
    loopBreakdownToolTokens(b) {
      return (Number(b?.inputTool) || 0) + (Number(b?.outputTool) || 0);
    },
    loopMessageTokens(loop) {
      return this.loopBreakdownMessageTokens(loop?.tokenBreakdown || {});
    },
    loopToolTokens(loop) {
      return this.loopBreakdownToolTokens(loop?.tokenBreakdown || {});
    },
    tokenPct(part, total) {
      const p = Number(part) || 0;
      const t = Number(total) || 0;
      if (t <= 0 || p <= 0) return '0%';
      return `${Math.round((p / t) * 100)}%`;
    },
    hasRequestInputBreakdown(b) {
      return b?.inputSystemPrompt != null
        && b?.inputHistoryMessages != null
        && b?.inputToolDefinitions != null
        && b?.inputCurrentTurn != null;
    },
    requestInputBreakdownTitle(b) {
      const x = b || {};
      return this.$t('yeaft.debugInputTokenBreakdown', {
        total: Number(x.inputTotal) || 0,
        system: Number(x.inputSystemPrompt) || 0,
        history: Number(x.inputHistoryMessages) || 0,
        tools: Number(x.inputToolDefinitions) || 0,
        current: Number(x.inputCurrentTurn) || 0,
      });
    },
    tokenBreakdownTitle(b) {
      const x = b || {};
      const msg = (Number(x.inputMessage) || 0) + (Number(x.outputMessage) || 0);
      const tool = (Number(x.inputTool) || 0) + (Number(x.outputTool) || 0);
      const total = Math.max(Number(x.total) || 0, msg + tool);
      return `estimated token split: message ${msg} (${this.tokenPct(msg, total)}), tool ${tool} (${this.tokenPct(tool, total)}); input ${Number(x.inputTotal) || 0}, output ${Number(x.outputTotal) || 0}, total ${total}`;
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
    setActiveTab(tab) {
      this.activeTab = tab === 'toolStats' ? tab : 'requests';
      if (this.activeTab === 'toolStats' && !this.toolStats && !this.toolStatsLoading) {
        this.refreshToolStats();
      }
      // Turn-level debug: switching to the request tab does NOT boot a
      // history browser. The panel renders the turn the user clicked via
      // the turn debug action; with no selection it shows the empty-state hint.
    },
    loadRequestHistory() {
      if (!this.store || typeof this.store.loadYeaftDebugHistory !== 'function') return;
      const search = String(this.searchQuery || '').trim();
      this.store.loadYeaftDebugHistory({
        limit: search ? SEARCH_REQUEST_HISTORY_LIMIT : INITIAL_REQUEST_HISTORY_LIMIT,
        indexOnly: true,
        search,
      });
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
    latestRequestForTurn(turn) {
      // Live progress can outrun detail hydration. Select each available field
      // independently within this Turn and label its real source, rather than
      // hiding a loaded snapshot behind a newer metadata-only loop.
      const loops = (turn.loops || []).filter(Boolean)
        .slice().sort((a, b) => Number(b.loopNumber || 0) - Number(a.loopNumber || 0));
      if (!loops.length) return null;
      let body = null;
      let bodyLoopNumber = null;
      let systemPrompt = '';
      let systemPromptLoopNumber = null;
      for (const loop of loops) {
        if (body == null) {
          const candidate = this.rawRequestForLoop(loop)?.body;
          if (candidate != null) {
            body = candidate;
            bodyLoopNumber = loop.loopNumber;
          }
        }
        if (!systemPrompt && loop.systemPrompt) {
          systemPrompt = loop.systemPrompt;
          systemPromptLoopNumber = loop.loopNumber;
        }
        if (body != null && systemPrompt) break;
      }
      return {
        bodyLoopNumber,
        systemPromptLoopNumber,
        bodyText: body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body, null, 2)),
        systemPrompt,
      };
    },
    rawRequestForLoop(loop) {
      // Explicit null means this loop's capture is unavailable. Only older
      // records without this field may use their own structural delta/base.
      if (loop?.rawRequest !== undefined) return loop.rawRequest;
      return reconstructDebugRawRequest(loop?.rawRequestBase ?? loop?.requestBase?.rawRequest ?? null, loop?.requestDelta || null);
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
      const latestRequest = this.latestRequestForTurn(turn);
      if (latestRequest) {
        lines.push(`## ${this.$t('yeaft.debugLatestRequestBody')}${latestRequest.bodyLoopNumber != null ? ` (Loop ${latestRequest.bodyLoopNumber})` : ''}`);
        lines.push('');
        if (latestRequest.bodyText != null) {
          lines.push('```json', latestRequest.bodyText, '```');
        } else {
          lines.push(this.$t('yeaft.debugRequestBodyUnavailable'));
        }
        lines.push('', `## ${this.$t('yeaft.debugLatestSystemPrompt')}${latestRequest.systemPromptLoopNumber != null ? ` (Loop ${latestRequest.systemPromptLoopNumber})` : ''}`, '');
        if (latestRequest.systemPrompt) {
          lines.push('```text', latestRequest.systemPrompt, '```');
        } else {
          lines.push(this.$t('yeaft.debugSystemPromptUnavailable'));
        }
        lines.push('');
      }
      if (turn.memoryLoaded && turn.memoryLoaded.length > 0) {
        lines.push(`## Memory loaded (${turn.memoryLoaded.length})`);
        for (const m of turn.memoryLoaded) {
          lines.push(`- ${m.id || '?'}  layer=${m.layer || '-'}  score=${m.score == null ? '-' : m.score.toFixed(3)}  kind=${m.kind || '-'}  scope=${m.label || m.scope || '-'}`);
          if (m.body) {
            lines.push('');
            lines.push('```text');
            lines.push(m.body);
            lines.push('```');
          }
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
          <span class="yeaft-debug-tab-count" v-else-if="requestHistoryLoading">...</span>
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

      <div v-else-if="activeTab === 'requests' && turns.length > 0" class="yeaft-debug-turns">
        <div class="yeaft-debug-turn-context">
          <span class="yeaft-debug-turn-context-label">{{ $t('yeaft.debugTurnContext') }}</span>
          <code class="yeaft-debug-turn-context-id" :title="currentTurnId">{{ currentTurnId }}</code>
          <code v-if="currentTurnSessionId" class="yeaft-debug-turn-context-session" :title="currentTurnSessionId">{{ currentTurnSessionId }}</code>
        </div>
        <div v-if="requestHistoryError" class="yeaft-debug-error">{{ requestHistoryError }}</div>
        <div v-if="requestHistoryProjectionNotice" class="yeaft-debug-notice">{{ requestHistoryProjectionNotice }}</div>
        <div v-for="turn in turns" :key="turn.turnId" class="yeaft-debug-turn">
          <!-- Turn header -->
          <div class="yeaft-debug-turn-header" :class="{ expanded: expandedTurns[turn.turnId] }" @click="toggleTurn(turn.turnId)">
            <svg class="yeaft-debug-turn-chevron" :class="{ expanded: expandedTurns[turn.turnId] }" viewBox="0 0 24 24" width="12" height="12">
              <path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
            </svg>
            <span class="yeaft-debug-turn-content">
              <span class="yeaft-debug-turn-primary">
                <span class="yeaft-debug-turn-prompt" :title="turn.userPrompt">{{ truncate(turn.userPrompt, 96) || '(no prompt)' }}</span>
                <span class="yeaft-debug-turn-source">
                  <span v-if="turn.vpId" class="yeaft-debug-turn-vp">{{ turn.vpId }}</span>
                  <span v-if="debugSessionId(turn)" class="yeaft-debug-turn-group">{{ debugSessionId(turn) }}</span>
                </span>
                <span class="yeaft-debug-turn-time">{{ formatMs(turn.totalMs) }}</span>
                <span v-if="turn.openedAt" class="yeaft-debug-turn-clock" :title="$t('yeaft.debugTurnStartedAt') || 'turn started at'">{{ formatClock(turn.openedAt) }}</span>
              </span>
              <span class="yeaft-debug-turn-secondary">
                <span class="yeaft-debug-turn-loopcount">{{ turn.loopCount || (turn.loops && turn.loops.length) || 0 }}L</span>
                <span
                  class="yeaft-debug-turn-tokens"
                  :title="tokenBreakdownTitle(turn.tokenBreakdown)"
                >{{ formatTokens(turnTotalTokens(turn)) }} tok</span>
                <span class="yeaft-debug-turn-token-part">in {{ formatTokens(turn.tokenBreakdown.inputTotal) }}</span>
                <span class="yeaft-debug-turn-token-part">out {{ formatTokens(turn.tokenBreakdown.outputTotal) }}</span>
                <span v-if="turn.maxLoopTokenBreakdown" class="yeaft-debug-turn-token-part" :title="tokenBreakdownTitle(turn.maxLoopTokenBreakdown)">max L{{ turn.maxLoopNumber }} msg {{ formatTokens(loopBreakdownMessageTokens(turn.maxLoopTokenBreakdown)) }} · {{ tokenPct(loopBreakdownMessageTokens(turn.maxLoopTokenBreakdown), turn.maxLoopTokenTotal) }}</span>
                <span v-if="turn.maxLoopTokenBreakdown" class="yeaft-debug-turn-token-part" :title="tokenBreakdownTitle(turn.maxLoopTokenBreakdown)">max L{{ turn.maxLoopNumber }} tool {{ formatTokens(loopBreakdownToolTokens(turn.maxLoopTokenBreakdown)) }} · {{ tokenPct(loopBreakdownToolTokens(turn.maxLoopTokenBreakdown), turn.maxLoopTokenTotal) }}</span>
              </span>
            </span>
            <button class="yeaft-debug-copy-btn small yeaft-debug-turn-copy" @click.stop="copyTurnAsMarkdown(turn)" title="Copy turn as markdown">copy</button>
          </div>

          <!-- Turn body -->
          <div class="yeaft-debug-turn-body" v-if="expandedTurns[turn.turnId]">
            <div v-if="!turn.detailsLoaded && (!turn.loops || turn.loops.length === 0)" class="yeaft-debug-empty">
              {{ $t('yeaft.debugHistoryLoading') }}
            </div>
            <!-- One request snapshot per Turn, always from the latest Loop. -->
            <template v-if="turn.latestRequest">
              <div class="yeaft-debug-section yeaft-debug-latest-request">
                <div class="yeaft-debug-section-row">
                  <span class="yeaft-debug-section-title">{{ $t('yeaft.debugLatestRequestBody') }}</span>
                  <span v-if="turn.latestRequest.bodyLoopNumber != null" class="yeaft-debug-section-meta">Loop {{ turn.latestRequest.bodyLoopNumber }}</span>
                  <button type="button" class="yeaft-debug-copy-btn" :disabled="turn.latestRequest.bodyText == null" @click="copyText(turn.latestRequest.bodyText, $t('yeaft.debugLatestRequestBody'))">{{ $t('common.copy') }}</button>
                  <button type="button" class="yeaft-debug-show-btn" :disabled="turn.latestRequest.bodyText == null" :aria-expanded="isSectionExpanded(turn.turnId, 'latest-request')" @click="toggleSection(turn.turnId, 'latest-request')">
                    {{ $t(isSectionExpanded(turn.turnId, 'latest-request') ? 'yeaft.debugHideDetails' : 'yeaft.debugShowDetails') }}
                  </button>
                </div>
                <div v-if="turn.latestRequest.bodyText == null" class="yeaft-debug-notice">{{ $t('yeaft.debugRequestBodyUnavailable') }}</div>
                <pre v-else-if="isSectionExpanded(turn.turnId, 'latest-request')" class="yeaft-debug-pre yeaft-debug-scroll-pre">{{ turn.latestRequest.bodyText }}</pre>
              </div>
              <div class="yeaft-debug-section yeaft-debug-latest-system-prompt">
                <div class="yeaft-debug-section-row">
                  <span class="yeaft-debug-section-title">{{ $t('yeaft.debugLatestSystemPrompt') }}</span>
                  <span v-if="turn.latestRequest.systemPromptLoopNumber != null" class="yeaft-debug-section-meta">Loop {{ turn.latestRequest.systemPromptLoopNumber }}</span>
                  <button type="button" class="yeaft-debug-copy-btn" :disabled="!turn.latestRequest.systemPrompt" @click="copyText(turn.latestRequest.systemPrompt, $t('yeaft.debugLatestSystemPrompt'))">{{ $t('common.copy') }}</button>
                  <button type="button" class="yeaft-debug-show-btn" :disabled="!turn.latestRequest.systemPrompt" :aria-expanded="isSectionExpanded(turn.turnId, 'latest-system')" @click="toggleSection(turn.turnId, 'latest-system')">
                    {{ $t(isSectionExpanded(turn.turnId, 'latest-system') ? 'yeaft.debugHideDetails' : 'yeaft.debugShowDetails') }}
                  </button>
                </div>
                <div v-if="!turn.latestRequest.systemPrompt" class="yeaft-debug-notice">{{ $t('yeaft.debugSystemPromptUnavailable') }}</div>
                <pre v-else-if="isSectionExpanded(turn.turnId, 'latest-system')" class="yeaft-debug-pre yeaft-debug-scroll-pre">{{ turn.latestRequest.systemPrompt }}</pre>
              </div>
            </template>

            <!-- Turn-level: Memory loaded -->
            <div class="yeaft-debug-section" v-if="turn.memoryLoaded && turn.memoryLoaded.length > 0">
              <div class="yeaft-debug-section-row">
                <span class="yeaft-debug-section-title">Memory loaded</span>
                <span class="yeaft-debug-section-meta">{{ turn.memoryLoaded.length }} loaded<span v-if="turn.memoryLoadedMeta && turn.memoryLoadedMeta.recallCandidates != null"> / {{ turn.memoryLoadedMeta.recallCandidates }} candidates</span></span>
                <button class="yeaft-debug-copy-btn" @click="copyText(turn.memoryLoaded, 'memory loaded')">copy</button>
                <button class="yeaft-debug-show-btn" @click="toggleSection(turn.turnId, 'mem')">
                  {{ isSectionExpanded(turn.turnId, 'mem') ? 'hide' : 'show' }}
                </button>
              </div>
              <ul v-if="isSectionExpanded(turn.turnId, 'mem')" class="yeaft-debug-mem-list">
                <li v-for="m in turn.memoryLoaded" :key="m.id">
                  <div class="yeaft-debug-mem-head">
                    <code>{{ m.id }}</code>
                    <span class="yeaft-debug-mem-meta">layer={{ m.layer || '-' }} · score={{ m.score == null ? '-' : m.score.toFixed(3) }} · kind={{ m.kind || '-' }} · scope={{ m.label || m.scope || '-' }}</span>
                  </div>
                  <pre v-if="m.body" class="yeaft-debug-mem-body">{{ m.body }}</pre>
                  <span v-if="m.tags && m.tags.length" class="yeaft-debug-mem-tags">{{ m.tags.join(', ') }}</span>
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
            <div class="yeaft-debug-loop" v-for="loop in (turn.loops || [])" :key="loop.loopInstanceId || (turn.turnId + '#' + loop.loopNumber)">
              <div class="yeaft-debug-loop-header" :class="{ expanded: isLoopExpanded(turn.turnId, loop.loopNumber) }" @click="toggleLoop(turn.turnId, loop.loopNumber)">
                <svg class="yeaft-debug-turn-chevron" :class="{ expanded: isLoopExpanded(turn.turnId, loop.loopNumber) }" viewBox="0 0 24 24" width="10" height="10">
                  <path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
                </svg>
                <span class="yeaft-debug-loop-content">
                  <span class="yeaft-debug-loop-primary">
                    <span class="yeaft-debug-loop-main">
                      <span class="yeaft-debug-loop-num">Loop {{ loop.loopNumber }}</span>
                      <span class="yeaft-debug-loop-model" :title="loop.model">{{ loop.model }}</span>
                    </span>
                    <span class="yeaft-debug-loop-latency">{{ formatMs(loop.latencyMs) }}</span>
                    <span
                      v-if="loopClockTime(turn, loop)"
                      class="yeaft-debug-loop-clock"
                      :title="loop.at ? ($t('yeaft.debugRequestAt') || 'request time') : ($t('yeaft.debugRequestAtDerived') || 'derived from turn start')"
                    >{{ loopClockTime(turn, loop) }}</span>
                    <button
                      v-if="assistantResponseForLoop(loop)"
                      class="yeaft-debug-show-btn small yeaft-debug-loop-action"
                      @click.stop="showAssistantResponse(turn.turnId, loop.loopNumber)"
                    >{{ $t('yeaft.debugViewAssistantResponse') }}</button>
                  </span>
                  <span class="yeaft-debug-loop-secondary">
                    <span class="yeaft-debug-loop-total" :title="formatUsageBreakdown(loop.usage)">{{ formatTokens(usageTotalTokens(loop.usage)) }} tok</span>
                    <span
                      class="yeaft-debug-loop-token"
                      :title="hasRequestInputBreakdown(loop.tokenBreakdown) ? requestInputBreakdownTitle(loop.tokenBreakdown) : ('input total ' + loop.tokenBreakdown.inputTotal + ' = message ' + loop.tokenBreakdown.inputMessage + ' + tool ' + loop.tokenBreakdown.inputTool + ' (estimated split)')"
                    >in {{ formatTokens(usageTotalInputTokens(loop.usage)) }}</span>
                    <template v-if="hasRequestInputBreakdown(loop.tokenBreakdown)">
                      <span class="yeaft-debug-loop-token" :title="requestInputBreakdownTitle(loop.tokenBreakdown)">{{ $t('yeaft.debugInputSystemShort') }} {{ formatTokens(loop.tokenBreakdown.inputSystemPrompt) }}</span>
                      <span class="yeaft-debug-loop-token" :title="requestInputBreakdownTitle(loop.tokenBreakdown)">{{ $t('yeaft.debugInputHistoryShort') }} {{ formatTokens(loop.tokenBreakdown.inputHistoryMessages) }}</span>
                      <span class="yeaft-debug-loop-token" :title="requestInputBreakdownTitle(loop.tokenBreakdown)">{{ $t('yeaft.debugInputToolsShort') }} {{ formatTokens(loop.tokenBreakdown.inputToolDefinitions) }}</span>
                      <span class="yeaft-debug-loop-token" :title="requestInputBreakdownTitle(loop.tokenBreakdown)">{{ $t('yeaft.debugInputCurrentShort') }} {{ formatTokens(loop.tokenBreakdown.inputCurrentTurn) }}</span>
                    </template>
                    <span
                      class="yeaft-debug-loop-token"
                      :title="'output total ' + loop.tokenBreakdown.outputTotal + ' = message ' + loop.tokenBreakdown.outputMessage + ' + tool ' + loop.tokenBreakdown.outputTool + ' (estimated split)'"
                    >out {{ formatTokens(loop.usage?.outputTokens || 0) }}</span>
                    <span class="yeaft-debug-loop-meta">{{ loopMetaSummary(loop) }}</span>
                  </span>
                </span>
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

                <!-- Raw API response stays with its Loop. -->
                <div class="yeaft-debug-section yeaft-debug-raw-row" v-if="loop.rawResponse">
                  <span class="yeaft-debug-section-title">Raw</span>
                  <button class="yeaft-debug-copy-btn" @click="copyText(loop.rawResponse, 'raw response')">copy res</button>
                  <span class="yeaft-debug-section-meta">status={{ loop.rawResponse.status }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="yeaft-debug-empty" :class="{ 'yeaft-debug-empty-requests': activeTab === 'requests' }" v-else>
        <template v-if="activeTab === 'requests'">
          <div v-if="requestHistoryError" class="yeaft-debug-error">{{ requestHistoryError }}</div>
          <span v-if="panelLoading">{{ $t('yeaft.debugHistoryLoading') }}</span>
          <span v-else>{{ $t('yeaft.debugPanelEmpty') }}</span>
        </template>
        <span v-else>{{ requestHistoryLoading ? $t('yeaft.debugHistoryLoading') : $t('yeaft.noDebugData') }}</span>
      </div>
    </div>
  `,
};
