import { Worker } from 'node:worker_threads';
import { loadConfig } from '../config.js';
import { createLLMAdapter } from '../llm/adapter.js';
import { runDailySharedKnowledge } from './flow.js';

const CHECK_MS = 5 * 60_000;
const SOURCE_RPC_MS = 120_000;
const RUN_TIMEOUT_MS = 45 * 60_000;
let stop = null;

/** Latest scheduled 01:00 in this Agent's local timezone (not 24h after the last run). */
export function latestKnowledgeSlot(now) {
  const local = new Date(now);
  const slot = new Date(now);
  slot.setHours(1, 0, 0, 0);
  if (slot > local) slot.setDate(slot.getDate() - 1);
  // Persist a calendar key so a restart or offset change within a date does
  // not produce a second job for that date.
  return slot.getFullYear() * 10_000 + (slot.getMonth() + 1) * 100 + slot.getDate();
}

export function openKnowledgeSourceWorker(root, signal) {
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./source-worker.js', import.meta.url), { workerData: { root } });
  let task = null;
  let closing = null;
  let unavailable = false;
  const fail = () => {
    unavailable = true;
    task?.finish(new Error('knowledge_source_worker_unavailable'));
  };
  const close = () => {
    signal?.removeEventListener('abort', close);
    fail();
    closing ||= worker.terminate();
    return closing;
  };
  worker.on('message', ({ data, error }) => {
    if (!error) task?.finish(null, data);
    else task?.finish(Object.assign(new Error(error), { code: error }));
  });
  worker.on('error', fail);
  worker.on('exit', fail);
  signal?.addEventListener('abort', close, { once: true });
  const request = (op, ...args) => new Promise((resolve, reject) => {
    if (unavailable || task) return reject(new Error('knowledge_source_worker_unavailable'));
    const timer = setTimeout(close, SOURCE_RPC_MS);
    timer.unref();
    task = { finish(error, value) {
      clearTimeout(timer);
      task = null;
      if (error) reject(error);
      else resolve(value);
    } };
    try { worker.postMessage({ op, args }); } catch (error) { task?.finish(error); }
  });
  return { request, close };
}

/** No Session is created. Starts on local boot, even when the Server is offline. */
export function startDailySharedKnowledge(root) {
  if (!root || stop) return;
  const controller = new AbortController();
  let running = null;
  let finishedSlot = null;
  let retryAt = 0;
  let retries = 0;
  let attemptedSlot = null;
  const check = () => {
    const now = Date.now();
    if (running || controller.signal.aborted) return;
    const slot = latestKnowledgeSlot(now);
    if (slot === finishedSlot || (slot === attemptedSlot && now < retryAt)) return;
    if (slot !== attemptedSlot) { attemptedSlot = slot; retries = 0; }
    const backoff = () => {
      retries += 1;
      retryAt = Date.now() + Math.min(60 * 60_000, CHECK_MS * 2 ** Math.min(retries - 1, 4)) + Math.random() * 30_000;
    };
    running = (async () => {
      const config = loadConfig({ dir: root });
      if (config.sharedKnowledge?.enabled !== true) return;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]);
      const result = await runDailySharedKnowledge({ root, slot, cutoff: now, signal,
        openSource: workerSignal => openKnowledgeSourceWorker(root, workerSignal),
        openModel: async () => ({ config, adapter: await createLLMAdapter(config) }),
      });
      if (['ok', 'empty', 'done'].includes(result.status)) finishedSlot = slot;
      else backoff();
      if (!['done', 'busy'].includes(result.status)) console.log('[SharedKnowledge]', result);
    })().catch(error => {
      backoff();
      if (!controller.signal.aborted) console.warn('[SharedKnowledge] retry pending:', error.code || error.name);
    }).finally(() => { running = null; });
  };
  const first = setTimeout(check, 5_000);
  const interval = setInterval(check, CHECK_MS);
  first.unref();
  interval.unref();
  stop = async () => {
    clearTimeout(first);
    clearInterval(interval);
    controller.abort();
    await running;
  };
}

export async function stopDailySharedKnowledge() {
  const shutdown = stop;
  await shutdown?.();
  if (stop === shutdown) stop = null;
}
