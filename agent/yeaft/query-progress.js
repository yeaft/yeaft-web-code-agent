/**
 * Query-local loop evidence. Activity is not completion: only changed successful
 * results count as observed evidence. No transcript, arguments or result bodies
 * escape this object. Polling/waiting is neutral, not stagnation or progress.
 */
import { createHash } from 'node:crypto';
import { argsHashOf } from './tool-folding/exec-log.js';

const MAX_ENTRIES = 1024;
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

function failureKind(output) {
  const text = typeof output === 'string' ? output : JSON.stringify(output) || '';
  let contract;
  try { contract = typeof output === 'string' ? JSON.parse(output) : output; } catch { /* legacy text errors */ }
  if (contract?.errorEffect === 'unknown' || contract?.replaySafe === false) return 'uncertain';
  if (/invalid[_ ]arguments|validation|schema|unexpected parameter|required propert/i.test(text)) return 'validation';
  if (/EPERM|EACCES|permission denied|access denied|forbidden/i.test(text)) return 'permission';
  if (/timed?\s*out|timeout|ECONNRESET|disconnect|socket hang up|connection closed/i.test(text)) return 'uncertain';
  return resultHash(output);
}

export class QueryProgress {
  #results = new Map();
  #mutations = new Map();
  #failures = new Map();
  #batch = { evidence: false, repeated: false, failed: false };
  #revision = 0;
  #state = {
    modelRequests: 0, toolExecutions: 0, reusedCalls: 0, repeatedCalls: 0,
    failedCalls: 0, stage: 'running', reason: null, lastEvidenceAt: null, stagnantBatches: 0,
  };

  requestStarted() { this.#state.modelRequests += 1; }

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

  /** Never replay an identical failed operation; its side effects may be unknown. */
  blocked(call) {
    const failure = this.#failures.get(`${call.name}:${argsHashOf(call.input)}`);
    // A possibly committed mutation must be verified before even the first replay.
    if (!failure || (failure.count < FAILURE_LIMIT && !(failure.kind === 'uncertain' && !failure.readOnly))) return null;
    return `Blocked unchanged failed call to ${call.name} after ${failure.count} equivalent failures. This call was NOT executed. Use the earlier error to correct the arguments or choose a different supported path. If an earlier operation timed out or disconnected, its side effects may already have happened: verify the target state before retrying. Otherwise report the concrete blocker. Previous failed call: ${failure.callId}.`;
  }

  observe({ call, output, isError = false, readOnly = false, executed = true, reused = false, skipped = false, policy = 'warn' }) {
    if (skipped) return;
    if (executed) this.#state.toolExecutions += 1;
    if (reused) this.#state.reusedCalls += 1;
    if (isError) this.#state.failedCalls += 1;
    const key = `${call.name}:${argsHashOf(call.input)}`;
    const hash = resultHash(output);
    if (isError) {
      const prior = this.#failures.get(key);
      const kind = failureKind(output);
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
      this.#batch.failed = true;
      if (!executed || prior?.kind === kind) {
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
        // Reads that failed before a mutation may now succeed; retain all
        // mutation failures, especially operations with uncertain side effects.
        for (const [failedKey, failure] of this.#failures) {
          if (failure.readOnly) this.#failures.delete(failedKey);
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
    return { type: 'query_progress', ...identity, revision: ++this.#revision, ...this.#state };
  }
}

export function progressReminder(action, reason) {
  const failureHint = reason === 'repeated_failure'
    ? 'The same execution paths are failing. A timeout does not prove an operation did not happen; verify state before retrying any side effect.'
    : 'Recent tool batches repeat results already available; re-reading or restating a plan is not new evidence.';
  if (action === 'report') return `[system note] Investigation stopped after repeated non-progress batches despite recovery guidance. ${failureHint} Do not claim the user task is complete. Using only existing evidence, give a concise handoff: completed artifacts, unfinished requirements, concrete blocker, and a safe next step. No further tools are available for this one reporting response.`;
  return `[system note] Query progress ${action === 'recovering' ? 'recovery required' : 'warning'}: ${failureHint} Reuse prior results. Execute a concrete next step toward the requested deliverable, obtain genuinely missing evidence, or explain the blocker. Do not spawn another review of the same baseline or search for your own promises. Long-running useful work and legitimate waits remain allowed.`;
}
