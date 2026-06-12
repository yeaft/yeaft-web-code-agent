/**
 * session-handlers-session-id-wire.test.js
 *
 * Regression guard for the session-id-only wire contract. Per-id session
 * handlers must read `msg.sessionId`; legacy `groupId` payloads are no
 * longer accepted.
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
import {
  handleYeaftRenameSession,
  handleYeaftUpdateSession,
  handleYeaftUpdateSessionConfig,
  handleYeaftArchiveSession,
  handleYeaftDeleteSession,
  handleYeaftSessionAddMember,
  handleYeaftSessionRemoveMember,
  handleYeaftSessionSetDefaultVp,
} from '../../../../agent/yeaft/web-bridge.js';
import { createSession } from '../../../../agent/yeaft/sessions/session-store.js';

function lastCrud() {
  for (let i = outbound.length - 1; i >= 0; i--) {
    const ev = outbound[i] && outbound[i].event;
    if (ev && ev.type === 'session_crud_result') return ev;
  }
  return null;
}

describe('per-id session handlers accept { sessionId } wire shape', () => {
  let yeaftDir;

  beforeEach(() => {
    yeaftDir = mkdtempSync(join(tmpdir(), 'wirecompat-'));
    ctx.CONFIG = { ...(ctx.CONFIG || {}), yeaftDir };
    outbound.length = 0;
    // Seed a session with two VPs in the roster + vp1 as default. The
    // VP ids only need to be valid (validateVpId) — addMember /
    // removeMember / setDefault don't check existence on disk.
    createSession(join(yeaftDir, 'sessions'), {
      id: 'g1', name: 'G1', roster: ['vp1', 'vp2'], defaultVpId: 'vp1',
    }).close();
  });

  it('handleYeaftRenameSession accepts { sessionId }', () => {
    handleYeaftRenameSession({ requestId: 'r-rename', sessionId: 'g1', name: 'Renamed' });
    const ev = lastCrud();
    expect(ev).toBeTruthy();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('rename');
    expect(ev.session.name).toBe('Renamed');
  });

  it('handleYeaftUpdateSession accepts { sessionId }', () => {
    handleYeaftUpdateSession({
      requestId: 'r-upd', sessionId: 'g1',
      patch: { announcement: 'hello' },
    });
    const ev = lastCrud();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('update');
    expect(ev.session.announcement).toBe('hello');
  });

  it('handleYeaftUpdateSessionConfig accepts { sessionId }', () => {
    handleYeaftUpdateSessionConfig({
      requestId: 'r-cfg', sessionId: 'g1',
      config: { model: 'test-model-xyz' },
    });
    const ev = lastCrud();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('update_config');
  });

  it('handleYeaftSessionAddMember accepts { sessionId }', () => {
    // Drop vp2 first so we have something to add back.
    handleYeaftSessionRemoveMember({ requestId: 'pre', sessionId: 'g1', vpId: 'vp2' });
    outbound.length = 0;
    handleYeaftSessionAddMember({ requestId: 'r-add', sessionId: 'g1', vpId: 'vp2' });
    const ev = lastCrud();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('add_member');
    expect(ev.session.roster).toContain('vp2');
  });

  it('handleYeaftSessionRemoveMember accepts { sessionId }', () => {
    handleYeaftSessionRemoveMember({ requestId: 'r-rm', sessionId: 'g1', vpId: 'vp2' });
    const ev = lastCrud();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('remove_member');
    expect(ev.session.roster).not.toContain('vp2');
  });

  it('handleYeaftSessionSetDefaultVp accepts { sessionId }', () => {
    handleYeaftSessionSetDefaultVp({ requestId: 'r-def', sessionId: 'g1', vpId: 'vp2' });
    const ev = lastCrud();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('set_default_vp');
    expect(ev.session.defaultVpId).toBe('vp2');
  });

  it('handleYeaftArchiveSession accepts { sessionId }', () => {
    handleYeaftArchiveSession({ requestId: 'r-arc', sessionId: 'g1' });
    const ev = lastCrud();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('archive');
  });

  it('handleYeaftDeleteSession accepts { sessionId } (was the user-reported bug)', () => {
    handleYeaftDeleteSession({ requestId: 'r-del', sessionId: 'g1' });
    const ev = lastCrud();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('delete');
  });

});
