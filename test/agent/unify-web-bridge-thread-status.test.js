/**
 * unify-web-bridge-thread-status.test.js — task-325b
 *
 * Source-level assertions on agent/unify/web-bridge.js:
 *   1. `thread_status` translation layer exists and maps the four
 *      engine lifecycle events onto the four UI states.
 *   2. `thread_list_snapshot` is a distinct payload (not just
 *      `thread_list_updated`) and carries `serverTime` + per-thread
 *      `state` resolved from the engine registry's inflight set.
 *   3. Snapshot is pushed in session_ready, load_history, and
 *      resetUnifySession paths — so every reconnect / refresh can
 *      rebuild the Working Status panel without missing an event.
 *   4. The bridge does NOT mutate engine state while observing
 *      (red line from PM — 325a range).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '..', '..');
const bridgeSrc = readFileSync(join(root, 'agent/unify/web-bridge.js'), 'utf8');

describe('web-bridge Working Status events (task-325b)', () => {
  describe('thread_status translation', () => {
    it('defines engineEventToState with all four lifecycle mappings', () => {
      expect(bridgeSrc).toMatch(/function engineEventToState/);
      expect(bridgeSrc).toMatch(/'thread_started'[^}]*'running'/);
      expect(bridgeSrc).toMatch(/'thread_completed'[^}]*'idle'/);
      expect(bridgeSrc).toMatch(/'thread_aborted'[^}]*'aborted'/);
      expect(bridgeSrc).toMatch(/'thread_error'[^}]*'error'/);
    });

    it('emitThreadStatusFromEngineEvent builds a thread_status payload', () => {
      expect(bridgeSrc).toMatch(/function emitThreadStatusFromEngineEvent/);
      // Must emit type === 'thread_status', not the raw engine event type.
      expect(bridgeSrc).toMatch(/type:\s*'thread_status'/);
    });

    it('thread_status carries threadId + state plus optional metadata', () => {
      const fn = bridgeSrc.match(/function emitThreadStatusFromEngineEvent\b[\s\S]*?^}/m)?.[0] || '';
      expect(fn).toMatch(/threadId/);
      expect(fn).toMatch(/state/);
      // Optional fields are passed through when present.
      expect(fn).toMatch(/startedAt/);
      expect(fn).toMatch(/completedAt/);
      expect(fn).toMatch(/toolName/);
      expect(fn).toMatch(/reason/);
    });

    it('handleEngineEvent short-circuits lifecycle events into thread_status', () => {
      const fn = bridgeSrc.match(/function handleEngineEvent\b[\s\S]*?^}/m)?.[0] || '';
      expect(fn).toMatch(/thread_started/);
      expect(fn).toMatch(/thread_completed/);
      expect(fn).toMatch(/thread_aborted/);
      expect(fn).toMatch(/emitThreadStatusFromEngineEvent/);
      // The lifecycle branch returns BEFORE the main switch so those
      // events aren't double-handled.
      const emitIdx   = fn.indexOf('emitThreadStatusFromEngineEvent');
      const switchIdx = fn.indexOf('switch (event.type)');
      expect(emitIdx).toBeGreaterThan(-1);
      expect(switchIdx).toBeGreaterThan(-1);
      expect(emitIdx).toBeLessThan(switchIdx);
    });
  });

  describe('thread_list_snapshot', () => {
    it('defines sendThreadListSnapshot distinct from sendThreadListUpdate', () => {
      expect(bridgeSrc).toMatch(/function sendThreadListSnapshot/);
      expect(bridgeSrc).toMatch(/function sendThreadListUpdate/);
    });

    it('snapshot payload type is thread_list_snapshot and carries serverTime', () => {
      const fn = bridgeSrc.match(/function sendThreadListSnapshot\b[\s\S]*?^}/m)?.[0] || '';
      expect(fn).toMatch(/type:\s*'thread_list_snapshot'/);
      expect(fn).toMatch(/serverTime/);
      expect(fn).toMatch(/currentThreadId/);
    });

    it('snapshot resolves per-thread running state from engineRegistry inflight set', () => {
      const fn = bridgeSrc.match(/function sendThreadListSnapshot\b[\s\S]*?^}/m)?.[0] || '';
      expect(fn).toMatch(/inflightThreadIds/);
      // Per-thread state derives from inflight.has(t.id).
      expect(fn).toMatch(/state:\s*inflight\.has\(t\.id\)/);
    });
  });

  describe('snapshot push points (reconnect coverage)', () => {
    it('handleUnifyChat session-init path sends snapshot', () => {
      // First-touch init block inside handleUnifyChat sends session_ready +
      // thread_list_updated + thread_list_snapshot in that order.
      const block = bridgeSrc.slice(
        bridgeSrc.indexOf('export async function handleUnifyChat'),
        bridgeSrc.indexOf('// ─── Per-call AbortController'),
      );
      expect(block).toContain('sendThreadListSnapshot()');
    });

    it('handleUnifyLoadHistory pushes a snapshot on every call', () => {
      const fn = bridgeSrc.match(/export async function handleUnifyLoadHistory\b[\s\S]*?^}/m)?.[0] || '';
      expect(fn).toContain('sendThreadListSnapshot()');
    });

    it('resetUnifySession pushes a fresh snapshot post-reset', () => {
      const fn = bridgeSrc.match(/export async function resetUnifySession\b[\s\S]*?^}/m)?.[0] || '';
      expect(fn).toContain('sendThreadListSnapshot()');
    });
  });

  describe('red line: observer-only (no engine mutation in 325b)', () => {
    it('bridge does not call engineRegistry.setMaxConcurrent/delete/setCurrent from thread_status path', () => {
      // The emit helper is a pure payload builder — no registry mutation.
      const fn = bridgeSrc.match(/function emitThreadStatusFromEngineEvent\b[\s\S]*?^}/m)?.[0] || '';
      expect(fn).not.toMatch(/setMaxConcurrent/);
      expect(fn).not.toMatch(/\.delete\(/);
      expect(fn).not.toMatch(/setCurrent/);
    });

    it('snapshot builder only reads (list / inflightThreadIds) — never mutates', () => {
      const fn = bridgeSrc.match(/function sendThreadListSnapshot\b[\s\S]*?^}/m)?.[0] || '';
      expect(fn).not.toMatch(/\.flush\(/);
      expect(fn).not.toMatch(/setCurrent/);
      expect(fn).not.toMatch(/setMaxConcurrent/);
      expect(fn).not.toMatch(/archiveThread\(/);
    });

    it('references task-325b in an explanatory comment', () => {
      expect(bridgeSrc).toMatch(/task-325b/);
    });
  });
});
