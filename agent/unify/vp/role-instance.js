/**
 * role-instance.js — RoleInstance class (per-group per-VP runtime handle).
 *
 * Per task-334 architecture §5: an Engine run targets one RoleInstance.
 * This slice (334a) defines the object shape + basic lifecycle; the actual
 * engine.run(roleInstance, opts) integration lives in 334c. Downstream
 * stores (threadStore / subagentPool / memoryStore) are lazily attached by
 * their respective slices — 334a only reserves the slots.
 *
 * Hard constraint (a) from slice spec: do NOT import 334o shard-store.
 * `memoryStore` is a nullable placeholder here.
 */

/**
 * @typedef {'idle'|'running'|'queued'|'error'} RoleInstanceState
 */

let _seq = 0;
function nextInstanceId(vpId, groupId) {
  _seq = (_seq + 1) >>> 0;
  return `ri_${groupId}_${vpId}_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

export class RoleInstance {
  /**
   * @param {{ vp: import('./vp-store.js').VP, groupId: string }} params
   */
  constructor({ vp, groupId }) {
    if (!vp) throw new Error('RoleInstance requires a vp');
    if (!groupId) throw new Error('RoleInstance requires a groupId');

    this.id = nextInstanceId(vp.id, groupId);
    this.vpId = vp.id;
    this.groupId = groupId;
    /** Live VP reference. Persona hot-reload mutates fields in place. */
    this.vp = vp;

    // ── Runtime state (preserved across persona hot-reload) ─────
    /** @type {RoleInstanceState} */
    this.state = 'idle';
    /** Conversation messages appended by 334c. */
    this.messages = [];
    /** Pending input queue (334d). */
    this.inputQueue = [];
    /** Abort controller for in-flight engine.run (334c). */
    this.abortController = null;

    // ── Nullable sub-system handles (attached by later slices) ──
    /** threadStore — 334h/334c bootstraps. */
    this.threadStore = null;
    /** subagentPool — 334c. */
    this.subagentPool = null;
    /** memoryStore — 334f wraps 334o; NOT created here. */
    this.memoryStore = null;

    // ── Telemetry ───────────────────────────────────────────────
    this.createdAt = Date.now();
    this.lastActivityAt = this.createdAt;
  }

  /** Update last-activity timestamp (used by LRU eviction). */
  touch() {
    this.lastActivityAt = Date.now();
  }

  /** Transition helper. */
  setState(next) {
    this.state = next;
    this.touch();
  }

  /**
   * Snapshot for debug / telemetry. Excludes bulky messages.
   */
  snapshot() {
    return {
      id: this.id,
      vpId: this.vpId,
      groupId: this.groupId,
      state: this.state,
      messageCount: this.messages.length,
      queueDepth: this.inputQueue.length,
      lastActivityAt: this.lastActivityAt,
      createdAt: this.createdAt,
    };
  }
}
