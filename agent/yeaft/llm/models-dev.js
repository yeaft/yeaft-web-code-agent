/**
 * models.dev registry integration — community-maintained provider/model database.
 *
 * Fetches https://models.dev/api.json (4000+ models across 109+ providers) and
 * exposes provider/model metadata to the rest of the agent. Ported from hermes
 * `agent/models_dev.py`.
 *
 * Cache hierarchy (when forceRefresh=false):
 *   1. In-memory cache, populated and < TTL old → return immediately.
 *   2. Disk cache file < TTL old by mtime → load, populate in-mem, return.
 *   3. Network fetch → on success, save to disk + in-mem and return.
 *   4. Network fails → fall back to ANY available disk cache (even stale)
 *      with a short 5 min in-mem grace period.
 *
 * forceRefresh=true skips stages 1 and 2 (used by manual refresh button).
 */

import { readFile, writeFile, stat, mkdir, rename } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const NETWORK_TIMEOUT_MS = 15000;
const STALE_GRACE_MS = 5 * 60 * 1000; // 5 minutes when serving stale-after-failure

let _memCache = null;
let _memCachePath = null;
let _memCacheTime = 0;

function getCachePath(yeaftDir) {
  const base = yeaftDir || join(homedir(), '.yeaft');
  return join(base, 'models_dev_cache.json');
}

async function diskCacheAgeMs(yeaftDir) {
  try {
    const s = await stat(getCachePath(yeaftDir));
    // Clamp negative ages (clock-skew between filesystem mtime and
    // JS Date.now() can momentarily be a few ms ahead on some CI
    // runners). Returning null here would skip stage-2 and force a
    // network fetch — which broke the deterministic listProviders test
    // by serving the live ~140-provider models.dev payload. A freshly
    // written cache is, by definition, fresh.
    const age = Date.now() - s.mtimeMs;
    return age < 0 ? 0 : age;
  } catch {
    return null;
  }
}

async function loadDiskCache(yeaftDir) {
  try {
    const raw = await readFile(getCachePath(yeaftDir), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveDiskCache(yeaftDir, data) {
  try {
    const path = getCachePath(yeaftDir);
    await mkdir(dirname(path), { recursive: true });
    const tmp = path + '.tmp';
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, path);
  } catch (e) {
    // Cache is best-effort. Failure to persist must not break callers.
  }
}

/**
 * Fetch the models.dev registry with layered caching.
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh] Skip in-mem + fresh-disk stages.
 * @param {string}  [opts.yeaftDir] Override ~/.yeaft cache directory.
 * @returns {Promise<object>} provider-id → provider entry; {} on total failure.
 */
export async function fetchModelsDev({ forceRefresh = false, yeaftDir = null } = {}) {
  const cachePath = getCachePath(yeaftDir);

  // Stage 1: in-memory cache.
  if (!forceRefresh && _memCache && _memCachePath === cachePath && Date.now() - _memCacheTime < CACHE_TTL_MS) {
    return _memCache;
  }

  // Stage 2: fresh-by-mtime disk cache short-circuits the network.
  if (!forceRefresh) {
    const age = await diskCacheAgeMs(yeaftDir);
    if (age !== null && age < CACHE_TTL_MS) {
      const data = await loadDiskCache(yeaftDir);
      if (data && typeof data === 'object') {
        _memCache = data;
        _memCachePath = cachePath;
        _memCacheTime = Date.now() - age;
        return _memCache;
      }
    }
  }

  // Stage 3: network fetch.
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
    try {
      const res = await fetch(MODELS_DEV_URL, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data && typeof data === 'object') {
        _memCache = data;
        _memCachePath = cachePath;
        _memCacheTime = Date.now();
        await saveDiskCache(yeaftDir, data);
        return data;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Fall through to stale cache.
  }

  // Stage 4: stale disk cache fallback with short grace TTL so we retry soon.
  if (!_memCache || _memCachePath !== cachePath) {
    const data = await loadDiskCache(yeaftDir);
    if (data && typeof data === 'object') {
      _memCache = data;
      _memCachePath = cachePath;
      _memCacheTime = Date.now() - CACHE_TTL_MS + STALE_GRACE_MS;
    }
  }

  return _memCachePath === cachePath ? (_memCache || {}) : {};
}

/**
 * List all provider ids in the registry.
 * @returns {Promise<string[]>}
 */
export async function listProviders({ yeaftDir = null } = {}) {
  const data = await fetchModelsDev({ yeaftDir });
  return Object.keys(data).sort();
}

/**
 * Return raw provider entry from models.dev (with name, env, api, models).
 */
export async function getProviderInfo(providerId, { yeaftDir = null } = {}) {
  const data = await fetchModelsDev({ yeaftDir });
  const entry = data[providerId];
  return entry && typeof entry === 'object' ? entry : null;
}

/**
 * List model ids advertised by a provider.
 * @returns {Promise<string[]>}
 */
export async function listProviderModels(providerId, { yeaftDir = null } = {}) {
  const info = await getProviderInfo(providerId, { yeaftDir });
  const models = info?.models;
  if (!models || typeof models !== 'object') return [];
  return Object.keys(models);
}

/**
 * Reset the in-memory cache. Test seam.
 */
export function _resetMemCache() {
  _memCache = null;
  _memCachePath = null;
  _memCacheTime = 0;
}
