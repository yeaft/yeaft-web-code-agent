import { Worker } from 'node:worker_threads';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeAtomic } from '../storage/atomic.js';
import { extractRecallTerms, scoreRecallTurn, normalizeRecallLimit } from './recall-relevance.js';
import {
  conversationIndexDatabasePath,
  conversationIndexManifestPath,
  flushConversationIndexMutations,
  readConversationMutationInfo,
  readConversationMutationRevision,
} from './history-index-state.js';

const MAX_REBUILD_RETRIES = 3;
const RECALL_WAIT_MS = 1_500;
const MAX_HISTORY_INDEX_MANAGERS = 8;
const HISTORY_INDEX_IDLE_MS = 5 * 60_000;
const DESTRUCTIVE_MUTATION_REASONS = new Set([
  'archive-session',
  'clear',
  'compact-orphans',
  'delete-session',
  'restore-session',
]);
let requestCounter = 0;
const managers = new Map();
let managerAdmission = Promise.resolve();

async function withManagerAdmission(run) {
  const previous = managerAdmission;
  let release;
  managerAdmission = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    return await run();
  } finally {
    release();
  }
}

function managerKey(ownerRoot, sessionId) {
  return `${ownerRoot}\u001f${sessionId}`;
}

function readManifest(ownerRoot, sessionId) {
  const path = conversationIndexManifestPath(ownerRoot, sessionId);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (Number(value?.indexSchemaVersion) !== 2) return null;
    const generation = Number(value?.generation);
    if (!Number.isInteger(generation) || generation < 1) return null;
    const databasePath = conversationIndexDatabasePath(ownerRoot, sessionId, generation);
    if (value.databasePath !== databasePath) return null;
    return { ...value, generation, databasePath };
  } catch {
    return null;
  }
}

function writeManifest(ownerRoot, sessionId, manifest) {
  const path = conversationIndexManifestPath(ownerRoot, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function spawnOneShot(mode, data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./history-index-worker.js', import.meta.url), {
      workerData: { mode, ...data },
    });
    let settled = false;
    worker.on('message', message => {
      if (message?.type === 'rebuilt' || message?.type === 'fingerprint') {
        settled = true;
        resolve(message.result);
      } else if (message?.type === 'fatal') {
        settled = true;
        reject(new Error(message.error));
      }
    });
    worker.on('error', error => {
      if (!settled) reject(error);
    });
    worker.on('exit', code => {
      if (!settled && code !== 0) reject(new Error(`history index rebuild worker exited ${code}`));
    });
  });
}

class HistoryIndexQueryWorker {
  constructor({ ownerRoot, sessionId, databasePath, generation }) {
    this.ownerRoot = ownerRoot;
    this.sessionId = sessionId;
    this.databasePath = databasePath;
    this.generation = generation;
    this.pending = new Map();
    this.worker = new Worker(new URL('./history-index-worker.js', import.meta.url), {
      workerData: {
        mode: 'query',
        ownerRoot,
        sessionId,
        databasePath,
        generation,
        testHooksEnabled: process.env.NODE_ENV === 'test',
      },
    });
    this.worker.on('message', message => {
      if (message?.type === 'fatal') {
        this.#rejectAll(new Error(message.error));
        return;
      }
      const pending = this.pending.get(message?.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      if (this.pending.size === 0) this.worker.unref();
      if (message.error) {
        const error = new Error(message.error);
        if (message.code) error.code = message.code;
        pending.reject(error);
      } else pending.resolve(message.result);
    });
    this.worker.on('error', error => this.#rejectAll(error));
    this.worker.on('exit', code => {
      if (code !== 0) this.#rejectAll(new Error(`history index query worker exited ${code}`));
    });
    // Installing a message listener refs the MessagePort again. Idle indexes
    // must not keep one-shot CLI processes alive; only in-flight reads do.
    this.worker.unref();
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker.unref();
  }

  request(op, payload) {
    const requestId = `history-index-${process.pid}-${++requestCounter}`;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.ref();
      this.worker.postMessage({ requestId, op, payload });
    });
  }

  async close({ graceful = false } = {}) {
    if (graceful) {
      const deadline = Date.now() + 5_000;
      while (this.pending.size > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    try { this.worker.postMessage({ op: 'close' }); } catch {}
    await this.worker.terminate();
    this.#rejectAll(new Error('history index worker closed'));
  }
}

class SessionHistoryIndex {
  constructor(ownerRoot, sessionId) {
    this.ownerRoot = ownerRoot;
    this.sessionId = sessionId;
    this.active = null;
    this.activeManifest = null;
    this.rebuildPromise = null;
    this.reconcilePromise = null;
    this.rebuildTimer = null;
    this.idleTimer = null;
    this.lastUsedAt = Date.now();
    this.leases = 0;
    this.closed = false;
  }

  touch() {
    if (this.closed) return;
    this.lastUsedAt = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.leases > 0 || this.rebuildPromise || this.reconcilePromise) {
        this.touch();
        return;
      }
      retireConversationHistoryIndex(this.ownerRoot, this.sessionId).catch(error => {
        console.warn('[history-index] idle retirement failed:', error?.message || error);
      });
    }, HISTORY_INDEX_IDLE_MS);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  acquire() {
    if (this.closed) return false;
    this.leases += 1;
    this.touch();
    return true;
  }

  release() {
    if (this.leases > 0) this.leases -= 1;
    this.touch();
  }

  get evictable() {
    return !this.closed && this.leases === 0 && !this.rebuildPromise && !this.reconcilePromise;
  }

  async #activate(manifest) {
    if (this.closed || !manifest?.databasePath || !existsSync(manifest.databasePath)) return false;
    if (this.active?.databasePath === manifest.databasePath) {
      this.activeManifest = manifest;
      return true;
    }
    const next = new HistoryIndexQueryWorker({
      ownerRoot: this.ownerRoot,
      sessionId: this.sessionId,
      databasePath: manifest.databasePath,
      generation: manifest.generation,
    });
    const previous = this.active;
    this.active = next;
    this.activeManifest = manifest;
    if (previous) {
      await previous.close({ graceful: true });
      if (previous.databasePath !== manifest.databasePath) {
        for (const suffix of ['', '-wal', '-shm']) rmSync(`${previous.databasePath}${suffix}`, { force: true });
      }
    }
    return true;
  }

  async #needsRebuild() {
    const manifest = readManifest(this.ownerRoot, this.sessionId);
    if (!manifest?.databasePath || !existsSync(manifest.databasePath)) return { needs: true, manifest };
    const revision = readConversationMutationRevision(this.ownerRoot, 'session', this.sessionId);
    if (Number(manifest.sourceRevision) !== revision) return { needs: true, manifest };
    if (this.active?.databasePath === manifest.databasePath) return { needs: false, manifest };
    const source = await spawnOneShot('fingerprint', {
      ownerRoot: this.ownerRoot,
      sessionId: this.sessionId,
    });
    if (source.fingerprint !== manifest.sourceFingerprint
      || source.rawFingerprint !== manifest.rawSourceFingerprint) return { needs: true, manifest };
    await this.#activate(manifest);
    return { needs: false, manifest };
  }

  async #reconcileActiveSource() {
    if (!this.active || !this.activeManifest) return false;
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = (async () => {
      const revision = readConversationMutationRevision(this.ownerRoot, 'session', this.sessionId);
      if (Number(this.activeManifest.sourceRevision) !== revision) {
        await this.rebuild();
        return true;
      }
      const worker = this.active;
      const manifest = this.activeManifest;
      let source;
      try {
        source = await worker.request('source-token', {});
      } catch (error) {
        if (this.closed || worker !== this.active) return false;
        throw error;
      }
      if (worker !== this.active || manifest !== this.activeManifest) return false;
      if (source.fingerprint === manifest.rawSourceFingerprint) return false;
      await this.rebuild();
      return true;
    })();
    try {
      return await this.reconcilePromise;
    } finally {
      this.reconcilePromise = null;
    }
  }

  scheduleRebuild() {
    if (this.closed || this.rebuildTimer || this.rebuildPromise || !this.active) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuild().catch(error => {
        console.warn('[history-index] background rebuild failed:', error?.message || error);
      });
    }, 50);
    if (typeof this.rebuildTimer.unref === 'function') this.rebuildTimer.unref();
  }

  async ensureReady({ allowStale = true, waitForBuild = true } = {}) {
    if (this.active) {
      const revision = readConversationMutationRevision(this.ownerRoot, 'session', this.sessionId);
      if (Number(this.activeManifest?.sourceRevision) !== revision) {
        this.scheduleRebuild();
        if (!allowStale) await this.rebuild();
      }
      return this.active;
    }

    const manifest = readManifest(this.ownerRoot, this.sessionId);
    if (manifest?.databasePath && existsSync(manifest.databasePath)) {
      if (allowStale) {
        await this.#activate(manifest);
        return this.active;
      }
      const state = await this.#needsRebuild();
      if (state.needs) await this.rebuild();
      return this.active;
    }
    if (!waitForBuild) {
      this.rebuild().catch(error => {
        console.warn('[history-index] initial background build failed:', error?.message || error);
      });
      const error = new Error('history index building');
      error.code = 'index_building';
      throw error;
    }
    await this.rebuild();
    return this.active;
  }

  async rebuild() {
    if (this.rebuildPromise) return this.rebuildPromise;
    if (this.closed) throw new Error('history index manager closed');
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    this.rebuildPromise = (async () => {
      for (let attempt = 0; attempt < MAX_REBUILD_RETRIES; attempt += 1) {
        const previous = readManifest(this.ownerRoot, this.sessionId);
        const generation = Math.max(Number(previous?.generation) || 0, Number(this.activeManifest?.generation) || 0) + 1;
        const sourceRevision = readConversationMutationRevision(this.ownerRoot, 'session', this.sessionId);
        const databasePath = conversationIndexDatabasePath(this.ownerRoot, this.sessionId, generation);
        let result;
        try {
          result = await spawnOneShot('rebuild', {
            ownerRoot: this.ownerRoot,
            sessionId: this.sessionId,
            databasePath,
            generation,
            sourceRevision,
          });
        } catch (error) {
          rmSync(databasePath, { force: true });
          if (String(error?.message || '').includes('source changed during rebuild') && attempt + 1 < MAX_REBUILD_RETRIES) continue;
          throw error;
        }
        const currentRevision = readConversationMutationRevision(this.ownerRoot, 'session', this.sessionId);
        if (currentRevision !== sourceRevision) {
          rmSync(databasePath, { force: true });
          if (attempt + 1 < MAX_REBUILD_RETRIES) continue;
          throw new Error('history source did not stabilize during rebuild');
        }
        const manifest = {
          version: 1,
          indexSchemaVersion: 2,
          sessionId: this.sessionId,
          generation,
          databasePath,
          sourceRevision,
          sourceFingerprint: result.fingerprint,
          rawSourceFingerprint: result.rawFingerprint,
          sourceFiles: result.files,
          sourceBytes: result.bytes,
          entryCount: result.entryCount,
          builtAt: new Date().toISOString(),
        };
        if (this.closed) {
          for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true });
          return manifest;
        }
        writeManifest(this.ownerRoot, this.sessionId, manifest);
        await this.#activate(manifest);
        return manifest;
      }
      throw new Error('history index rebuild exhausted retries');
    })();
    try {
      return await this.rebuildPromise;
    } finally {
      this.rebuildPromise = null;
      const revision = readConversationMutationRevision(this.ownerRoot, 'session', this.sessionId);
      if (this.active && Number(this.activeManifest?.sourceRevision) !== revision) this.scheduleRebuild();
    }
  }

  async #strictRequest(op, payload, retries = 1) {
    await this.#reconcileActiveSource();
    const worker = this.active;
    const manifest = this.activeManifest;
    const revision = readConversationMutationRevision(this.ownerRoot, 'session', this.sessionId);
    const result = await worker.request(op, payload);
    const source = await worker.request('source-token', {});
    const currentRevision = readConversationMutationRevision(this.ownerRoot, 'session', this.sessionId);
    const stable = worker === this.active
      && manifest?.generation === this.activeManifest?.generation
      && revision === currentRevision
      && source.fingerprint === manifest?.rawSourceFingerprint;
    if (stable) return result;
    if (retries > 0 && op !== 'validate-and-read-window') {
      await this.rebuild();
      return this.#strictRequest(op, payload, retries - 1);
    }
    const error = new Error('history source changed during request');
    error.code = 'stale_result';
    throw error;
  }

  // A newly persisted user invalidates even a warm index on every query. Give
  // rebuilds a bounded opportunity to catch up, without ever trusting an old
  // prefix (a destructive mutation may have preceded the latest append).
  // The first cold call starts a background build; subsequent calls join it.
  async recall(payload) {
    const deadline = Date.now() + RECALL_WAIT_MS;
    const notReady = reason => ({ turns: [], meta: { status: 'not_ready', reason } });
    const withinDeadline = async promise => {
      let timer;
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error('history recall readiness deadline exceeded');
              error.code = 'index_building';
              reject(error);
            }, Math.max(0, deadline - Date.now()));
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    // Do not cancel a timed-out build: the next query must be able to make
    // progress, rather than continually restarting a cold or stale rebuild.
    if (this.rebuildPromise || this.rebuildTimer) await withinDeadline(this.rebuild());
    await withinDeadline(this.ensureReady({ allowStale: true, waitForBuild: false }));
    if (readConversationMutationRevision(this.ownerRoot, 'session', this.sessionId)
      !== Number(this.activeManifest?.sourceRevision)) {
      await withinDeadline(this.rebuild());
    }
    const worker = this.active;
    const manifest = this.activeManifest;
    const revision = readConversationMutationRevision(this.ownerRoot, 'session', this.sessionId);
    if (revision !== Number(manifest?.sourceRevision)) {
      this.scheduleRebuild();
      return notReady('stale_result');
    }
    // Never retry a result invalidated during its read. Raw source fingerprints
    // fence external edits too; revision and generation fence manager races.
    const result = await withinDeadline(worker.request('recall-turns', payload));
    if (worker !== this.active || manifest !== this.activeManifest
      || revision !== readConversationMutationRevision(this.ownerRoot, 'session', this.sessionId)
      || result.meta?.status === 'not_ready') {
      this.scheduleRebuild();
      return notReady('stale_result');
    }
    return result;
  }

  async request(op, payload) {
    this.leases += 1;
    this.touch();
    try {
      if (op === 'recall-turns') return await this.recall(payload);
      const mutation = readConversationMutationInfo(this.ownerRoot, 'session', this.sessionId);
      const allowStale = op === 'outline'
        && !payload?.cursor
        && !DESTRUCTIVE_MUTATION_REASONS.has(mutation.reason);
      const waitForBuild = payload?._waitForBuild === true;
      const worker = await this.ensureReady({ allowStale, waitForBuild });
      try {
        if (allowStale) {
          const result = await worker.request(op, payload);
          this.#reconcileActiveSource().catch(error => {
            if (!this.closed) {
              console.warn('[history-index] background source reconcile failed:', error?.message || error);
            }
          });
          return result;
        }
        return await this.#strictRequest(op, payload);
      } catch (error) {
        if (error?.code === 'stale_result' || this.closed) throw error;
        await this.rebuild();
        return allowStale
          ? this.active.request(op, payload)
          : this.#strictRequest(op, payload, 0);
      }
    } finally {
      this.leases -= 1;
      this.touch();
    }
  }

  async close() {
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    await Promise.allSettled([this.rebuildPromise].filter(Boolean));
    if (this.active) await this.active.close();
    this.active = null;
    this.activeManifest = null;
    this.reconcilePromise = null;
  }
}

async function acquireHistoryIndexManager(ownerRoot, sessionId) {
  const key = managerKey(ownerRoot, sessionId);
  for (;;) {
    const manager = await withManagerAdmission(async () => {
      const existing = managers.get(key);
      if (existing?.acquire()) return existing;
      if (managers.size >= MAX_HISTORY_INDEX_MANAGERS) {
        const candidate = Array.from(managers.entries())
          .filter(([, current]) => current.evictable)
          .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
        if (!candidate) return null;
        managers.delete(candidate[0]);
        await candidate[1].close();
      }
      const created = new SessionHistoryIndex(ownerRoot, sessionId);
      managers.set(key, created);
      created.acquire();
      return created;
    });
    if (manager) return manager;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function requestConversationHistoryIndex(ownerRoot, sessionId, op, payload) {
  const manager = await acquireHistoryIndexManager(ownerRoot, sessionId);
  try {
    return await manager.request(op, payload);
  } finally {
    manager.release();
  }
}

export async function retireConversationHistoryIndex(ownerRoot, sessionId) {
  const key = managerKey(ownerRoot, sessionId);
  const manager = managers.get(key);
  if (!manager) return false;
  managers.delete(key);
  await manager.close();
  return true;
}

export async function searchConversationIndex(ownerRoot, sessionId, query, opts = {}) {
  return requestConversationHistoryIndex(ownerRoot, sessionId, 'search', {
    query,
    ...opts,
    _waitForBuild: opts._waitForBuild !== false,
  });
}

/**
 * Recall complete visible user/assistant turns from this owner-root Session.
 * beforeSeq excludes that user turn and all later rows (exclusive seq fence).
 * limit defaults to 5, capped at 5; 0 disables recall.
 * maxTurnRows/maxTurnBytes/maxReadBytes may only lower hard worker caps. Canonical message IDs identify entries; their
 * sourceMessageIds preserve all persisted identities, including aggregated VP
 * replies. The first cold call yields not_ready and starts a background build;
 * later calls wait up to 1500ms for readiness and the worker read, without
 * cancelling a timed-out build. Mutations during a read yield not_ready.
 * Discovery is bounded, not exhaustive: each >=3-character term uses the first
 * 32 trigram candidates (before seq filtering), and shorter terms only inspect
 * the newest 512 eligible entry metadata rows. A ready/no_match is not proof
 * that the entire Session lacks a match; meta.candidateCapped exposes caps.
 */
export async function recallConversationTurns(ownerRoot, sessionId, prompt, opts = {}) {
  const terms = extractRecallTerms(prompt);
  const limit = normalizeRecallLimit(opts.limit);
  if (limit === 0) return { turns: [], meta: { status: 'disabled', reason: 'disabled', terms } };
  const eligibility = scoreRecallTurn(terms, terms.join(' '));
  if (!eligibility.score) {
    return { turns: [], meta: { status: 'ready', reason: eligibility.reason, terms } };
  }
  try {
    return await requestConversationHistoryIndex(ownerRoot, sessionId, 'recall-turns', {
      prompt: typeof prompt === 'string' ? prompt.slice(0, 4096) : '',
      beforeSeq: opts.beforeSeq,
      limit,
      maxTurnRows: opts.maxTurnRows,
      maxTurnBytes: opts.maxTurnBytes,
      maxReadBytes: opts.maxReadBytes,
      ...(process.env.NODE_ENV === 'test' ? { _testBarrier: opts._testBarrier } : {}),
    });
  } catch (error) {
    if (!['index_building', 'stale_result', 'source_changed'].includes(error?.code)) throw error;
    return { turns: [], meta: { status: 'not_ready', reason: error.code, terms } };
  }
}

export async function loadConversationOutlineFromIndex(ownerRoot, sessionId, opts = {}) {
  return requestConversationHistoryIndex(ownerRoot, sessionId, 'outline', {
    ...opts,
    _waitForBuild: opts._waitForBuild !== false,
  });
}

export async function validateConversationIndexAnchor(ownerRoot, sessionId, anchor) {
  return requestConversationHistoryIndex(ownerRoot, sessionId, 'validate-anchor', {
    ...anchor,
    _waitForBuild: anchor?._waitForBuild !== false,
  });
}

export async function readConversationIndexWindow(ownerRoot, sessionId, anchor) {
  return requestConversationHistoryIndex(ownerRoot, sessionId, 'validate-and-read-window', {
    ...anchor,
    _waitForBuild: anchor?._waitForBuild !== false,
  });
}

export async function closeConversationHistoryIndexes({ releaseMutationState = true } = {}) {
  const closing = Array.from(managers.values(), manager => manager.close());
  managers.clear();
  await Promise.allSettled(closing);
  flushConversationIndexMutations(null, { release: releaseMutationState });
}

export const __historyIndexForTest = {
  readManifest,
  writeManifest,
  managers,
  maxManagers: MAX_HISTORY_INDEX_MANAGERS,
};
