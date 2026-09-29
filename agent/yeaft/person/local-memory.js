import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const fault = code => Object.assign(new Error(code), { code });
function integer(value, fallback, min, max) {
  return Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

/**
 * Owner-scoped, disposable search projection; repository is always authoritative.
 * No I/O, model import or inference until a nonempty recall. The repository must
 * expose searchChanges/resolveMemories plus the ORIGINAL literal recall function
 * (capture it before decorating repository.recall; alternatively pass literalRecall).
 *
 * Defaults: exact scan newest 10k chunks, embed at most 256 missing chunks/recall,
 * return a stable bounded top-200 snapshot (5 minute/32 snapshot cache). FTS covers
 * all journal-indexed text. Coverage/catch-up limits are explicit in retrieval.
 * embeddingModule is a trusted worker-module injection seam for tests, NOT wire input.
 */
export class LocalPersonMemory {
  constructor({ repository, yeaftDir, namespace, literalRecall, embedding = {}, embeddingModule,
    maxQueue = 8, timeoutMs = 120000, shutdownTimeoutMs = 5000,
    journalBatchSize = 100, maxJournalPages = 50, maxVectorChunks = 10000,
    maxEmbedChunksPerRecall = 256, candidateLimit = 200, snapshotTtlMs = 300000, maxSnapshots = 32 } = {}) {
    if (!repository || !yeaftDir || typeof namespace !== 'string' || !namespace.trim()) throw new TypeError('repository, yeaftDir and namespace are required');
    if (repository.namespace && repository.namespace !== namespace) throw new TypeError('repository namespace mismatch');
    this.repository = repository;
    this.literalRecall = literalRecall ?? repository.recall.bind(repository);
    this.options = {
      yeaftDir: path.resolve(yeaftDir), namespace, embedding: { enabled: true, allowDownload: true, ...embedding, threads: integer(embedding.threads, 2, 1, 4) }, embeddingModule,
      maxVectorChunks: integer(maxVectorChunks, 10000, 1, 50000),
      maxEmbedChunksPerRecall: integer(maxEmbedChunksPerRecall, 256, 1, 2048),
      candidateLimit: integer(candidateLimit, 200, 1, 1000),
    };
    this.maxQueue = integer(maxQueue, 8, 1, 32);
    this.timeoutMs = integer(timeoutMs, 120000, 20, 600000);
    this.shutdownTimeoutMs = integer(shutdownTimeoutMs, 5000, 20, 10000);
    this.journalBatchSize = integer(journalBatchSize, 100, 1, 500);
    this.maxJournalPages = integer(maxJournalPages, 50, 1, 1000);
    this.snapshotTtlMs = integer(snapshotTtlMs, 300000, 1, 3600000);
    this.maxSnapshots = integer(maxSnapshots, 32, 1, 128);
    this.snapshots = new Map();
    this.queue = [];
    this.active = null;
    this.worker = null;
    this.rpc = null;
    this.nextId = 0;
    this.closed = false;
  }

  status() {
    return { enabled: this.options.embedding.enabled !== false, workerStarted: Boolean(this.worker), queued: this.queue.length, closed: this.closed };
  }

  async recall(ownerId, { kind = 'messages', query = '', cursor = null, limit = 5 } = {}) {
    if (typeof ownerId !== 'string' || !ownerId.trim()) throw new TypeError('ownerId is required');
    if (!['messages', 'concepts'].includes(kind) || typeof query !== 'string' || query.length > 4000) throw fault('INVALID_RECALL');
    if (this.closed) throw fault('MEMORY_CLOSED');
    limit = integer(limit, 5, 1, 50);
    if (!query.trim()) return this.literalRecall(ownerId, { kind, query, cursor, limit });
    const request = { ownerId, kind, query, cursor, limit };
    return this._schedule(token => this._recall(request, token), error => {
      if (['INVALID_CURSOR', 'MEMORY_CLOSED', 'RECALL_BUSY'].includes(error.code)) throw error;
      // A failed continuation must never silently restart ranking or expose a foreign cursor.
      if (cursor) throw fault('RECALL_RETRY');
      return this._literal(request, error.code || 'INDEX_FAILURE');
    });
  }

  _alive(token) {
    if (this.closed) throw fault('MEMORY_CLOSED');
    if (token.cancelled) throw fault('RECALL_TIMEOUT');
  }
  _schedule(fn, onError) {
    if (this.queue.length + Number(Boolean(this.active)) >= this.maxQueue) return Promise.reject(fault('RECALL_BUSY'));
    return new Promise((resolve, reject) => {
      const token = { cancelled: false };
      const job = { fn, onError, token, resolve, reject };
      job.abort = new Promise((_, fail) => { job.fail = fail; });
      // Queued time counts too. Attach a handler before the job becomes active.
      job.abort.catch(() => {});
      job.timer = setTimeout(() => {
        token.cancelled = true;
        const error = fault('RECALL_TIMEOUT');
        job.fail(error);
        if (this.active !== job) {
          this.queue = this.queue.filter(item => item !== job);
          reject(error);
        }
      }, this.timeoutMs);
      this.queue.push(job);
      void this._pump();
    });
  }
  async _pump() {
    if (this.active || this.closed) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    try { job.resolve(await Promise.race([job.fn(job.token), job.abort])); }
    catch (error) {
      clearTimeout(job.timer);
      if (job.token.cancelled) await this._stopWorker(false);
      // Fallback occupies the same admission slot; index failure cannot turn a
      // bounded recall queue into unbounded concurrent authoritative reads.
      try { job.resolve(await job.onError(error)); }
      catch (fallbackError) { job.reject(fallbackError); }
    }
    finally {
      clearTimeout(job.timer);
      if (job.token.cancelled) await this._stopWorker(false);
      this.active = null;
      void this._pump();
    }
  }

  _getWorker() {
    if (this.worker) return this.worker;
    // onnxruntime-node cannot reliably reload its native addon in a replacement
    // worker_thread. A managed process also makes blocked native inference killable.
    const worker = fork(new URL('./local-memory-host.js', import.meta.url), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', execArgv: [],
    });
    this.worker = worker;
    worker.send({ init: this.options });
    worker.unref();
    worker.channel?.unref();
    worker.on('message', message => {
      if (this.worker !== worker || this.rpc?.id !== message.id) return;
      const rpc = this.rpc;
      this.rpc = null;
      worker.unref();
      worker.channel?.unref();
      if (message.error) rpc.reject(fault(message.error.code));
      else rpc.resolve(message.value);
    });
    const failed = () => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.rpc?.reject(fault('INDEX_WORKER_FAILED'));
      this.rpc = null;
      worker.unref();
      worker.kill('SIGKILL');
    };
    worker.on('error', failed);
    worker.on('exit', failed);
    return worker;
  }
  _call(token, op, owner, args = {}) {
    this._alive(token);
    const worker = this._getWorker();
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.rpc = { id, resolve, reject };
      worker.ref();
      worker.channel?.ref();
      worker.send({ id, op, owner, ...args }, error => { if (error) reject(fault('INDEX_WORKER_FAILED')); });
    });
  }
  async _catchUp(owner, token) {
    let after = await this._call(token, 'checkpoint', owner);
    for (let page = 0; page < this.maxJournalPages; page++) {
      this._alive(token);
      const changes = await this.repository.searchChanges(owner, { after, limit: this.journalBatchSize });
      this._alive(token);
      if (!changes || !Array.isArray(changes.items) || changes.items.length > this.journalBatchSize || !Number.isSafeInteger(changes.lastSeq)) throw fault('INVALID_JOURNAL');
      if (changes.items.length || changes.lastSeq !== after) await this._call(token, 'apply', owner, changes);
      if (!changes.hasMore) return { checkpoint: changes.lastSeq, caughtUp: true };
      if (changes.lastSeq <= after) throw fault('INVALID_JOURNAL');
      after = changes.lastSeq;
    }
    return { checkpoint: after, caughtUp: false };
  }
  _prune() {
    for (const [id, snapshot] of this.snapshots) if (snapshot.expires <= Date.now()) this.snapshots.delete(id);
    while (this.snapshots.size >= this.maxSnapshots) this.snapshots.delete(this.snapshots.keys().next().value);
  }
  _save(snapshot, position) {
    this._prune();
    const id = randomBytes(16).toString('hex');
    this.snapshots.set(id, { ...snapshot, expires: Date.now() + this.snapshotTtlMs });
    return `lm:${id}:${position}`;
  }
  _cursor(request) {
    if (typeof request.cursor !== 'string' || request.cursor.length > 128) throw fault('INVALID_CURSOR');
    const match = /^lm:([a-f0-9]{32}):(\d{1,6})$/.exec(request.cursor);
    const snapshot = match && this.snapshots.get(match[1]);
    if (!snapshot || snapshot.expires <= Date.now() || snapshot.ownerId !== request.ownerId || snapshot.kind !== request.kind || snapshot.query !== request.query) throw fault('INVALID_CURSOR');
    const position = Number(match[2]);
    if (!Number.isSafeInteger(position) || position > (snapshot.refs?.length ?? 0)) throw fault('INVALID_CURSOR');
    return { snapshot, position, id: match[1] };
  }
  async _recall(request, token) {
    let snapshot, position = 0, id;
    if (request.cursor) {
      ({ snapshot, position, id } = this._cursor(request));
      if (snapshot.literal) return this._literal({ ...request, cursor: snapshot.rawCursor }, snapshot.reason, token);
    } else {
      const journal = await this._catchUp(request.ownerId, token);
      const result = await this._call(token, 'search', request.ownerId, { kind: request.kind, query: request.query });
      this._alive(token);
      if (result.resetWorker) await this._stopWorker(false);
      this._alive(token);
      snapshot = { ...request, refs: result.refs, retrieval: { ...result.retrieval, journal } };
      if (!journal.caughtUp) {
        snapshot.retrieval.degraded = true;
        snapshot.retrieval.reasons.push('journal_catchup_limited');
      }
    }
    const items = [];
    // Resolve every page against current authority. Stale/deleted revisions are omitted,
    // never replaced with text from a newer, unranked revision.
    while (position < snapshot.refs.length && items.length < request.limit) {
      const refs = snapshot.refs.slice(position, position + request.limit - items.length);
      const records = await this.repository.resolveMemories(request.ownerId, request.kind, refs);
      this._alive(token);
      const current = new Map(records.map(record => [record.id, record]));
      for (const ref of refs) {
        const record = current.get(ref.id);
        if (record?.revision === ref.revision) items.push(record);
      }
      position += refs.length;
    }
    const nextCursor = position < snapshot.refs.length ? (id ? `lm:${id}:${position}` : this._save(snapshot, position)) : null;
    return { items, nextCursor, retrieval: { ...snapshot.retrieval, snapshot: true, expiresInMs: this.snapshotTtlMs } };
  }
  async _literal(request, reason, token) {
    if (this.closed) throw fault('MEMORY_CLOSED');
    let timer;
    try {
      const result = await Promise.race([
        this.literalRecall(request.ownerId, { kind: request.kind, query: request.query, cursor: request.cursor, limit: request.limit }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(fault('RECALL_TIMEOUT')), Math.min(this.timeoutMs, 10000)); }),
      ]);
      if (token) this._alive(token);
      if (this.closed) throw fault('MEMORY_CLOSED');
      const nextCursor = result.nextCursor ? this._save({ ...request, literal: true, rawCursor: result.nextCursor, reason }, 0) : null;
      return { ...result, nextCursor, retrieval: { mode: 'literal', semantic: false, degraded: true, reasons: [reason], bounded: true, snapshot: false } };
    } finally { clearTimeout(timer); }
  }
  async _stopWorker(graceful = true) {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    this.rpc?.reject(fault('INDEX_WORKER_STOPPED'));
    this.rpc = null;
    worker.ref();
    let timer;
    try {
      await new Promise(resolve => {
        worker.once('exit', resolve);
        timer = setTimeout(() => { worker.kill('SIGKILL'); resolve(); }, this.shutdownTimeoutMs);
        if (graceful && worker.connected) worker.send({ id: -1, op: 'close' }, () => {});
        else worker.kill('SIGKILL');
      });
    } finally { clearTimeout(timer); worker.unref(); worker.channel?.unref(); }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.snapshots.clear();
    for (const job of [...this.queue, ...(this.active ? [this.active] : [])]) {
      clearTimeout(job.timer);
      job.token.cancelled = true;
      job.fail(fault('MEMORY_CLOSED'));
      job.reject(fault('MEMORY_CLOSED'));
    }
    this.queue = [];
    await this._stopWorker();
  }
}
