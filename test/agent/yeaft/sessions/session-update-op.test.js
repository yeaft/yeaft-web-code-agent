/**
 * group-update-op.test.js — handleYeaftUpdateSession WS handler.
 *
 * Mocks the connection buffer to capture outbound `yeaft_output` envelopes
 * and asserts on the wrapped `event` payload.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outbound = [];

vi.mock('../../../../agent/connection/buffer.js', () => ({
  sendToServer: (msg) => { outbound.push(msg); },
  flushMessageBuffer: () => {},
}));

import ctx from '../../../../agent/context.js';
import { handleYeaftUpdateSession } from '../../../../agent/yeaft/web-bridge.js';
import { createSession } from '../../../../agent/yeaft/sessions/session-store.js';

function findEvent(type) {
  return outbound.map(m => m.event).find(e => e && e.type === type);
}

describe('handleYeaftUpdateSession WS op', () => {
  let yeaftDir;
  beforeEach(() => {
    yeaftDir = mkdtempSync(join(tmpdir(), 'wsupd-'));
    ctx.CONFIG = { ...(ctx.CONFIG || {}), yeaftDir };
    outbound.length = 0;
    createSession(join(yeaftDir, 'sessions'), { id: 'g1', name: 'G1', roster: [] }).close();
  });

  it('updates announcement and emits group_crud_result + snapshot broadcast', () => {
    handleYeaftUpdateSession({ requestId: 'r1', sessionId: 'g1', patch: { announcement: 'Hi' } });
    const result = findEvent('group_crud_result');
    expect(result).toBeDefined();
    expect(result.op).toBe('update');
    expect(result.requestId).toBe('r1');
    expect(result.ok).toBe(true);
    expect(result.group.id).toBe('g1');
    expect(result.group.announcement).toBe('Hi');
    expect(findEvent('group_list_updated')).toBeDefined();
  });

  it('updates name and announcement together', () => {
    handleYeaftUpdateSession({
      requestId: 'r2', sessionId: 'g1',
      patch: { name: 'New', announcement: 'Hello' },
    });
    const result = findEvent('group_crud_result');
    expect(result.ok).toBe(true);
    expect(result.group.name).toBe('New');
    expect(result.group.announcement).toBe('Hello');
  });

  it('returns not_found for unknown sessionId', () => {
    handleYeaftUpdateSession({
      requestId: 'r3', sessionId: 'ghost',
      patch: { announcement: 'x' },
    });
    const result = findEvent('group_crud_result');
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('not_found');
  });

  it('rejects empty patch with invalid_patch', () => {
    handleYeaftUpdateSession({ requestId: 'r4', sessionId: 'g1', patch: {} });
    const result = findEvent('group_crud_result');
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('invalid_patch');
  });

  it('rejects missing patch with invalid_patch', () => {
    handleYeaftUpdateSession({ requestId: 'r5', sessionId: 'g1' });
    const result = findEvent('group_crud_result');
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('invalid_patch');
  });
});
