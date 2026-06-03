/**
 * session-store.test.js — Unit tests for the per-session persistent store.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createSession,
  openSession,
  listSessions,
  renameSession,
  updateSession,
  archiveSession,
  deleteSession,
  loadSessionMeta,
} from '../../../../agent/yeaft/sessions/session-store.js';

describe('session-store', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'yeaft-sess-'));
  });

  it('creates a session with vpIds and persists meta.json', () => {
    const h = createSession(root, { id: 's_one', vpIds: ['omni'], displayName: 'One' });
    const meta = h.getMeta();
    expect(meta.id).toBe('s_one');
    expect(meta.vpIds).toEqual(['omni']);
    expect(meta.displayName).toBe('One');
    expect(meta.lastTurnAt).toBeNull();
    h.close();
    const onDisk = JSON.parse(readFileSync(join(root, 's_one', 'meta.json'), 'utf8'));
    expect(onDisk.vpIds).toEqual(['omni']);
  });

  it('rejects empty vpIds', () => {
    expect(() => createSession(root, { id: 's', vpIds: [] })).toThrow();
  });

  it('lists sessions and skips dotfiles', () => {
    createSession(root, { id: 's1', vpIds: ['omni'] }).close();
    createSession(root, { id: 's2', vpIds: ['linus'] }).close();
    const list = listSessions(root);
    expect(list.map((s) => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('renameSession updates displayName', () => {
    createSession(root, { id: 's1', vpIds: ['omni'] }).close();
    const next = renameSession(root, 's1', 'Renamed');
    expect(next.displayName).toBe('Renamed');
  });

  it('updateSession adds/removes VPs', () => {
    createSession(root, { id: 's1', vpIds: ['omni'] }).close();
    let m = updateSession(root, 's1', { addVpIds: ['linus', 'fowler'] });
    expect(m.vpIds.sort()).toEqual(['fowler', 'linus', 'omni']);
    m = updateSession(root, 's1', { removeVpIds: ['linus'] });
    expect(m.vpIds.sort()).toEqual(['fowler', 'omni']);
  });

  it('refuses to leave a session with zero VPs', () => {
    createSession(root, { id: 's1', vpIds: ['omni'] }).close();
    expect(() => updateSession(root, 's1', { removeVpIds: ['omni'] })).toThrow();
  });

  it('archive renames dir; delete removes it', () => {
    createSession(root, { id: 's1', vpIds: ['omni'] }).close();
    expect(archiveSession(root, 's1')).toBe(true);
    expect(existsSync(join(root, 's1'))).toBe(false);
    createSession(root, { id: 's2', vpIds: ['omni'] }).close();
    expect(deleteSession(root, 's2')).toBe(true);
    expect(existsSync(join(root, 's2'))).toBe(false);
  });

  it('appendMessage round-trips through the jsonl log', () => {
    const h = createSession(root, { id: 's1', vpIds: ['omni'] });
    const stored = h.appendMessage({ from: 'user', text: 'hi' });
    expect(stored.id).toMatch(/^(m_|msg_)/);
    h.close();
    const h2 = openSession(root, 's1');
    const out = Array.from(h2.streamMessages());
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('hi');
    h2.close();
  });

  it('loadSessionMeta returns null on missing dir', () => {
    expect(loadSessionMeta(join(root, 'nope'))).toBeNull();
  });
});
