import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { _resetVpBridgeForTest, handleVpSubscribe } from '../../../agent/yeaft/vp/vp-bridge.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'yeaft-vp-bridge-defaults-'));
}

describe('VP bridge default library seeding', () => {
  afterEach(() => {
    _resetVpBridgeForTest();
  });

  it('seeds stock VPs before the first snapshot when the configured library is empty', () => {
    const libDir = join(tempDir(), 'virtual-persons');
    const events = [];

    const unsubscribe = handleVpSubscribe(event => events.push(event), undefined, { dir: libDir });
    unsubscribe();

    const snapshot = events.find(event => event.type === 'vp_snapshot');
    expect(snapshot).toBeTruthy();
    expect(snapshot.emptyLibrary).toBe(false);
    expect(snapshot.vps.length).toBeGreaterThan(20);
    expect(snapshot.vps.map(vp => vp.vpId)).toContain('omni');
    expect(snapshot.vps.map(vp => vp.vpId)).toContain('linus');
  });
});
