/**
 * registry.js — In-memory VP registry.
 *
 * Holds the process-wide VP map (vpId → VP). VpLoader writes to it on
 * startup + filesystem rescans; vp-bridge.js reads it to serve the
 * `vp_snapshot` and live-diff WS events.
 *
 * The previous RoleInstance map (per (vpId, groupId) pair, with LRU
 * eviction) was removed in GC.2 — production fans out per-VP via
 * `handleUnifyChat` directly and never instantiated RoleInstance.
 */

export class Registry {
  constructor() {
    /** @type {Map<string, import('./vp-store.js').VP>} */
    this.vpMap = new Map();
  }

  // ─── VP map ────────────────────────────────────────────────────

  setVp(vp) {
    if (!vp || !vp.id) return;
    this.vpMap.set(vp.id, vp);
  }

  /**
   * Replace a VP's persona fields in-place, preserving identity so any
   * downstream reference keeps its handle stable across hot-reload.
   * Fields copied: name, role, traits, modelHint, persona, personaHash,
   * mtimeMs.
   */
  updateVpInPlace(next) {
    const cur = this.vpMap.get(next.id);
    if (!cur) {
      this.setVp(next);
      return next;
    }
    cur.name = next.name;
    cur.role = next.role;
    cur.traits = next.traits;
    cur.modelHint = next.modelHint;
    cur.persona = next.persona;
    cur.personaHash = next.personaHash;
    cur.mtimeMs = next.mtimeMs;
    // dir / memoryDir / id stable
    return cur;
  }

  removeVp(vpId) {
    this.vpMap.delete(vpId);
  }

  getVp(vpId) {
    return this.vpMap.get(vpId);
  }

  listVps() {
    return Array.from(this.vpMap.values());
  }

  vpCount() {
    return this.vpMap.size;
  }
}

/** Module-level default registry (convenience). */
export const defaultRegistry = new Registry();
