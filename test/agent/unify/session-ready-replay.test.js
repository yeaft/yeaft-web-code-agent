/**
 * task-322: handleUnifyLoadHistory must replay session_ready +
 * thread_list_updated on every invocation, not only on lazy-init.
 *
 * The module-level `session` singleton is kept across page refreshes by
 * the agent process. The frontend's `enterUnify()` is idempotent (resets
 * `unifyModel`, `unifyThreads`, `unifySessionReady` every time), so the
 * agent side must re-emit the handshake + sidebar snapshot every time
 * the frontend asks for history — otherwise the UI is stranded on the
 * model-placeholder + empty sidebar + empty main pane.
 *
 * Frontend idempotency: the `session_ready` handler either migrates a
 * local placeholder convId to the agent's id (first time) or just
 * refreshes model/status fields (repeat). Receiving it twice is a
 * no-op on state invariants.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const WEB_BRIDGE_PATH = join(
  import.meta.dirname, '..', '..', '..', 'agent', 'unify', 'web-bridge.js'
);

// ─── Structural ───────────────────────────────────────────────────

describe('task-322 structural: session_ready replay', () => {
  const src = readFileSync(WEB_BRIDGE_PATH, 'utf8');

  it('emits session_ready OUTSIDE the `if (!session)` lazy-init block', () => {
    // Find the handleUnifyLoadHistory function body, then locate the
    // `if (!session) { ... }` block and assert session_ready lives AFTER
    // the closing brace of that block.
    const fnStart = src.indexOf('async function handleUnifyLoadHistory');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, fnStart + 4000);

    // The session_ready emission should NOT be inside the lazy-init branch.
    // Strategy: find the closing `}` of `if (!session) {`, then assert
    // `type: 'session_ready'` occurs AFTER it.
    const ifIdx = fnBody.indexOf('if (!session) {');
    expect(ifIdx).toBeGreaterThan(-1);
    // Walk to find the matching close brace for this if-block.
    let depth = 0;
    let closeIdx = -1;
    for (let i = ifIdx + 'if (!session) {'.length - 1; i < fnBody.length; i++) {
      const ch = fnBody[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { closeIdx = i; break; }
      }
    }
    expect(closeIdx).toBeGreaterThan(-1);

    const sessionReadyIdx = fnBody.indexOf("type: 'session_ready'");
    expect(sessionReadyIdx).toBeGreaterThan(closeIdx);
  });

  it('emits sendThreadListUpdate OUTSIDE the lazy-init block too', () => {
    const fnStart = src.indexOf('async function handleUnifyLoadHistory');
    const fnBody = src.slice(fnStart, fnStart + 4000);
    const ifIdx = fnBody.indexOf('if (!session) {');
    let depth = 0; let closeIdx = -1;
    for (let i = ifIdx + 'if (!session) {'.length - 1; i < fnBody.length; i++) {
      const ch = fnBody[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
    }
    expect(closeIdx).toBeGreaterThan(-1);
    const sendListIdx = fnBody.indexOf('sendThreadListUpdate()', closeIdx);
    expect(sendListIdx).toBeGreaterThan(closeIdx);
  });

  it('still runs loadSession + lazy restore when session is null (first entry)', () => {
    const fnStart = src.indexOf('async function handleUnifyLoadHistory');
    const fnBody = src.slice(fnStart, fnStart + 4000);
    const ifIdx = fnBody.indexOf('if (!session) {');
    // Inside that block: loadSession + restore helper still present
    // (task-fix three-bugs routed the per-thread restore through
    // `restoreThreadHistoryFromRecent`; that helper still clears + repopulates
    // messagesByThread so the init invariant holds).
    const blockEnd = fnBody.indexOf('// task-322', ifIdx);
    expect(blockEnd).toBeGreaterThan(ifIdx);
    const block = fnBody.slice(ifIdx, blockEnd);
    expect(block).toContain('loadSession(');
    expect(block).toContain('restoreThreadHistoryFromRecent');
  });
});

// ─── Behavioral: drive handleUnifyLoadHistory twice ──────────────────

describe('task-322 behavioral: session_ready replay on every call', () => {
  let sentMessages;
  let origSendToServer;
  let bufferMod;

  beforeEach(async () => {
    sentMessages = [];
    // Intercept sendToServer by replacing on the imported module.
    bufferMod = await import('../../../agent/connection/buffer.js');
    origSendToServer = bufferMod.sendToServer;
    // Module exports are bindings — assign via a spy to the module namespace.
    vi.spyOn(bufferMod, 'sendToServer').mockImplementation((m) => sentMessages.push(m));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits session_ready + thread_list_updated BOTH on first entry AND on re-entry', async () => {
    // Fresh module state per test — reset the module registry so the
    // bridge's module-level `session` singleton starts null.
    vi.resetModules();

    // Install a mock session by short-circuiting loadSession. The bridge
    // calls `session = await loadSession(...)` on first entry; to avoid
    // the real heavy init (MCP + skills + fs), we stub loadSession via
    // the `./session.js` module namespace and feed it a mock.
    const sessionMod = await import('../../../agent/unify/session.js');
    const mockSession = {
      config: { model: 'mock-model', availableModels: [{ id: 'mock-model', label: 'Mock' }] },
      status: { skills: ['s'], mcpServers: ['m'], tools: ['t'] },
      conversationStore: {
        loadRecent: () => [],
        readCompactSummary: () => null,
        countHot: () => 0,
        countCold: () => 0,
      },
      engineRegistry: { maxConcurrent: 1, setMaxConcurrent() {} },
      threadStore: {
        idleArchiveDays: 0,
        setIdleArchiveDays() {},
        runArchivePass: () => ({ archived: [] }),
        list: () => [{
          id: 'main', name: 'main', goal: '', parentThreadId: null,
          status: 'active', archived: false, messageCount: 0,
          lastMessageAt: null, lastActivityAt: null, unread: 0,
          preview: '', createdAt: 0, updatedAt: 0,
        }],
        currentId: 'main',
        attachedTask: () => null,
      },
      shutdown: async () => {},
    };
    vi.spyOn(sessionMod, 'loadSession').mockResolvedValue(mockSession);

    // Re-spy on sendToServer after module reset so the fresh bridge sees
    // the spy (module bindings are reset by vi.resetModules).
    const freshBuffer = await import('../../../agent/connection/buffer.js');
    vi.spyOn(freshBuffer, 'sendToServer').mockImplementation((m) => sentMessages.push(m));

    // Import the bridge AFTER the mocks are installed — the bridge will
    // resolve the mocked loadSession binding on its first call.
    const bridge = await import('../../../agent/unify/web-bridge.js');

    // ─── First entry (session null → lazy-init + emit) ──
    await bridge.handleUnifyLoadHistory({ limit: 50 });

    const firstSessionReady = sentMessages.filter(m =>
      m?.event?.type === 'session_ready'
    );
    const firstThreadList = sentMessages.filter(m =>
      m?.event?.type === 'thread_list_updated'
    );
    expect(firstSessionReady).toHaveLength(1);
    expect(firstThreadList).toHaveLength(1);
    expect(firstSessionReady[0].event.model).toBe('mock-model');
    expect(firstThreadList[0].event.threads.length).toBeGreaterThan(0);

    // ─── Second entry (session already set → MUST still re-emit) ──
    const before = sentMessages.length;
    await bridge.handleUnifyLoadHistory({ limit: 50 });

    const afterMessages = sentMessages.slice(before);
    const secondSessionReady = afterMessages.filter(m =>
      m?.event?.type === 'session_ready'
    );
    const secondThreadList = afterMessages.filter(m =>
      m?.event?.type === 'thread_list_updated'
    );
    // THIS is the crux of task-322 — previously ZERO, now MUST be 1.
    expect(secondSessionReady).toHaveLength(1);
    expect(secondThreadList).toHaveLength(1);
    expect(secondSessionReady[0].event.model).toBe('mock-model');

    // Idempotency: both emissions carry the same model + conversationId
    // (so the frontend's migrator is a no-op on the second hit).
    expect(secondSessionReady[0].event.conversationId)
      .toBe(firstSessionReady[0].event.conversationId);
    expect(secondSessionReady[0].event.model)
      .toBe(firstSessionReady[0].event.model);
  });
});
