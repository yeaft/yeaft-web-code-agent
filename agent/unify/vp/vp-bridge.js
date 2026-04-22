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
 *   • subscribers (Set of sendUnifyEvent fns) receive per-vp `vp_updated`
 *     and `vp_removed` events as VpLoader's debounced rescan commits
 *     added / updated / removed vpIds.
 *   • Event shape: `{ type, vpId, vp?, reason? }` where `reason` ∈
 *     { 'persona.edit', 'traits.edit', 'manual.reload', 'file.removed' }.
 *   • Back-compat: `vp_snapshot` shape unchanged; `reason` is purely
 *     additive so older web clients ignore it.
 */

import { defaultRegistry } from './registry.js';
import { VpLoader } from './vp-loader.js';

/** Process-singleton VpLoader; lazily started on first subscribe. */
let _loaderStarted = false;
let _loader = null;

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

function ensureLoader(registry = defaultRegistry) {
  if (_loaderStarted) return { loader: _loader, fresh: false };
  _loaderStarted = true;
  try {
    _loader = new VpLoader({
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
 * @param {{id:string,name:string,role:string,traits?:string[],modelHint?:string,personaHash?:string}} vp
 * @returns {{vpId:string,displayName:string,subtitle:string,role:string,traits:string[],modelHint:?string,personaHash:?string}}
 */
export function serializeVpForWire(vp) {
  return {
    vpId: vp.id,
    displayName: vp.name,
    role: vp.role || '',
    subtitle: vp.role || '',
    traits: Array.isArray(vp.traits) ? vp.traits.slice() : [],
    modelHint: vp.modelHint ?? null,
    personaHash: vp.personaHash ?? null,
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
 * Handle an `unify_vp_subscribe` request from the web client.
 *
 * Registers `sendUnifyEvent` as a live-diff subscriber, emits an initial
 * `vp_snapshot`, and (on first call process-wide) starts the VpLoader
 * whose debounced rescan fans out `vp_updated` / `vp_removed` events.
 *
 * Returns an unsubscribe fn the caller MAY invoke on WS close to prevent
 * sending to a dead socket. Web-bridge is expected to manage this.
 *
 * @param {(event: object) => void} sendUnifyEvent
 * @param {import('./registry.js').Registry} [registry]
 * @returns {() => void} unsubscribe fn
 */
export function handleVpSubscribe(sendUnifyEvent, registry = defaultRegistry) {
  const { loader, fresh } = ensureLoader(registry);
  // task-338-F2: replay semantics. The loader's own start() already scans
  // on first creation, so on a `fresh` loader we skip the extra rescan (it
  // would be redundant work and, more importantly, tests that seed the
  // registry BEFORE subscribing would see their seeded entries wiped by
  // a rescan against an unrelated DEFAULT_VP_LIB_DIR). On subsequent
  // subscribes (page reload, reconnect, second web client), rescanNow()
  // refreshes the registry so every client gets a snapshot that reflects
  // current disk — catching the case where the FS watcher missed an
  // event or VPs were added between the initial scan and this subscribe.
  if (!fresh && loader && typeof loader.rescanNow === 'function') {
    try { loader.rescanNow(); } catch { /* never crash subscribe on rescan */ }
  }
  _subscribers.add(sendUnifyEvent);
  try {
    sendUnifyEvent(buildVpSnapshot(registry));
  } catch {
    // Never crash the WS pipeline from snapshot serialisation.
  }
  return () => { _subscribers.delete(sendUnifyEvent); };
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
