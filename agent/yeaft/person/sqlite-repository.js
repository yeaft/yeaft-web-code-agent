import { Worker } from 'node:worker_threads';
import { join, resolve } from 'node:path';
import { digest, fail, identifier, PersonError, text } from './contracts.js';

const storageError = code => {
  const error = new PersonError(code);
  // Keep transport errors independent of backend topology, SQL and local paths.
  if (error.code === 'STORAGE_UNAVAILABLE') error.message = 'Digital person storage is unavailable.';
  return error;
};

/** One worker/connection per repository, shared WAL authority across processes.
 * ownerId must come from the authenticated transport, never a request payload.
 * A worker crash/timeout fails this instance closed: pending outcomes may have
 * committed, so callers reconcile with a NEW instance and the same idempotency key.
 * No automatic retry, takeover, model dispatch or local-memory fallback occurs.
 */
export class SqlitePersonRepository {
  constructor({ yeaftDir, namespace = 'default', leaseMs = 15000, busyTimeoutMs = 1000, requestTimeoutMs = 30000, maxPending = 256 } = {}) {
    text(yeaftDir, 4096); identifier(namespace);
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 60000 || !Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 5000 ||
        !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < busyTimeoutMs + 100 || requestTimeoutMs > 120000 ||
        !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 4096) fail('INVALID_REQUEST');
    this.namespace = namespace; this.leaseMs = leaseMs;
    this.dbPath = join(resolve(yeaftDir), 'person', 'person.db');
    this.options = { dbPath: this.dbPath, namespace, leaseMs, busyTimeoutMs };
    this.requestTimeoutMs = requestTimeoutMs; this.maxPending = maxPending;
    this.pending = new Map(); this.requests = new Set(); this.nextId = 0; this.closed = false; this.failed = false;
  }
  scope(ownerId) {
    text(ownerId, 256);
    return { ownerId, namespace: this.namespace, personId: `person-${digest([this.namespace, ownerId]).slice(0, 32)}` };
  }
  async init() {
    if (this.closed) fail('CLOSED');
    if (this.failed) throw storageError('STORAGE_UNAVAILABLE');
    if (!this.initializing) this.initializing = new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => this.breakWorker(), this.requestTimeoutMs); timer.unref();
      this.rejectReady = error => { clearTimeout(timer); rejectReady(error); };
      try {
        this.worker = new Worker(new URL('./sqlite-worker.js', import.meta.url), { workerData: this.options });
        this.worker.on('message', message => {
          if (message.ready) { clearTimeout(timer); this.rejectReady = null; this.worker.unref(); resolveReady(); return; }
          if (message.startupError) { this.breakWorker(); return; }
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (!this.pending.size) this.worker.unref();
          if (message.error) pending.reject(storageError(message.error)); else pending.resolve(message.result);
        });
        this.worker.on('error', () => this.breakWorker());
        this.worker.on('exit', () => {
          if (!this.closingWorker || this.pending.size) this.breakWorker();
        });
      } catch { this.breakWorker(); }
    });
    return this.initializing;
  }
  breakWorker() {
    if (this.failed) return;
    this.failed = true;
    const error = storageError('STORAGE_UNAVAILABLE');
    this.rejectReady?.(error); this.rejectReady = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.terminating = this.worker?.terminate().catch(() => {});
  }
  send(method, args) {
    if (this.failed) return Promise.reject(storageError('STORAGE_UNAVAILABLE'));
    return new Promise((resolveResult, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => this.breakWorker(), this.requestTimeoutMs); timer.unref();
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.worker.ref();
      try { this.worker.postMessage({ id, method, args }); }
      catch { this.breakWorker(); }
    });
  }
  async request(method, args) {
    if (this.closed) fail('CLOSED');
    if (this.requests.size >= this.maxPending) fail('BUSY');
    const promise = (async () => { await this.init(); return this.send(method, args); })();
    this.requests.add(promise);
    try { return await promise; } finally { this.requests.delete(promise); }
  }
  async open(ownerId, name) { return this.request('open', [ownerId, name]); }
  async getPerson(ownerId) { return this.request('getPerson', [ownerId]); }
  async recover(ownerId) { return this.request('recover', [ownerId]); }
  async admit(ownerId, input) { return this.request('admit', [ownerId, input]); }
  async heartbeat(episode) { return this.request('heartbeat', [episode]); }
  async append(episode, kind, data) { return this.request('append', [episode, kind, data]); }
  async startCall(episode, data) { return this.request('startCall', [episode, data]); }
  async finalizeCall(episode, data) { return this.request('finalizeCall', [episode, data]); }
  async context(episode) { return this.request('context', [episode]); }
  async recall(ownerId, options) { return this.request('recall', [ownerId, options]); }
  async commit(episode, proposal, selection, callId, reportedSources = new Map()) { return this.request('commit', [episode, proposal, selection, callId, reportedSources]); }
  async finish(episode, status, code) { return this.request('finish', [episode, status, code]); }
  async cancel(ownerId, episodeId) { return this.request('cancel', [ownerId, episodeId]); }
  async settings(ownerId, settings) { return this.request('settings', [ownerId, settings]); }
  async list(ownerId, collection, options, filter) { return this.request('list', [ownerId, collection, options, filter]); }
  async snapshot(ownerId) { return this.request('snapshot', [ownerId]); }
  /** Ascending durable journal, scoped before paging. Empty pages retain after. */
  async searchChanges(ownerId, options) { return this.request('searchChanges', [ownerId, options]); }
  /** kind is 'messages'|'concepts'; returns a deduplicated array of current public records. */
  async resolveMemories(ownerId, kind, refs) { return this.request('resolveMemories', [ownerId, kind, refs]); }
  async close() {
    if (!this.closing) {
      this.closed = true;
      this.closing = (async () => {
        await Promise.allSettled([...this.requests]);
        await this.initializing?.catch(() => {});
        if (this.worker && !this.failed) {
          this.closingWorker = true;
          await this.send('close', []).catch(() => {});
          // terminate also joins the worker if it already completed its normal exit.
          await this.worker.terminate().catch(() => {});
        }
        await this.terminating;
      })();
    }
    return this.closing;
  }
}
