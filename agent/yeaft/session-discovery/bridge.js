import { Worker } from 'node:worker_threads';
import { ensureWorkspaceFoldersSnapshot, readWorkspaceFoldersSnapshot } from '../workspace-folders.js';
import { changeShare, listActiveSessionCards, listShare, openDiscoveryStore, searchDiscovery } from './store.js';

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const WORKSPACE_FOLDER_REFRESH_COOLDOWN_MS = 15_000;
let scheduler = null;

/** First run after registration; persistent due time prevents reindex on restart. */
export function startSessionDiscovery(root, { agentWorkDir = '' } = {}) {
  if (!root || scheduler) return;
  // Lazily initialize the <=3 level workspace folder snapshot once in the background
  // when missing; existing snapshots are untouched until an explicit refresh.
  const folderInitTimer = setTimeout(() => {
    try { ensureWorkspaceFoldersSnapshot(root, { force: false, agentWorkDir }); }
    catch (err) { console.warn('[SessionDiscovery] workspace folders init skipped:', err?.message || err); }
  }, 500);
  folderInitTimer.unref();
  let worker = null;
  let workerTimeout = null;
  const check = () => {
    if (worker) return;
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { root } });
      worker.unref();
      let finished = false;
      worker.on('message', () => { finished = true; });
      worker.on('error', error => console.warn('[SessionDiscovery] index worker failed:', error.code || error.name));
      worker.once('exit', code => {
        if (!finished && code) console.warn('[SessionDiscovery] index refresh did not complete');
        clearTimeout(workerTimeout);
        worker = null;
      });
      workerTimeout = setTimeout(() => { void worker?.terminate(); }, 2 * 60 * 1000);
      workerTimeout.unref();
    } catch (error) {
      console.warn('[SessionDiscovery] index unavailable:', error.code || error.name);
    }
  };
  const first = setTimeout(check, 1_000);
  const interval = setInterval(check, CHECK_INTERVAL_MS);
  first.unref();
  interval.unref();
  scheduler = async () => {
    clearTimeout(folderInitTimer);
    clearTimeout(first);
    clearInterval(interval);
    clearTimeout(workerTimeout);
    await worker?.terminate();
  };
}

export async function stopSessionDiscovery() {
  const stop = scheduler;
  scheduler = null;
  await stop?.();
}

export async function handleSessionDiscovery(msg, root, send, { agentWorkDir = '' } = {}) {
  const { requestId, op, ownerId, allowedIds, payload } = msg;
  const reply = result => send({ type: 'session_discovery_response', requestId, op, ...result });
  if (!root || !ownerId || !Array.isArray(allowedIds)) return reply({ ok: false, error: 'Search unavailable' });
  try {
    if (op === 'workspace_folders') {
      const existing = readWorkspaceFoldersSnapshot(root);
      const now = Date.now();
      const canForceRefresh = payload?.refresh === true
        && (!existing?.scannedAt || now - existing.scannedAt >= WORKSPACE_FOLDER_REFRESH_COOLDOWN_MS);
      const snapshot = ensureWorkspaceFoldersSnapshot(root, {
        force: canForceRefresh,
        agentWorkDir,
      });
      return reply({
        ok: true,
        data: {
          scannedAt: snapshot.scannedAt ?? null,
          folders: (snapshot.folders || []).slice(0, 120).map(f => ({
            path: String(f.path || '').slice(0, 512),
            name: String(f.name || '').slice(0, 120),
            depth: Number.isSafeInteger(f.depth) ? f.depth : 0,
            markers: Array.isArray(f.markers) ? f.markers.slice(0, 8) : [],
            label: typeof f.label === 'string' ? f.label.slice(0, 120) : '',
          })),
        },
      });
    }
    const db = openDiscoveryStore(root);
    let data;
    try {
      switch (op) {
        case 'search': data = searchDiscovery(db, root, allowedIds, payload.query, Date.now(), {
          activeWindowDays: payload.activeWindowDays,
          limit: payload.limit,
        }); break;
        case 'active_sessions': data = listActiveSessionCards(db, root, allowedIds, Date.now(), {
          activeWindowDays: payload.activeWindowDays,
          limit: payload.limit,
        }); break;
        case 'share_list': data = listShare(db, root, ownerId, allowedIds); break;
        case 'share_save':
        case 'share_delete': data = changeShare(db, root, ownerId, allowedIds, op, payload); break;
        default: throw new Error('Unsupported discovery operation');
      }
    } finally { db.close(); }
    return reply({ ok: true, data });
  } catch (error) {
    console.warn('[SessionDiscovery] request failed:', op, error.code || error.name);
    return reply({ ok: false, error: 'Session discovery request failed' });
  }
}
