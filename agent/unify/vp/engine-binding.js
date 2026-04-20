/**
 * engine-binding.js — bind a single Engine instance to a VP.
 *
 * Per §5.1, Engine is a stateless library: `engine.query({prompt, messages,
 * signal, ...})`. Per §5.2, each RoleInstance runs ITS VP's Engine. We keep
 * one Engine per (vpId) — NOT per RoleInstance — because the Engine itself
 * holds no conversation state; messages live on the RoleInstance. Sharing
 * across groups for the same VP is correct and avoids adapter duplication.
 *
 * When a VP is hot-reloaded (persona body changed → personaHash changed),
 * the cached Engine is still valid — the persona is injected via system
 * prompt, not Engine constructor. We keep the cache stable unless the
 * caller passes a new adapter (e.g. modelHint switched).
 *
 * Hard constraint: 334c does NOT import ../engine.js directly, because
 * that pulls in adapter/config/tool machinery that's owned by the caller
 * (web-bridge / eval runner). Instead this module takes a factory:
 *
 *   createEngine(vp) → Engine
 *
 * which the caller supplies when they wire up a Registry.
 */

const DEFAULT_SCOPE = Symbol.for('yeaft.334c.default-engine-scope');

/**
 * Build an engine binder. Stateless helper — state lives on the registry-
 * like cache the caller provides (defaults to an internal WeakMap-style).
 *
 * @param {{
 *   createEngine: (vp: import('./vp-store.js').VP) => object,
 *   cache?: Map<string, object>,        // vpId → Engine
 * }} deps
 */
export function createEngineBinder({ createEngine, cache } = {}) {
  if (typeof createEngine !== 'function') {
    throw new Error('createEngineBinder: createEngine(vp) factory is required');
  }
  const store = cache instanceof Map ? cache : new Map();
  // Track personaHash at bind time so the caller can decide whether a
  // later hot-reload warrants re-binding (MVP: we just stash it; engine
  // itself is persona-agnostic).
  const meta = new Map(); // vpId → { personaHash, modelHint }

  return {
    /**
     * Resolve (or lazily create) the Engine for a RoleInstance's VP and
     * attach it onto `ri.engine`. Idempotent.
     *
     * @param {import('./role-instance.js').RoleInstance} ri
     * @returns {object} Engine
     */
    bind(ri) {
      if (!ri || !ri.vp) throw new Error('bind: role instance required');
      const vp = ri.vp;
      let engine = store.get(vp.id);
      if (!engine) {
        engine = createEngine(vp);
        if (!engine || typeof engine.query !== 'function') {
          throw new Error(`bind: createEngine(${vp.id}) did not return an Engine-like object (missing query)`);
        }
        store.set(vp.id, engine);
        meta.set(vp.id, { personaHash: vp.personaHash, modelHint: vp.modelHint });
      }
      ri.engine = engine;
      return engine;
    },

    /**
     * Mark a VP as "needs re-bind" — drop the cache entry. The next bind()
     * call will invoke createEngine again. Useful when the caller knows
     * the adapter or tool inventory has changed.
     */
    invalidate(vpId) {
      const engine = store.get(vpId);
      store.delete(vpId);
      meta.delete(vpId);
      // Best-effort: if the engine exposed a dispose, call it.
      if (engine && typeof engine.dispose === 'function') {
        try { engine.dispose(); } catch { /* ignore */ }
      }
    },

    /** Drop every cached engine (e.g. on session teardown). */
    clear() {
      for (const vpId of Array.from(store.keys())) this.invalidate(vpId);
    },

    /** Diagnostics. */
    size() { return store.size; },
    has(vpId) { return store.has(vpId); },
    getMeta(vpId) { return meta.get(vpId) || null; },
  };

  void DEFAULT_SCOPE; // reserved for cross-module sharing; not used in MVP
}
