/**
 * session-handlers-wire-compat.test.js
 *
 * Regression guard for the fix-yeaft-delete-and-agent-revert bug.
 *
 * The web sends `{ groupId }` on the wire while the agent's per-id
 * handlers had been reading `msg.sessionId`. Result: every per-id
 * op (delete, rename, archive, update, update_config, add_member,
 * remove_member, set_default_vp) silently 404'd with `not_found`
 * because `sessionId` resolved to `undefined`.
 *
 * The documented wire contract (see `web/stores/sessions.js` header)
 * is "both accepted, prefer sessionId". This file drives each
 * handler with the legacy `{ groupId }` shape and asserts `ok: true`.
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

describe('per-id session handlers accept legacy { groupId } wire shape', () => {
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

  it('handleYeaftRenameSession accepts { groupId }', () => {
    handleYeaftRenameSession({ requestId: 'r-rename', groupId: 'g1', name: 'Renamed' });
    const ev = lastCrud();
    expect(ev).toBeTruthy();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('rename');
    expect(ev.session.name).toBe('Renamed');
  });

  it('handleYeaftUpdateSession accepts { groupId }', () => {
    handleYeaftUpdateSession({
      requestId: 'r-upd', groupId: 'g1',
      patch: { announcement: 'hello' },
    });
    const ev = lastCrud();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('update');
    expect(ev.session.announcement).toBe('hello');
  });

  it('handleYeaftUpdateSessionConfig accepts { groupId }', () => {
    handleYeaftUpdateSessionConfig({
      requestId: 'r-cfg', groupId: 'g1',
      config: { model: 'test-model-xyz' },
    });
    const ev = lastCrud();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('update_config');
  });

  it('handleYeaftSessionAddMember accepts { groupId }', () => {
    // Drop vp2 first so we have something to add back.
    handleYeaftSessionRemoveMember({ requestId: 'pre', groupId: 'g1', vpId: 'vp2' });
    outbound.length = 0;
    handleYeaftSessionAddMember({ requestId: 'r-add', groupId: 'g1', vpId: 'vp2' });
    const ev = lastCrud();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('add_member');
    expect(ev.session.roster).toContain('vp2');
  });

  it('handleYeaftSessionRemoveMember accepts { groupId }', () => {
    handleYeaftSessionRemoveMember({ requestId: 'r-rm', groupId: 'g1', vpId: 'vp2' });
    const ev = lastCrud();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('remove_member');
    expect(ev.session.roster).not.toContain('vp2');
  });

  it('handleYeaftSessionSetDefaultVp accepts { groupId }', () => {
    handleYeaftSessionSetDefaultVp({ requestId: 'r-def', groupId: 'g1', vpId: 'vp2' });
    const ev = lastCrud();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('set_default_vp');
    expect(ev.session.defaultVpId).toBe('vp2');
  });

  it('handleYeaftArchiveSession accepts { groupId }', () => {
    handleYeaftArchiveSession({ requestId: 'r-arc', groupId: 'g1' });
    const ev = lastCrud();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('archive');
  });

  it('handleYeaftDeleteSession accepts { groupId } (was the user-reported bug)', () => {
    handleYeaftDeleteSession({ requestId: 'r-del', groupId: 'g1' });
    const ev = lastCrud();
    expect(ev.ok).toBe(true);
    expect(ev.op).toBe('delete');
  });

  it('sessionId still wins when both are present', () => {
    // Sanity check: the contract is "both accepted, prefer sessionId".
    handleYeaftRenameSession({
      requestId: 'r-both', sessionId: 'g1', groupId: 'ghost', name: 'Winner',
    });
    const ev = lastCrud();
    expect(ev.ok).toBe(true);
    expect(ev.session.id).toBe('g1');
    expect(ev.session.name).toBe('Winner');
  });
});
