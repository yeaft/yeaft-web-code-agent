/**
 * vp-bridge.js — task-334-ui-a snapshot + task-334h live-diff WS adapter.
 *
 * This module is the SOLE serialiser for the wire-format VP shape.
 * Per ruling §1 (D1 = (b) web-bridge boundary rename), the entity layer
 * (`vp-store.js` / `registry.js`) keeps `id` / `name`; here we map to
 * `vpId` / `displayName` per the spec (§2.1) / architecture §R6.11.
 *
 * Per ruling §2 (D2):
 *   • subtitle  → agent emits `vp.role` directly
 *   • personaHash → agent emits `vp.personaHash`
 *   • color / avatar → web-derived, NOT emitted here
 *
 * task-334h — live diff:
 *   • subscribers (Set of sendSessionEvent fns) receive per-vp `vp_updated`
 *     and `vp_removed` events as VpLoader's debounced rescan commits
 *     added / updated / removed vpIds.
 *   • Event shape: `{ type, vpId, vp?, reason? }` where `reason` ∈
 *     { 'persona.edit', 'traits.edit', 'manual.reload', 'file.removed' }.
 *   • Back-compat: `vp_snapshot` shape unchanged; `reason` is purely
 *     additive so older web clients ignore it.
 */

import { defaultRegistry } from './registry.js';
import { VpLoader } from './vp-loader.js';
import { STOCK_VP_IDS } from './stock-ids.js';

/** Process-singleton VpLoader; lazily started on first subscribe. */
let _loaderStarted = false;
let _loader = null;
let _loaderDir = null;

/**
 * Broadcast fan-out. VpLoader.onChange fires once per debounce batch for the
 * whole process, so every active subscriber must receive each live-diff event.
 * @type {Set<(event:object)=>void>}
 */
const _subscribers = new Set();

/**
 * Last-seen persona snapshot per vpId, used to classify `reason` when an
 * `updated` entry arrives from VpLoader. We cache only the minimal fields we
 * compare against, never the VP reference (identity is stable via
 * registry.updateVpInPlace, so by the time onChange fires the registry
 * already holds the new values — we must remember the *previous* values).
 *
 * Shape: vpId → { persona: string, traits: string[] }
 * @type {Map<string, {persona:string, traits:string[]}>}
 */
const _prevState = new Map();

function tsnap(vp) {
  return {
    persona: vp && typeof vp.persona === 'string' ? vp.persona : '',
    traits: Array.isArray(vp && vp.traits) ? vp.traits.slice() : [],
  };
}

function traitsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Pure reason classifier. Exposed for unit tests.
 *
 * @param {{persona:string, traits:string[]}|undefined} prev
 * @param {{persona?:string, traits?:string[]}|undefined} next
 * @returns {'persona.edit'|'traits.edit'|'manual.reload'}
 */
export function classifyUpdateReason(prev, next) {
  if (!prev || !next) return 'manual.reload';
  const prevPersona = prev.persona || '';
  const nextPersona = typeof next.persona === 'string' ? next.persona : '';
  if (prevPersona !== nextPersona) return 'persona.edit';
  if (!traitsEqual(prev.traits || [], next.traits || [])) return 'traits.edit';
  return 'manual.reload';
}

/** Seed / refresh `_prevState` for a given registry. */
function captureState(registry) {
  _prevState.clear();
  for (const vp of registry.listVps()) {
    _prevState.set(vp.id, tsnap(vp));
  }
}

/**
 * onChange callback bound to the process-singleton VpLoader. Translates the
 * `{added, updated, removed}` summary into per-vpId wire events and
 * broadcasts them to every active subscriber.
 *
 * @param {{added:string[],updated:string[],removed:string[]}} summary
 * @param {import('./registry.js').Registry} registry
 */
function broadcastChange(summary, registry) {
  if (!summary || _subscribers.size === 0) {
    // Still must refresh state so a later subscriber doesn't mis-classify.
    captureState(registry);
    return;
  }

  // Removed → vp_removed
  for (const vpId of summary.removed || []) {
    const evt = { type: 'vp_removed', vpId, reason: 'file.removed' };
    _fanout(evt);
    _prevState.delete(vpId);
  }

  // Added → vp_updated (no prev state yet, so reason = 'manual.reload').
  for (const vpId of summary.added || []) {
    const vp = registry.getVp(vpId);
    if (!vp) continue;
    const evt = {
      type: 'vp_updated',
      vpId,
      vp: serializeVpForWire(vp),
      reason: 'manual.reload',
    };
    _fanout(evt);
    _prevState.set(vpId, tsnap(vp));
  }

  // Updated → classify against cached prev state.
  for (const vpId of summary.updated || []) {
    const vp = registry.getVp(vpId);
    if (!vp) continue;
    const prev = _prevState.get(vpId);
    const reason = classifyUpdateReason(prev, vp);
    const evt = {
      type: 'vp_updated',
      vpId,
      vp: serializeVpForWire(vp),
      reason,
    };
    _fanout(evt);
    _prevState.set(vpId, tsnap(vp));
  }
}

function _fanout(evt) {
  for (const fn of _subscribers) {
    try { fn(evt); } catch { /* never crash the loader from a subscriber */ }
  }
}

function ensureLoader(registry = defaultRegistry, options = {}) {
  const desiredDir = registry === defaultRegistry && typeof options.dir === 'string' && options.dir.trim()
    ? options.dir.trim()
    : null;
  if (_loaderStarted && _loaderDir === desiredDir) return { loader: _loader, fresh: false };

  if (_loader) {
    try { _loader.stop(); } catch { /* ignore */ }
  }
  _loaderStarted = true;
  _loader = null;
  _loaderDir = desiredDir;
  if (registry === defaultRegistry && registry.vpMap && typeof registry.vpMap.clear === 'function') {
    registry.vpMap.clear();
  }
  // For NON-default registries (unit tests seeding VPs manually) we MUST NOT
  // start VpLoader — its .start() scans the configured/default VP library and
  // push-imports every on-disk VP into the test registry, overwriting or
  // augmenting the fixture. Tests don't need hot-reload anyway;
  // `_broadcastChangeForTest` drives the diff path directly.
  if (registry !== defaultRegistry) {
    captureState(registry);
    return { loader: null, fresh: true };
  }
  try {
    _loader = new VpLoader({
      ...(desiredDir ? { dir: desiredDir } : {}),
      registry,
      onChange: (summary) => broadcastChange(summary, registry),
    });
    _loader.start();
    captureState(registry);
  } catch {
    // Hot-reload optional; subscribe still returns whatever scan loaded.
    _loader = null;
  }
  return { loader: _loader, fresh: true };
}

/**
 * Serialise a VP (entity layer shape) to the wire-format the web layer
 * expects (spec §2.1). Pure; no IO.
 *
 * @param {{id:string,name:string,role:string,nameZh?:string,aliases?:string[],traits?:string[],modelHint?:string,personaHash?:string}} vp
 * @returns {{vpId:string,displayName:string,displayNameZh:string,aliases:string[],subtitle:string,role:string,traits:string[],modelHint:?string,personaHash:?string,isStock:boolean}}
 */
export function serializeVpForWire(vp) {
  return {
    vpId: vp.id,
    displayName: vp.name,
    // task-fix (5-bugs): carry bilingual name + aliases (incl. pinyin) to
    // the frontend so @ mention matching + localised rendering work.
    displayNameZh: typeof vp.nameZh === 'string' ? vp.nameZh : '',
    aliases: Array.isArray(vp.aliases) ? vp.aliases.slice() : [],
    role: vp.role || '',
    subtitle: vp.role || '',
    traits: Array.isArray(vp.traits) ? vp.traits.slice() : [],
    modelHint: vp.modelHint ?? null,
    personaHash: vp.personaHash ?? null,
    // task-vp-customize: mark seed VPs so the frontend can disable
    // Edit/Delete and surface a "Stock" badge. Pure id check — see
    // stock-ids.js#STOCK_VP_IDS for the contract. `Set.has(undefined)`
    // is fine, but we still coerce to plain boolean so the wire field
    // is strictly `true | false` (never `undefined`) and downstream
    // `!!` reads can collapse cleanly.
    isStock: STOCK_VP_IDS.has(vp.id) === true,
  };
}

/**
 * Build a vp_snapshot event payload from the registry.
 * @param {import('./registry.js').Registry} [registry]
 * @returns {{type:'vp_snapshot', vps:Array, emptyLibrary:boolean}}
 */
export function buildVpSnapshot(registry = defaultRegistry) {
  const vps = registry.listVps().map(serializeVpForWire);
  return {
    type: 'vp_snapshot',
    vps,
    emptyLibrary: vps.length === 0,
  };
}

/**
 * Handle an `yeaft_vp_subscribe` request from the web client.
 *
 * Registers `sendSessionEvent` as a live-diff subscriber, emits an initial
 * `vp_snapshot`, and (on first call process-wide) starts the VpLoader
 * whose debounced rescan fans out `vp_updated` / `vp_removed` events.
 *
 * Returns an unsubscribe fn the caller MAY invoke on WS close to prevent
 * sending to a dead socket. Web-bridge is expected to manage this.
 *
 * @param {(event: object) => void} sendSessionEvent
 * @param {import('./registry.js').Registry} [registry]
 * @param {{dir?: string}} [options]
 * @returns {() => void} unsubscribe fn
 */
export function handleVpSubscribe(sendSessionEvent, registry = defaultRegistry, options = {}) {
  const { loader, fresh } = ensureLoader(registry, options);
  // task-338-F2 + task-339-followup: replay semantics.
  //
  // The loader's own start() already scans on first creation, so on a
  // `fresh` loader an additional `rescanNow()` is normally redundant.
  // HOWEVER — in production (registry === defaultRegistry) the first
  // subscribe can arrive far enough after module import that the on-disk
  // library has diverged from what the initial scan captured (e.g. a
  // platform where `fs.watch` is unreliable, or a containerized
  // bind-mount, or seedDefaultVps writing role.md files after the scan
  // but before the first subscribe). We rescan defensively on the
  // production path so the first snapshot always reflects current disk.
  //
  // For NON-default registries (unit tests that seed VPs manually), we
  // MUST skip the rescan: rescan against the configured/default VP library
  // would call registry.removeVp() for seeded ids that don't exist on disk,
  // wiping the test fixture. See vp-bridge-live-diff.test.js and
  // vp-bridge-first-subscribe-replay.test.js (test-seed preservation).
  //
  // On subsequent subscribes (page reload, reconnect, second web client)
  // rescanNow() refreshes the registry so every client gets a snapshot
  // that reflects current disk — catching the case where the FS watcher
  // missed an event or VPs were added between the initial scan and this
  // subscribe.
  const shouldRescan = (fresh && registry === defaultRegistry) || !fresh;
  if (shouldRescan && loader && typeof loader.rescanNow === 'function') {
    try { loader.rescanNow(); } catch { /* never crash subscribe on rescan */ }
  }
  _subscribers.add(sendSessionEvent);
  try {
    sendSessionEvent(buildVpSnapshot(registry));
  } catch {
    // Never crash the WS pipeline from snapshot serialisation.
  }
  return () => { _subscribers.delete(sendSessionEvent); };
}

/**
 * Test seam: reset the lazy loader + subscriber set + state cache.
 */
export function _resetVpBridgeForTest() {
  if (_loader) {
    try { _loader.stop(); } catch { /* ignore */ }
  }
  _loader = null;
  _loaderStarted = false;
  _loaderDir = null;
  _subscribers.clear();
  _prevState.clear();
}

/**
 * Test seam: manually drive broadcast (bypasses VpLoader so tests don't need
 * a real filesystem). Used by the live-diff unit test.
 */
export function _broadcastChangeForTest(summary, registry = defaultRegistry) {
  broadcastChange(summary, registry);
}

/**
 * Test seam: pre-seed `_prevState` so classifyUpdateReason has something to
 * compare against when a test drives `_broadcastChangeForTest` directly.
 */
export function _seedPrevStateForTest(registry = defaultRegistry) {
  captureState(registry);
}
