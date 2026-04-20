/**
 * registry.js — In-memory VP + RoleInstance registry.
 *
 * Two maps:
 *   - vpMap:           vpId → VP
 *   - instanceMap:     "<groupId>::<vpId>" → RoleInstance
 *
 * RoleInstance creation is idempotent: `getOrCreateRoleInstance(vpId, groupId)`
 * returns the same instance for the same (vpId, groupId) pair.
 *
 * LRU eviction (per acceptance #3): when active instance count exceeds
 * `softLimit.maxActiveRoleInstances` (default 40), the least-recently-used
 * idle instance is evicted. Instances with `state !== 'idle'` are skipped
 * over during eviction; if no idle candidate exists, the new instance is
 * still created (soft limit — we do not hard-reject).
 */

import { RoleInstance } from './role-instance.js';

const DEFAULT_MAX_ACTIVE_ROLE_INSTANCES = 40;

export class Registry {
  constructor(options = {}) {
    /** @type {Map<string, import('./vp-store.js').VP>} */
    this.vpMap = new Map();
    /** @type {Map<string, RoleInstance>} */
    this.instanceMap = new Map();
    this.softLimit = {
      maxActiveRoleInstances: options.maxActiveRoleInstances ?? DEFAULT_MAX_ACTIVE_ROLE_INSTANCES,
    };
    /** Listeners for eviction / persona-refresh (optional). */
    this._evictListeners = new Set();
  }

  // ─── VP map ────────────────────────────────────────────────────

  setVp(vp) {
    if (!vp || !vp.id) return;
    this.vpMap.set(vp.id, vp);
  }

  /**
   * Replace a VP's persona fields in-place, preserving identity so any
   * RoleInstance with `.vp === vp` keeps its reference stable across
   * hot-reload. Fields copied: name, role, traits, modelHint, persona,
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
    // task-334c: personaHash must track persona body. 334a-followup added
    // the field; this is the in-place update mirror. (Originally recorded
    // as a 334h nit, but 334c's system-prompt block names the hash in
    // STATIC — carrying a stale hash would bleed into the prompt.)
    cur.personaHash = next.personaHash;
    cur.mtimeMs = next.mtimeMs;
    // dir / memoryDir / id stable
    return cur;
  }

  removeVp(vpId) {
    this.vpMap.delete(vpId);
    // Also drop any RoleInstances bound to a vanished VP.
    for (const [key, ri] of this.instanceMap) {
      if (ri.vpId === vpId) {
        this.instanceMap.delete(key);
      }
    }
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

  // ─── RoleInstance map ─────────────────────────────────────────

  _key(groupId, vpId) {
    return `${groupId}::${vpId}`;
  }

  /**
   * Idempotent create: same (vpId, groupId) returns same instance.
   * Triggers LRU eviction when the soft limit is exceeded.
   *
   * @param {string} vpId
   * @param {string} groupId
   * @returns {RoleInstance}
   */
  getOrCreateRoleInstance(vpId, groupId) {
    const vp = this.vpMap.get(vpId);
    if (!vp) throw new Error(`unknown vpId: ${vpId}`);

    const key = this._key(groupId, vpId);
    const existing = this.instanceMap.get(key);
    if (existing) {
      existing.touch();
      return existing;
    }

    const ri = new RoleInstance({ vp, groupId });
    this.instanceMap.set(key, ri);
    this._maybeEvict(ri);
    return ri;
  }

  getRoleInstance(vpId, groupId) {
    return this.instanceMap.get(this._key(groupId, vpId));
  }

  dropRoleInstance(vpId, groupId) {
    const key = this._key(groupId, vpId);
    const ri = this.instanceMap.get(key);
    if (!ri) return false;
    this.instanceMap.delete(key);
    return true;
  }

  activeRoleInstanceCount() {
    return this.instanceMap.size;
  }

  listRoleInstances() {
    return Array.from(this.instanceMap.values());
  }

  onEvict(listener) {
    this._evictListeners.add(listener);
    return () => this._evictListeners.delete(listener);
  }

  _maybeEvict(exclude) {
    const limit = this.softLimit.maxActiveRoleInstances;
    if (this.instanceMap.size <= limit) return;

    // Collect idle instances (excluding the just-created one), sort by
    // lastActivityAt ascending.
    const idle = [];
    for (const ri of this.instanceMap.values()) {
      if (ri === exclude) continue;
      if (ri.state === 'idle') idle.push(ri);
    }
    idle.sort((a, b) => a.lastActivityAt - b.lastActivityAt);

    while (this.instanceMap.size > limit && idle.length > 0) {
      const victim = idle.shift();
      const key = this._key(victim.groupId, victim.vpId);
      this.instanceMap.delete(key);
      for (const l of this._evictListeners) {
        try { l(victim); } catch { /* ignore */ }
      }
    }
    // If still over limit because no idle candidates exist, we accept the
    // soft-limit breach — per spec, softLimit is a target, not a hard cap.
  }
}

/** Module-level default registry (convenience). */
export const defaultRegistry = new Registry();
