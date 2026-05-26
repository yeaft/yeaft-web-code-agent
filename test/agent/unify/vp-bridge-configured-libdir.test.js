/**
 * vp-bridge-configured-libdir.test.js — the VP snapshot and settings CRUD
 * surface must use the configured yeaftDir library, not the process user's
 * default ~/.yeaft directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import ctx from '../../../agent/context.js';
import { createVp } from '../../../agent/unify/vp/vp-crud.js';
import {
  handleUnifyVpCreate,
  handleUnifyVpDelete,
  handleUnifyVpRead,
  handleUnifyVpSubscribe,
  handleUnifyVpUpdate,
  __testResetVpState,
} from '../../../agent/unify/web-bridge.js';
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

function pathsFor(yeaftDir) {
  return {
    libDir: join(yeaftDir, 'virtual-persons'),
    memoryRoot: join(yeaftDir, 'memory'),
  };
}

function seedConfiguredLibrary(count) {
  const yeaftDir = join(tmpRoot, 'configured-yeaft');
  const { libDir, memoryRoot } = pathsFor(yeaftDir);
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

function latestCrudResult(op, requestId) {
  return [...(ctx.ws.sent || [])]
    .reverse()
    .find(msg => msg.type === 'unify_output'
      && msg.event?.type === 'vp_crud_result'
      && msg.event?.op === op
      && (!requestId || msg.event?.requestId === requestId))?.event;
}

function latestSnapshot() {
  return [...(ctx.ws.sent || [])]
    .reverse()
    .find(msg => msg.type === 'unify_output' && msg.event?.type === 'vp_snapshot')?.event;
}

describe('vp-bridge — configured VP library', () => {
  it('serves the full configured yeaftDir VP library on subscribe', () => {
    const yeaftDir = seedConfiguredLibrary(24);
    ctx.CONFIG = { ...(ctx.CONFIG || {}), yeaftDir };

    handleUnifyVpSubscribe({ type: 'unify_vp_subscribe' });

    const snapshot = latestSnapshot();
    expect(snapshot).toBeTruthy();
    expect(snapshot.vps).toHaveLength(24);
    expect(snapshot.vps.map(vp => vp.vpId)).toEqual(
      Array.from({ length: 24 }, (_, i) => `custom_vp_${String(i + 1).padStart(2, '0')}`),
    );
    expect(snapshot.emptyLibrary).toBe(false);
  });

  it('reads, updates, and deletes VPs from the configured library', () => {
    const yeaftDir = seedConfiguredLibrary(1);
    const { libDir, memoryRoot } = pathsFor(yeaftDir);
    const configuredRolePath = join(libDir, 'custom_vp_01', 'role.md');
    const configuredMemoryPath = join(memoryRoot, 'vp', 'custom_vp_01', 'summary.md');
    const defaultRolePath = join(tmpRoot, 'default-lib', 'custom_vp_01', 'role.md');
    ctx.CONFIG = { ...(ctx.CONFIG || {}), yeaftDir };

    handleUnifyVpRead({ type: 'unify_vp_read', requestId: 'read-1', vpId: 'custom_vp_01' });
    const read = latestCrudResult('read', 'read-1');
    expect(read).toMatchObject({ ok: true, vpId: 'custom_vp_01' });
    expect(read.vp.displayName).toBe('Custom VP 1');

    handleUnifyVpUpdate({
      type: 'unify_vp_update',
      requestId: 'update-1',
      payload: {
        vpId: 'custom_vp_01',
        displayName: 'Configured Updated',
        role: 'configured role',
        persona: 'updated persona',
      },
    });
    expect(latestCrudResult('update', 'update-1')).toMatchObject({ ok: true, vpId: 'custom_vp_01' });
    const updatedRole = readFileSync(configuredRolePath, 'utf-8');
    expect(updatedRole).toContain('name: Configured Updated');
    expect(updatedRole).toContain('updated persona');
    expect(existsSync(defaultRolePath)).toBe(false);

    writeFileSync(configuredMemoryPath, 'configured memory\n', 'utf-8');
    handleUnifyVpDelete({ type: 'unify_vp_delete', requestId: 'delete-1', vpId: 'custom_vp_01' });
    expect(latestCrudResult('delete', 'delete-1')).toMatchObject({ ok: true, vpId: 'custom_vp_01' });
    expect(existsSync(join(libDir, 'custom_vp_01'))).toBe(false);
    expect(existsSync(join(memoryRoot, 'vp', 'custom_vp_01'))).toBe(false);
    expect(existsSync(join(tmpRoot, 'default-lib', 'custom_vp_01'))).toBe(false);
  });

  it('creates VPs in the configured library and includes them on the next subscribe rescan', () => {
    const yeaftDir = seedConfiguredLibrary(1);
    const { libDir, memoryRoot } = pathsFor(yeaftDir);
    ctx.CONFIG = { ...(ctx.CONFIG || {}), yeaftDir };

    handleUnifyVpCreate({
      type: 'unify_vp_create',
      requestId: 'create-1',
      payload: {
        vpId: 'configured_new',
        displayName: 'Configured New',
        role: 'custom',
        persona: 'created in configured library',
      },
    });

    expect(latestCrudResult('create', 'create-1')).toMatchObject({ ok: true, vpId: 'configured_new' });
    expect(existsSync(join(libDir, 'configured_new', 'role.md'))).toBe(true);
    expect(existsSync(join(memoryRoot, 'vp', 'configured_new', 'summary.md'))).toBe(true);
    expect(existsSync(join(tmpRoot, 'default-lib', 'configured_new', 'role.md'))).toBe(false);

    handleUnifyVpSubscribe({ type: 'unify_vp_subscribe' });

    const snapshot = latestSnapshot();
    expect(snapshot.vps.map(vp => vp.vpId).sort()).toEqual(['configured_new', 'custom_vp_01']);
  });
});
