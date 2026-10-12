import { digest } from './contracts.js';

/** Episode-local observations, not a quota, action permission or semantic verdict.
 * Compare full captured outputs rather than request previews. No command/output
 * text is kept here; the owned durable trace remains the evidence authority. */
export class ExecutionProgress {
  constructor() { this.recent = []; }
  observe(callId, invocation, result) {
    const output = typeof result?.output === 'string' ? result.output : JSON.stringify(result ?? null);
    const item = { callId, capability: invocation.id, argsDigest: digest(invocation.args),
      outputDigest: digest(output), ok: result?.ok !== false,
      ...(result?.sourceRef ? { sourceRef: result.sourceRef } : {}) };
    this.recent.push(item);
    if (this.recent.length > 8) this.recent.shift();
  }
  context() {
    if (!this.recent.length) return null;
    const latest = this.recent.at(-1);
    const sameOutput = item => item.capability === latest.capability && item.ok === latest.ok && item.outputDigest === latest.outputDigest;
    const sameRequest = item => item.capability === latest.capability && item.argsDigest === latest.argsDigest;
    const repeatedOutputCount = this.recent.filter(sameOutput).length;
    const repeatedRequestCount = this.recent.filter(sameRequest).length;
    return { recent: this.recent.map(item => ({ ...item })), repeatedOutputCount, repeatedRequestCount,
      notice: 'Observed recent executions only, not proof of progress/stalling or permission. Same output can be legitimate. No call quota or automatic stopping.',
      ...(repeatedOutputCount > 1 || repeatedRequestCount > 1 ? { review: 'A recent request or output repeated. Compare the evidence already read and episodeWork before another read. Recover missing output with Execution.read; choose a justified authorized action, a distinct check, or an explicit blocker instead of another promise. Never force a write or replay side effects.' } : {}) };
  }
}
