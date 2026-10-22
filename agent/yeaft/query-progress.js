/**
 * Query-local loop evidence. Activity is not completion: only changed observations
 * (including new negative reads) count as evidence. No transcript, arguments or
 * result bodies escape this object. Polling/waiting is neutral, not stagnation or progress.
 */
import { createHash } from 'node:crypto';
import { argsHashOf } from './tool-folding/exec-log.js';

const MAX_ENTRIES = 1024;
const MAX_TOOL_STATS = 128;
const WARNING_BATCHES = 4;
const RECOVERY_BATCHES = 8;
const REPORT_BATCHES = 12;
const FAILURE_LIMIT = 3;
const NEUTRAL_TOOLS = new Set([
  'AskUser', 'WaitAgent', 'ListAgents', 'WaitTask', 'ListTasks', 'ReadTaskLog',
  'PromptAgent', 'UpdateAgent', 'CloseAgent', 'PresentResponse',
]);

function boundedSet(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
}
function resultHash(output) {
  return createHash('sha256').update(typeof output === 'string' ? output : JSON.stringify(output) || '').digest('hex');
}

function failureKind(output, call, readOnly) {
  const text = typeof output === 'string' ? output : JSON.stringify(output) || '';
  const errorText = text.replace(/^Error:\s*/, '');
  let contract;
  // MCP and legacy tools throw JSON envelopes; Engine prefixes their messages
  // with "Error: ". Preserve that contract for classification without changing
  // the raw persisted/UI tool output.
  try { contract = typeof output === 'string' ? JSON.parse(errorText) : output; } catch { /* legacy text errors */ }
  // Confirmed nonzero exit is not rollback evidence. It is, however, a finished
  // command that can be revalidated after an edit or new input, unlike a timeout
  // or an operation whose lifecycle is still unknown.
  if (call.name === 'Bash' && contract?.code === 'bash_exit_nonzero'
      && contract.failureType === 'exit_nonzero' && contract.terminationConfirmed === true
      && contract.timedOut === false && Number.isInteger(contract.exitCode)) return 'terminated_command';
  if (contract?.errorEffect === 'unknown' || contract?.replaySafe === false) return 'uncertain';
  // Match the registry's explicit pre-execution validation contract, not words
  // in arbitrary messages or file paths such as /schema/validation/*.json.
  if (contract?.code === 'invalid_arguments' && contract.errorEffect === 'none') return 'validation';
  // A dispatched mutation without an explicit no-effect contract is unsafe to
  // replay regardless of whether its message happens to mention a timeout.
  if (!readOnly && contract?.errorEffect !== 'none') return 'uncertain';
  const message = typeof contract?.error === 'string' ? contract.error : errorText;
  if (['EPERM', 'EACCES'].includes(contract?.code)
      || /^(?:Failed to read file:\s*)?(?:EPERM\b|EACCES\b|permission denied\b|access denied\b|forbidden\b)/i.test(message)) return 'permission';
  // Known negative filesystem observations contain paths, not lifecycle data.
  // Names such as /timeout/schema/ are domain evidence, never timeout signals.
  if (readOnly && (/^(?:File not found:|ENOENT\b|Path is a directory:|Cannot read binary file:|File too large:)/i.test(message)
      || contract?.code === 'ENOENT')) return resultHash(output);
  if (/timed?\s*out|timeout|ECONNRESET|disconnect|socket hang up|connection closed/i.test(message)) return 'uncertain';
  return resultHash(output);
}

export class QueryProgress {
  #results = new Map();
  #mutations = new Map();
  #failures = new Map();
  #toolStats = new Map();
  #toolStatsTruncated = false;
  #batch = { evidence: false, repeated: false, failed: false };
  #revision = 0;
  #state = {
    modelRequests: 0, toolExecutions: 0, reusedCalls: 0, repeatedCalls: 0,
    failedCalls: 0, stage: 'running', reason: null, lastEvidenceAt: null, stagnantBatches: 0,
  };

  requestStarted() { this.#state.modelRequests += 1; }

  /** Reuse Engine's query-wide totals, including its provider-specific cache delta. */
  usageObserved(usage, totals) {
    const reported = key => (!Array.isArray(usage.reportedTokenFields) || usage.reportedTokenFields.includes(key))
      && Number.isSafeInteger(usage[key]) && usage[key] >= 0;
    const inputReported = reported('inputTokens') || (!usage.cacheTokensAreIncludedInInput
      && ['cacheReadTokens', 'cacheWriteTokens'].some(key => reported(key) && usage[key] > 0));
    for (const [key, known] of [['inputTokens', inputReported], ['outputTokens', reported('outputTokens')]]) {
      if (!known) continue;
      if (Number.isSafeInteger(totals[key]) && totals[key] >= 0) this.#state[key] = totals[key];
      else delete this.#state[key];
    }
  }

  /** Caller feedback/new owned task results may invalidate prior observations. */
  resetEvidence() {
    this.#results.clear();
    this.#mutations.clear();
    // New instructions/results do not prove a timed-out mutation was rolled back.
    for (const [key, failure] of this.#failures) {
      if (failure.readOnly || failure.kind !== 'uncertain') this.#failures.delete(key);
    }
    this.#state.stagnantBatches = 0;
    this.#state.stage = 'running';
    this.#state.reason = null;
    this.#batch = { evidence: false, repeated: false, failed: false };
  }

  /** Limit unchanged failures; never automatically replay an uncertain mutation. */
  blocked(call) {
    const failure = this.#failures.get(`${call.name}:${argsHashOf(call.input)}`);
    // A possibly committed mutation must be verified before even the first replay.
    if (!failure || (failure.count < FAILURE_LIMIT
        && !(['uncertain', 'terminated_command'].includes(failure.kind) && !failure.readOnly))) return null;
    return `Blocked unchanged failed call to ${call.name} after ${failure.count} equivalent failures. This call was NOT executed. Use the earlier error to correct the arguments or choose a different supported path. If an earlier operation timed out or disconnected, its side effects may already have happened: verify the target state before retrying. Otherwise report the concrete blocker. Previous failed call: ${failure.callId}.`;
  }

  observe({ call, output, isError = false, readOnly = false, executed = true, reused = false, skipped = false, policy = 'warn' }) {
    if (skipped) return;
    if (executed) this.#state.toolExecutions += 1;
    if (reused) this.#state.reusedCalls += 1;
    if (isError) this.#state.failedCalls += 1;
    // Keep this bounded independently of the evidence caches. Existing rows
    // remain cumulative even after the catalogue limit or an evidence reset.
    const name = call.name;
    const validName = typeof name === 'string' && /^[^\u0000-\u001f\u007f]{1,128}$/.test(name) && name.trim() === name;
    // Never rewrite names: truncation/normalization can collide with another tool.
    let stats = this.#toolStats.get(name);
    if (!stats && validName && this.#toolStats.size < MAX_TOOL_STATS) {
      stats = { name, executions: 0, failedCalls: 0, blockedCalls: 0 };
      this.#toolStats.set(name, stats);
    }
    if (!stats) this.#toolStatsTruncated = true;
    if (stats) {
      if (executed) stats.executions += 1;
      if (isError) {
        stats.failedCalls += 1;
        if (!executed) stats.blockedCalls += 1;
      }
    }
    const key = `${call.name}:${argsHashOf(call.input)}`;
    const hash = resultHash(output);
    if (isError) {
      const prior = this.#failures.get(key);
      const kind = failureKind(output, call, readOnly);
      if (executed && !readOnly) {
        // A partial mutation may have changed even a previously unreadable
        // resource. Permit verification, never a replay of the mutation itself.
        this.#results.clear();
        for (const [failedKey, failure] of this.#failures) {
          if (failure.readOnly) this.#failures.delete(failedKey);
        }
      }
      // A blocked result is synthetic; do not replace the original failure.
      if (executed) boundedSet(this.#failures, key, {
        kind, readOnly, count: prior?.kind === kind ? prior.count + 1 : 1, callId: call.id,
      });
      const repeated = !executed || prior?.kind === kind;
      // A first negative observation for a distinct read narrows the search.
      // Validation/permission failures are blockers, not domain evidence.
      if (readOnly && !repeated && !['validation', 'permission', 'uncertain'].includes(kind)) {
        this.#batch.evidence = true;
        this.#state.lastEvidenceAt = Date.now();
      } else {
        this.#batch.failed = true;
      }
      if (repeated) {
        this.#batch.repeated = true;
        this.#state.repeatedCalls += 1;
      }
      return;
    }
    this.#failures.delete(key);
    if (NEUTRAL_TOOLS.has(call.name) || policy === 'allow') return;
    if (!readOnly && executed && !reused) {
      // New mutations invalidate read observations, so edit/verify loops remain
      // useful. An identical mutation/acknowledgement is not itself evidence
      // of another change; never cache or replay it, merely count repetition.
      if (this.#mutations.get(key) === hash) {
        this.#batch.repeated = true;
        this.#state.repeatedCalls += 1;
      } else {
        boundedSet(this.#mutations, key, hash);
        this.#results.clear();
        // Reads and confirmed, finished commands may now succeed after an
        // edit. Unknown/timeout side effects still require explicit verification.
        for (const [failedKey, failure] of this.#failures) {
          if (failure.readOnly || failure.kind === 'terminated_command') this.#failures.delete(failedKey);
        }
        this.#batch.evidence = true;
        this.#state.lastEvidenceAt = Date.now();
      }
      return;
    }
    // Different ranges/pages are independent observations. A changed result for
    // the same call is fresh evidence even when it returns to an older value.
    const prior = this.#results.get(key);
    if (prior?.hash === hash || reused || !executed) {
      this.#state.repeatedCalls += 1;
      this.#batch.repeated = true;
      return readOnly && prior?.hash === hash ? prior.callId : null;
    } else {
      boundedSet(this.#results, key, { hash, callId: call.id });
      this.#batch.evidence = true;
      this.#state.lastEvidenceAt = Date.now();
    }
  }

  /** Called only AFTER every tool result is paired and persisted. */
  finishBatch() {
    const previousStage = this.#state.stage;
    if (this.#batch.evidence) {
      this.#state.stagnantBatches = 0;
      this.#state.stage = 'running';
      this.#state.reason = null;
    } else if (this.#batch.repeated || this.#batch.failed) {
      this.#state.stagnantBatches += 1;
      this.#state.reason = this.#batch.failed ? 'repeated_failure' : 'repeated_results';
      const count = this.#state.stagnantBatches;
      this.#state.stage = count >= REPORT_BATCHES ? 'stopped'
        : count >= RECOVERY_BATCHES ? 'recovering'
          : count >= WARNING_BATCHES ? 'warning' : 'running';
    }
    this.#batch = { evidence: false, repeated: false, failed: false };
    if (previousStage === this.#state.stage || this.#state.stage === 'running') return null;
    if (this.#state.stage === 'stopped') return 'report';
    return this.#state.stage;
  }

  snapshot(identity = {}) {
    return { type: 'query_progress', ...identity, revision: ++this.#revision, ...this.#state,
      toolStats: [...this.#toolStats.values()].map(stats => ({ ...stats })),
      ...(this.#toolStatsTruncated ? { toolStatsTruncated: true } : {}) };
  }
}

export function progressReminder(action, reason) {
  const failureHint = reason === 'repeated_failure'
    ? 'The same execution paths are failing. A timeout does not prove an operation did not happen; verify state before retrying any side effect.'
    : 'Recent tool batches repeat results already available; re-reading or restating a plan is not new evidence.';
  if (action === 'report') return `[system note] Investigation stopped after repeated non-progress batches despite recovery guidance. ${failureHint} Do not claim the user task is complete. Using only existing evidence, give a concise handoff: completed artifacts, unfinished requirements, concrete blocker, and a safe next step. No further tools are available for this one reporting response.`;
  return `[system note] Query progress ${action === 'recovering' ? 'recovery required' : 'warning'}: ${failureHint} Reuse prior results. Execute a concrete next step toward the requested deliverable, obtain genuinely missing evidence, or explain the blocker. Do not spawn another review of the same baseline or search for your own promises. Long-running useful work and legitimate waits remain allowed.`;
}
