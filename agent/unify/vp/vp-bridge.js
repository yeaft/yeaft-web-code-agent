/**
 * vp-bridge.js — task-334-ui-a snapshot-only WS adapter.
 *
 * Per ruling .crew/context/task-334-ui-a-ruling.md §3 (D3 = mixed):
 *   • snapshot path lives here (this slice, in-scope)
 *   • live diff (vp_updated / vp_removed) deferred to 334h — see TODO below
 *
 * This module is the SOLE serialiser for the wire-format VP shape.
 * Per ruling §1 (D1 = (b) web-bridge boundary rename), the entity layer
 * (`vp-store.js` / `registry.js`) keeps `id` / `name`; here we map to
 * `vpId` / `displayName` per the spec (§2.1) / architecture §R6.11.
 *
 * Per ruling §2 (D2):
 *   • subtitle  → agent emits `vp.role` directly
 *   • personaHash → agent emits `vp.personaHash` (added by dev-1's
 *     334a-followup patch). Until that lands, this serialiser falls back
 *     to undefined and the web layer simply omits the field.
 *   • color / avatar → web-derived, NOT emitted here
 */

import { defaultRegistry } from './registry.js';
import { VpLoader } from './vp-loader.js';

/** Process-singleton VpLoader; lazily started on first subscribe. */
let _loaderStarted = false;
let _loader = null;

function ensureLoader() {
  if (_loaderStarted) return _loader;
  _loaderStarted = true;
  try {
    _loader = new VpLoader({ registry: defaultRegistry });
    _loader.start();
  } catch {
    // Hot-reload optional; subscribe still returns whatever scan loaded.
    _loader = null;
  }
  return _loader;
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
 * Lazily starts the VpLoader on first call (debounced rescan watchers).
 *
 * @param {(event: object) => void} sendUnifyEvent — emit fn (web-bridge wires this)
 * @param {import('./registry.js').Registry} [registry]
 */
export function handleVpSubscribe(sendUnifyEvent, registry = defaultRegistry) {
  ensureLoader();
  try {
    sendUnifyEvent(buildVpSnapshot(registry));
  } catch {
    // Never crash the WS pipeline from snapshot serialisation.
  }
  // TODO(334h): vp_updated / vp_removed live broadcast.
  // Wire VpLoader.onChange → emit per-vp `vp_updated` and `vp_removed`
  // events using serializeVpForWire(). Out of scope for 334-ui-a.
}

/**
 * Test seam: reset the lazy loader (for vitest).
 */
export function _resetVpBridgeForTest() {
  if (_loader) {
    try { _loader.stop(); } catch { /* ignore */ }
  }
  _loader = null;
  _loaderStarted = false;
}
