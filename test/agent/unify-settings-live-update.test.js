/**
 * unify-settings-live-update.test.js — task-318 rev-1 fix.
 *
 * Integration test proving the IPC → ctx.unifyRuntimeSettings → setter
 * chain actually pushes new caps into the LIVE registry + thread store.
 * Previous tests only covered the mock layer; this one wires the real
 * `installUnifyRuntimeBridge`, a real ThreadEngineRegistry, and a real
 * ThreadStore — and asserts that calling message-router's
 * `update_unify_settings` branch mutates them in place.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installUnifyRuntimeBridge } from '../../agent/unify/web-bridge.js';
import { ThreadEngineRegistry } from '../../agent/unify/threads/engine-registry.js';
import { ThreadStore, _resetThreadStoreForTests } from '../../agent/unify/threads/store.js';
import ctx from '../../agent/context.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-live-update-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function stubFactory() {
  return (threadId) => {
    const inst = {
      threadId,
      terminated: false,
      query: async function* () { /* no-op */ },
      terminate() { inst.terminated = true; },
    };
    return inst;
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  _resetThreadStoreForTests();
  ctx.unifyRuntimeSettings = null;
});

afterEach(() => {
  _resetThreadStoreForTests();
  ctx.unifyRuntimeSettings = null;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('installUnifyRuntimeBridge — IPC→setter live path (task-318 rev-1)', () => {
  it('populates ctx.unifyRuntimeSettings (previously null)', () => {
    const registry = new ThreadEngineRegistry({ factory: stubFactory(), maxConcurrent: 6 });
    const threadStore = new ThreadStore(TEST_DIR, { idleArchiveDays: 30 });
    installUnifyRuntimeBridge({ engineRegistry: registry, threadStore });

    expect(ctx.unifyRuntimeSettings).not.toBeNull();
    expect(ctx.unifyRuntimeSettings.maxConcurrentThreads).toBe(6);
    expect(ctx.unifyRuntimeSettings.autoArchiveIdleDays).toBe(30);
  });

  it('assigning maxConcurrentThreads pushes through to the live registry', () => {
    const registry = new ThreadEngineRegistry({ factory: stubFactory(), maxConcurrent: 2 });
    const threadStore = new ThreadStore(TEST_DIR, { idleArchiveDays: 30 });
    installUnifyRuntimeBridge({ engineRegistry: registry, threadStore });

    // Simulate the message-router branch (mutating the bridged object).
    ctx.unifyRuntimeSettings.maxConcurrentThreads = 10;

    // The LIVE registry now reflects the new cap — no reload.
    expect(registry.maxConcurrent).toBe(10);
    // And dispatch behavior actually follows:
    for (let i = 0; i < 10; i++) registry.ensure(`thr-${i}`);
    expect(registry.listActive().length).toBe(10);
    expect(() => registry.ensure('thr-over')).toThrow(/limit reached/);
  });

  it('assigning autoArchiveIdleDays pushes through to the live ThreadStore', () => {
    const registry = new ThreadEngineRegistry({ factory: stubFactory(), maxConcurrent: 6 });
    const threadStore = new ThreadStore(TEST_DIR, { idleArchiveDays: 30 });
    installUnifyRuntimeBridge({ engineRegistry: registry, threadStore });

    ctx.unifyRuntimeSettings.autoArchiveIdleDays = 7;

    expect(threadStore.idleArchiveDays).toBe(7);
  });

  it('message-router update path mutates registry + store end-to-end', async () => {
    // This mirrors what message-router does on `update_unify_settings`.
    // We import the router directly and wire a fake sendToServer.
    const registry = new ThreadEngineRegistry({ factory: stubFactory(), maxConcurrent: 3 });
    const threadStore = new ThreadStore(TEST_DIR, { idleArchiveDays: 30 });
    installUnifyRuntimeBridge({ engineRegistry: registry, threadStore });

    // Mock ctx.CONFIG.yeaftDir so config-api writes land in TEST_DIR.
    const prevConfig = ctx.CONFIG;
    ctx.CONFIG = { yeaftDir: TEST_DIR };

    // Intercept sendToServer via the buffer module
    const bufferMod = await import('../../agent/connection/buffer.js');
    const sendSpy = vi.spyOn(bufferMod, 'sendToServer').mockImplementation(() => {});

    try {
      const { handleMessage } = await import('../../agent/connection/message-router.js');
      await handleMessage({
        type: 'update_unify_settings',
        settings: { maxConcurrentThreads: 8, autoArchiveIdleDays: 14 },
      });

      // Assert the LIVE runtime reflects the change (NOT just the file).
      expect(registry.maxConcurrent).toBe(8);
      expect(threadStore.idleArchiveDays).toBe(14);

      // And the broadcast was sent.
      const broadcast = sendSpy.mock.calls.find(c => c[0]?.type === 'unify_settings_updated');
      expect(broadcast).toBeDefined();
      expect(broadcast[0].maxConcurrentThreads).toBe(8);
      expect(broadcast[0].autoArchiveIdleDays).toBe(14);
    } finally {
      sendSpy.mockRestore();
      ctx.CONFIG = prevConfig;
    }
  });
});
