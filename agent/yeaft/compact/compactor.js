/**
 * compactor.js — per-group post-turn history compactor.
 *
 * Owns the orchestration that previously lived inline in
 * `agent/yeaft/web-bridge.js` as `getCompactState` /
 * `scheduleCompactAfterTurn` / `runCompactNow`. Bridge keeps WS knowledge
 * and history ownership; this class owns:
 *   - per-group single-flight + anti-starvation `pending` chain,
 *   - the precheck via `shouldCompactHistory`,
 *   - the call into `compactHistory` (which itself calls the supplied
 *     `summarize` injectable — bound to `Engine.summarizeForCompact` by
 *     `session.js`),
 *   - the race-guard that bails when the live history reference / length
 *     diverges from the snapshot we captured before awaiting the LLM.
 *
 * History is passed in PER CALL via a `historyHandle = { get, set }` so
 * Compactor never has to know about `sessionContexts`, `historyHydrated`,
 * or any other bridge-internal field. The WS event sink is wired
 * separately via `setOnCompacted`.
 *
 * Engine instances are per-VP-per-group (`vpEngines` keyed by
 * `${sessionId}::${vpId}`), so this orchestration cannot live on `Engine`
 * itself: a per-group single-flight slot pinned to a per-VP Engine is a
 * category error. Compactor is constructed once per session, beside the
 * `dreamScheduler`.
 */

import { compactHistory, shouldCompactHistory } from '../history-compact.js';

/**
 * Output cap for the summarizer call. The full compacted history is
 * built around the LLM-produced summary, so the summary itself must be
 * bounded — too long defeats the point of compacting, too short loses
 * context. 1024 tokens is the value that lived inline in the old
 * `runCompactNow` helper in `web-bridge.js` and matches the budget
 * `compactHistory` plans around.
 */
const SUMMARIZER_MAX_TOKENS = 1024;

/**
 * @typedef {object} CompactorHistoryHandle
 * @property {() => Array<object>} get  — return the current live history array
 * @property {(next: Array<object>) => void} set  — replace the array reference
 */

/**
 * @typedef {object} CompactedResult
 * @property {string|null} reason
 * @property {number} beforeTurns
 * @property {number} afterTurns
 * @property {number} beforeTokens
 * @property {number} afterTokens
 * @property {number} archivedCount
 */

export class Compactor {
  /**
   * @param {object} opts
   * @param {(args: {system: string, prompt: string, maxTokens?: number}) => Promise<string>} opts.summarize
   *        Bound to `engine.summarizeForCompact` by `session.js`. Returns
   *        the trimmed summary text (or '' on failure — `compactHistory`
   *        treats that as a soft failure).
   * @param {() => number|undefined} [opts.getMaxContextTokens]
   *        Returns `config.maxContextTokens` for `shouldCompactHistory`.
   * @param {() => number|undefined} [opts.getTriggerRatio]
   *        Returns the fraction-of-context threshold (e.g. `0.7` for the
   *        user-stated "70% of model context"). Falls through to
   *        `shouldCompactHistory`'s `DEFAULT_TOKEN_FRACTION` when missing
   *        or out-of-range — that is, the compactor will still trigger,
   *        just at the library default instead of the configured ratio.
   *        Live-read so a config edit takes effect without reboot.
   * @param {() => string|undefined} [opts.getLanguage]
   *        Returns the live `config.language`. Threaded into
   *        `compactHistory` so the compactor's summary prompt + the
   *        "session continued" wrapper render in the user's preferred
   *        locale instead of always English.
   * @param {(sessionId: string, result: CompactedResult) => void} [opts.onCompacted]
   *        Optional sink. Bridge wires this to send the
   *        `yeaft_history_compacted` WS event. Default: no-op. Can be
   *        replaced post-construction via `setOnCompacted`.
   */
  constructor({ summarize, getMaxContextTokens, getTriggerRatio, getLanguage, onCompacted } = {}) {
    if (typeof summarize !== 'function') {
      throw new TypeError('Compactor: summarize is required');
    }
    this._summarize = summarize;
    this._getMaxContextTokens = typeof getMaxContextTokens === 'function'
      ? getMaxContextTokens
      : () => undefined;
    this._getTriggerRatio = typeof getTriggerRatio === 'function'
      ? getTriggerRatio
      : () => undefined;
    this._getLanguage = typeof getLanguage === 'function'
      ? getLanguage
      : () => undefined;
    this._onCompacted = typeof onCompacted === 'function' ? onCompacted : () => {};
    /** @type {Map<string, { inFlight: Promise<void>|null, pending: boolean }>} */
    this._states = new Map();
  }

  /**
   * Replace the post-success sink. Bridge calls this from
   * `installYeaftRuntimeBridge` once the bridge-local
   * `sendToServer` + `yeaftConversationId` are available — keeps WS
   * knowledge out of Compactor's constructor and avoids a circular
   * import between `session.js` and `web-bridge.js`.
   */
  setOnCompacted(fn) {
    this._onCompacted = typeof fn === 'function' ? fn : () => {};
  }

  /** Get-or-create the per-group state record. */
  _state(sessionId) {
    let s = this._states.get(sessionId);
    if (!s) {
      s = { inFlight: null, pending: false };
      this._states.set(sessionId, s);
    }
    return s;
  }

  /**
   * Entry-gate await. Bridge calls at the top of `handleYeaftGroupChat`
   * so a brand-new turn never reads a half-mutated history mid-compact.
   * Other groups' compacts never block this gate (per-group keying).
   *
   * @param {string} sessionId
   */
  async awaitInFlight(sessionId) {
    if (!sessionId) return;
    const s = this._states.get(sessionId);
    if (s && s.inFlight) {
      try { await s.inFlight; } catch { /* _runOnce already logs */ }
    }
  }

  /**
   * Post-turn fire-and-forget. Bridge calls after the per-VP fanout
   * completes for a turn. The `historyHandle` MUST be a per-call value:
   * its `get` / `set` close over the bridge's sessionId-scoped helpers
   * (`getOrCreateSessionHistory` / `setGroupHistory`), not over a frozen
   * snapshot, so a chained follow-up sees fresh state.
   *
   * Anti-starvation: while a compact is in flight, additional
   * `scheduleAfterTurn` calls collapse to a single `pending=true`. Once
   * the in-flight finishes, exactly one follow-up runs (no matter how
   * many turns piled up during the await).
   *
   * @param {string} sessionId
   * @param {CompactorHistoryHandle} historyHandle
   */
  scheduleAfterTurn(sessionId, historyHandle) {
    if (!sessionId || !historyHandle) return;
    const s = this._state(sessionId);
    if (s.inFlight) {
      // Anti-starvation: compact is already running. Mark a follow-up
      // so when it finishes, it re-evaluates and runs again if still
      // triggered.
      s.pending = true;
      return;
    }
    s.inFlight = this._runOnce(sessionId, historyHandle).finally(() => {
      s.inFlight = null;
      // If turns piled up while we were running and compaction is still
      // needed, chain a follow-up. Use a microtask so the .finally
      // chain settles cleanly before the next promise is created.
      if (s.pending) {
        s.pending = false;
        queueMicrotask(() => this.scheduleAfterTurn(sessionId, historyHandle));
      }
    });
  }

  /**
   * One compact pass. Captures snapshot reference + length, runs the
   * precheck, calls `compactHistory`, race-guards, applies via
   * `historyHandle.set`, then notifies `onCompacted`. All errors are
   * swallowed (logged) so `inFlight` always clears.
   *
   * @param {string} sessionId
   * @param {CompactorHistoryHandle} historyHandle
   */
  async _runOnce(sessionId, historyHandle) {
    try {
      // Capture reference AND length. If a different code path swaps the
      // array (`consolidate` event, session reset, manual clear) the
      // reference will differ. If a driver path push-mutates new
      // messages in place (e.g. `route_forward` triggering a new VP
      // turn during compact), the reference is the same but the length
      // grew. Both cases mean our snapshot is no longer canonical.
      const snapshot = historyHandle.get();
      if (!Array.isArray(snapshot) || snapshot.length === 0) return;
      const snapshotLen = snapshot.length;

      const maxContextTokens = this._getMaxContextTokens();
      const tokenFraction = this._getTriggerRatio();

      // Cheap O(n) precheck so we don't bother engaging the LLM at all
      // when the conversation is still small. `compactHistory` runs the
      // same check internally, but only after building the summarizer
      // input — this keeps small chats off the LLM altogether.
      //
      // tokenFraction is the user-configurable ratio knob (default 0.7
      // resolved upstream in session.js). When `undefined`, the helper
      // uses its built-in DEFAULT_TOKEN_FRACTION (currently 0.5) — that
      // is the back-compat path for callers that never wire a ratio.
      const triage = shouldCompactHistory(snapshot, { maxContextTokens, tokenFraction });
      if (!triage.trigger) return;

      const summarize = ({ system, prompt }) =>
        this._summarize({ system, prompt, maxTokens: SUMMARIZER_MAX_TOKENS });

      const result = await compactHistory(snapshot, {
        summarize,
        maxContextTokens,
        tokenFraction,
        language: this._getLanguage(),
      });
      if (!result || !result.compacted) {
        if (result && result.error) {
          console.warn(
            `[Yeaft] history compact: summarizer failed (${result.error}); ` +
            `keeping ${result.beforeTurns} turns / ~${result.beforeTokens} tokens`
          );
        }
        return;
      }

      // Race guard: if the group's history was reassigned during the
      // await (e.g. consolidate / reset), or push-mutated by a driver
      // path, do NOT overwrite the fresh state with our stale compacted
      // snapshot. These discards are EXPECTED during normal session
      // resets / route_forward bursts — log at debug, not info.
      const current = historyHandle.get();
      if (current !== snapshot) {
        console.debug('[Yeaft] history compact: history was reset during compact — discarding stale summary');
        return;
      }
      if (current.length !== snapshotLen) {
        console.debug('[Yeaft] history compact: history was appended-to during compact — discarding stale summary');
        return;
      }

      historyHandle.set(result.messages);
      console.log(
        `[Yeaft] history compacted (reason=${result.reason}): ` +
        `turns ${result.beforeTurns}→${result.afterTurns}, ` +
        `tokens ~${result.beforeTokens}→${result.afterTokens}, ` +
        `archived ${result.archivedCount} messages`
      );

      try {
        this._onCompacted(sessionId, {
          reason: result.reason,
          beforeTurns: result.beforeTurns,
          afterTurns: result.afterTurns,
          beforeTokens: result.beforeTokens,
          afterTokens: result.afterTokens,
          archivedCount: result.archivedCount,
        });
      } catch { /* sink failure must not abort the orchestrator */ }
    } catch (err) {
      console.warn(`[Yeaft] history compact: unexpected failure (sessionId=${sessionId})`, err?.message || err);
    }
  }

  /** Test-only: clear all per-group state. */
  __testReset() {
    this._states.clear();
  }
}
