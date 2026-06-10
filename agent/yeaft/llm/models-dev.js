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
 * Synchronously look up a model's `{context, output}` limits from whatever
 * models.dev snapshot is currently warmed in memory.
 *
 * The yeaft engine query loop is synchronous (engine.js, config.js, cli.js
 * all read the context window inline). To avoid bubbling async up through
 * every gate, the agent boot script primes `fetchModelsDev()` once so this
 * function can read straight from `_memCache` afterwards.
 *
 * If the cache is empty (boot prime failed or test never warmed it), or the
 * model isn't present in any provider entry, returns `null` — callers fall
 * back to the next rung of their resolver ladder.
 *
 * Collision policy: a given model id can appear under multiple providers
 * (e.g. `qwen3-32b` lives under 7 providers in the live models.dev snapshot
 * with context limits ranging 32K–131K). Behavior:
 *
 *   • If `providerHint` is given AND that provider lists the model, we use
 *     that provider's numbers verbatim — the caller knew which gateway it
 *     was talking to.
 *   • Otherwise we take the MIN of every provider's `context` and `output`.
 *     Context is a ceiling: under-shooting risks an early compact (bad);
 *     over-shooting risks an LLMContextError mid-query (worse). Min picks
 *     the safer side. Users who know better can pin numbers explicitly via
 *     `providers[].models[].contextWindow` in `~/.yeaft/config.json`.
 *
 * @param {string} modelId
 * @param {string|null} [providerHint] Provider id matching the models.dev
 *   top-level key (e.g. 'anthropic', 'openai', 'google', 'deepseek'). The
 *   MODEL_REGISTRY's `provider` field is aligned to these ids deliberately.
 * @returns {{ context?: number, output?: number } | null}
 */
export function lookupModelLimitSync(modelId, providerHint = null) {
  if (!modelId || !_memCache || typeof _memCache !== 'object') return null;

  // Hit the hint first if it actually lists this model.
  if (providerHint && typeof providerHint === 'string') {
    const provEntry = _memCache[providerHint];
    const m = provEntry?.models?.[modelId];
    if (m && m.limit && typeof m.limit === 'object') {
      const out = {};
      if (Number.isFinite(m.limit.context) && m.limit.context > 0) out.context = m.limit.context;
      if (Number.isFinite(m.limit.output) && m.limit.output > 0) out.output = m.limit.output;
      if (out.context !== undefined || out.output !== undefined) return out;
    }
    // Hint missed — fall through to the scan rather than returning null,
    // because the model genuinely might live under another provider id
    // (e.g. a deepseek model surfaced via a relay).
  }

  // Scan every provider; collect context/output values, return MIN.
  let minCtx = null;
  let minOut = null;
  for (const provId of Object.keys(_memCache)) {
    const m = _memCache[provId]?.models?.[modelId];
    if (!m || !m.limit || typeof m.limit !== 'object') continue;
    if (Number.isFinite(m.limit.context) && m.limit.context > 0) {
      minCtx = minCtx === null ? m.limit.context : Math.min(minCtx, m.limit.context);
    }
    if (Number.isFinite(m.limit.output) && m.limit.output > 0) {
      minOut = minOut === null ? m.limit.output : Math.min(minOut, m.limit.output);
    }
  }
  if (minCtx === null && minOut === null) return null;
  const result = {};
  if (minCtx !== null) result.context = minCtx;
  if (minOut !== null) result.output = minOut;
  return result;
}

/**
 * Reset the in-memory cache. Test seam.
 */
export function _resetMemCache() {
  _memCache = null;
  _memCachePath = null;
  _memCacheTime = 0;
}

/**
 * Inject a snapshot into the in-memory cache without going through the
 * fetch/disk path. Test seam: callers that want to exercise
 * `lookupModelLimitSync` deterministically can seed any shape they need.
 *
 * @param {object} snapshot models.dev-shaped data
 */
export function _setMemCacheForTest(snapshot) {
  _memCache = snapshot && typeof snapshot === 'object' ? snapshot : null;
  _memCachePath = '__test__';
  _memCacheTime = Date.now();
}
