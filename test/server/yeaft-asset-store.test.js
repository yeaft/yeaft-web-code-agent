import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createYeaftAssetStore } from '../../server/yeaft-asset-store.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

const dirs = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function store() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-assets-'));
  dirs.push(root);
  return createYeaftAssetStore({ root, secret: 'test-secret' });
}

describe('Yeaft asset store', () => {
  it('denies invalid tokens, MIME mismatch, SVG, and cross-Session lookup', () => {
    const assets = store();
    const image = assets.put({ ownerId: 'user-1', agentId: 'agent-1', sessionId: 'session-1', data: PNG, mimeType: 'image/png' });
    const url = new URL(image.src, 'http://localhost');
    const [, , , , scopeId, assetId] = url.pathname.split('/');
    expect(assets.read(scopeId, assetId, 'wrong')).toBeNull();
    expect(assets.describe({ ownerId: 'user-1', agentId: 'agent-1', sessionId: 'session-2', assetId })).toBeNull();
    expect(() => assets.put({ ownerId: 'u', agentId: 'a', sessionId: 's', data: PNG, mimeType: 'image/jpeg' })).toThrow(/MIME/);
    expect(() => assets.put({ ownerId: 'u', agentId: 'a', sessionId: 's', data: Buffer.from('<svg/>'), mimeType: 'image/svg+xml' })).toThrow(/Unsupported/);
  });

  it('deletes only the requested Session scope', () => {
    const assets = store();
    const first = assets.put({ ownerId: 'u', agentId: 'a', sessionId: 's1', data: PNG });
    const second = assets.put({ ownerId: 'u', agentId: 'a', sessionId: 's2', data: PNG });
    expect(assets.deleteScope({ ownerId: 'u', agentId: 'a', sessionId: 's1' })).toBe(1);
    expect(assets.describe({ ownerId: 'u', agentId: 'a', sessionId: 's1', assetId: first.assetId })).toBeNull();
    expect(assets.describe({ ownerId: 'u', agentId: 'a', sessionId: 's2', assetId: second.assetId })).not.toBeNull();
  });
});
