/**
 * vp-bridge-configured-libdir.test.js — the VP snapshot served to settings and
 * group creation must come from the configured yeaftDir library, not from the
 * process user's default ~/.yeaft directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import ctx from '../../../agent/context.js';
import { createVp } from '../../../agent/unify/vp/vp-crud.js';
import { handleUnifyVpSubscribe, __testResetVpState } from '../../../agent/unify/web-bridge.js';
import { _resetVpBridgeForTest } from '../../../agent/unify/vp/vp-bridge.js';

let tmpRoot;
let prevConfig;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'vp-bridge-config-lib-'));
  prevConfig = ctx.CONFIG;
  ctx.messageBuffer = [];
  ctx.ws = {
    readyState: WebSocket.OPEN,
    sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
  };
  _resetVpBridgeForTest();
});

afterEach(async () => {
  await __testResetVpState();
  _resetVpBridgeForTest();
  ctx.CONFIG = prevConfig;
  ctx.ws = null;
  ctx.messageBuffer = [];
  rmSync(tmpRoot, { recursive: true, force: true });
});

function seedConfiguredLibrary(count) {
  const yeaftDir = join(tmpRoot, 'configured-yeaft');
  const libDir = join(yeaftDir, 'virtual-persons');
  const memoryRoot = join(yeaftDir, 'memory');
  for (let i = 1; i <= count; i++) {
    const vpId = `custom_vp_${String(i).padStart(2, '0')}`;
    createVp({
      vpId,
      displayName: `Custom VP ${i}`,
      role: 'custom',
      persona: `persona ${i}`,
    }, { libDir, memoryRoot });
  }
  return yeaftDir;
}

describe('vp-bridge — configured VP library', () => {
  it('serves the full configured yeaftDir VP library on subscribe', () => {
    const yeaftDir = seedConfiguredLibrary(24);
    ctx.CONFIG = { ...(ctx.CONFIG || {}), yeaftDir };

    handleUnifyVpSubscribe({ type: 'unify_vp_subscribe' });

    const sent = ctx.ws.sent || [];
    const snapshotMsg = sent.find(msg => msg.type === 'unify_output' && msg.event?.type === 'vp_snapshot');
    const snapshot = snapshotMsg?.event;
    expect(snapshot).toBeTruthy();
    expect(snapshot.vps).toHaveLength(24);
    expect(snapshot.vps.map(vp => vp.vpId)).toEqual(
      Array.from({ length: 24 }, (_, i) => `custom_vp_${String(i + 1).padStart(2, '0')}`),
    );
    expect(snapshot.emptyLibrary).toBe(false);
  });
});
