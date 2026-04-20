/**
 * vp-loader.js — Hot-reload watcher for the VP library.
 *
 * Watches `~/.yeaft/virtual-persons/` for additions, removals, and role.md
 * changes. Changes are debounced (default 500ms) and then applied:
 *
 *   - new dir with role.md  → registry.setVp(vp)
 *   - removed dir           → registry.removeVp(vpId)
 *   - role.md modified      → registry.updateVpInPlace(next)
 *     (persona fields swap; RoleInstance.runtimeState preserved — the VP
 *     object identity in registry is kept, so any RoleInstance holding
 *     `.vp` sees the new persona without being rebuilt)
 *
 * Hard constraint (a): no 334o storage import.
 */

import { watch, existsSync } from 'fs';
import { join } from 'path';
import { scanVpLibrary, loadVpFromDir, DEFAULT_VP_LIB_DIR } from './vp-store.js';

const DEFAULT_DEBOUNCE_MS = 500;

export class VpLoader {
  /**
   * @param {{ dir?: string, registry: import('./registry.js').Registry, debounceMs?: number, onChange?: (summary) => void }} options
   */
  constructor(options) {
    if (!options || !options.registry) {
      throw new Error('VpLoader requires { registry }');
    }
    this.dir = options.dir || DEFAULT_VP_LIB_DIR;
    this.registry = options.registry;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onChange = typeof options.onChange === 'function' ? options.onChange : null;

    /** @type {import('fs').FSWatcher|null} */
    this._rootWatcher = null;
    /** @type {Map<string, import('fs').FSWatcher>} */
    this._dirWatchers = new Map();
    /** @type {any} */
    this._debounceTimer = null;
    this._started = false;
  }

  /** Initial scan + install watchers. Returns the initial VP list. */
  start() {
    if (this._started) return this.registry.listVps();
    this._started = true;

    const vps = scanVpLibrary({ dir: this.dir });
    for (const vp of vps) this.registry.setVp(vp);

    if (existsSync(this.dir)) {
      this._installRootWatcher();
      for (const vp of vps) this._installDirWatcher(vp.dir);
    }
    return vps;
  }

  /** Stop watchers and clear timers. Safe to call multiple times. */
  stop() {
    this._started = false;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._rootWatcher) {
      try { this._rootWatcher.close(); } catch { /* ignore */ }
      this._rootWatcher = null;
    }
    for (const w of this._dirWatchers.values()) {
      try { w.close(); } catch { /* ignore */ }
    }
    this._dirWatchers.clear();
  }

  _installRootWatcher() {
    try {
      this._rootWatcher = watch(this.dir, { persistent: false }, () => {
        this._scheduleRescan();
      });
    } catch {
      // watch may fail on some FS; hot-reload degrades to no-op
    }
  }

  _installDirWatcher(dir) {
    if (this._dirWatchers.has(dir)) return;
    try {
      const w = watch(dir, { persistent: false }, () => {
        this._scheduleRescan();
      });
      this._dirWatchers.set(dir, w);
    } catch {
      // ignore
    }
  }

  _scheduleRescan() {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      try {
        this._rescan();
      } catch {
        // never crash the loader from a rescan error
      }
    }, this.debounceMs);
  }

  /**
   * Force an immediate rescan (bypass debounce). Useful for tests.
   * @returns {{ added: string[], removed: string[], updated: string[] }}
   */
  rescanNow() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    return this._rescan();
  }

  _rescan() {
    const fresh = scanVpLibrary({ dir: this.dir });
    const freshById = new Map(fresh.map(v => [v.id, v]));
    const oldById = new Map(this.registry.listVps().map(v => [v.id, v]));

    const added = [];
    const removed = [];
    const updated = [];

    // Added / updated
    for (const [id, next] of freshById) {
      const prev = oldById.get(id);
      if (!prev) {
        this.registry.setVp(next);
        this._installDirWatcher(next.dir);
        added.push(id);
      } else if (
        prev.mtimeMs !== next.mtimeMs ||
        prev.persona !== next.persona ||
        prev.name !== next.name ||
        prev.role !== next.role
      ) {
        // In-place update preserves VP identity → RoleInstance.runtimeState
        // is untouched; persona swap propagates on next read of vp.persona.
        this.registry.updateVpInPlace(next);
        updated.push(id);
      }
    }

    // Removed
    for (const [id, prev] of oldById) {
      if (!freshById.has(id)) {
        this.registry.removeVp(id);
        const w = this._dirWatchers.get(prev.dir);
        if (w) {
          try { w.close(); } catch { /* ignore */ }
          this._dirWatchers.delete(prev.dir);
        }
        removed.push(id);
      }
    }

    const summary = { added, removed, updated };
    if ((added.length || removed.length || updated.length) && this.onChange) {
      try { this.onChange(summary); } catch { /* ignore */ }
    }
    return summary;
  }
}

export { DEFAULT_VP_LIB_DIR };
