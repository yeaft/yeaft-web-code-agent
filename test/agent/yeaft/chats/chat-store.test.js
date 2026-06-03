/**
 * chat-store unit tests — CRUD round-trip, isolation from groups, jsonl append.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  openChat, createChat, listChats, renameChat,
  touchChat, archiveChat, deleteChat, loadChatMeta,
} from '../../../../agent/yeaft/chats/chat-store.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'chat-store-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

describe('chat-store', () => {
  it('createChat persists meta and rejects duplicate id', () => {
    const h = createChat(root, { id: 'c1', vpId: 'alice', displayName: 'First' });
    const meta = h.getMeta();
    expect(meta.id).toBe('c1');
    expect(meta.vpId).toBe('alice');
    expect(meta.displayName).toBe('First');
    expect(meta.lastTurnAt).toBeNull();
    h.close();
    expect(() => createChat(root, { id: 'c1', vpId: 'alice' })).toThrow(/already exists/);
  });

  it('rejects invalid + reserved vpIds', () => {
    expect(() => createChat(root, { id: 'c2' })).toThrow(/vpId required/);
    expect(() => createChat(root, { id: 'c3', vpId: 'user' })).toThrow();
  });

  it('rejects invalid chatId chars', () => {
    expect(() => openChat(root, 'bad id!')).toThrow(/invalid chatId/);
  });

  it('listChats returns only live (non-archived) chats', () => {
    createChat(root, { id: 'a', vpId: 'alice' }).close();
    createChat(root, { id: 'b', vpId: 'bob' }).close();
    archiveChat(root, 'a');
    const live = listChats(root).map(c => c.id);
    expect(live).toEqual(['b']);
  });

  it('rename + touch update meta and persist', () => {
    createChat(root, { id: 'c', vpId: 'alice' }).close();
    renameChat(root, 'c', 'New Name');
    const ts = '2026-06-03T00:00:00.000Z';
    touchChat(root, 'c', ts);
    const meta = loadChatMeta(join(root, 'c'));
    expect(meta.displayName).toBe('New Name');
    expect(meta.lastTurnAt).toBe(ts);
  });

  it('appendMessage assigns id+ts; rejects underscore-prefixed (ephemeral) fields', () => {
    const h = createChat(root, { id: 'c', vpId: 'alice' });
    const r = h.appendMessage({ from: 'user', role: 'user', text: 'hi' });
    expect(r.id).toBeTruthy();
    expect(r.ts).toBeTruthy();
    expect(() => h.appendMessage({ from: 'user', text: 'x', _promptParts: [] })).toThrow(/ephemeral/);
    h.close();
  });

  it('deleteChat removes directory; archive moves to .archived-<id>-*', () => {
    createChat(root, { id: 'gone', vpId: 'alice' }).close();
    archiveChat(root, 'gone');
    expect(readdirSync(root).some(n => n.startsWith('.archived-gone-'))).toBe(true);
    createChat(root, { id: 'dead', vpId: 'alice' }).close();
    deleteChat(root, 'dead');
    expect(existsSync(join(root, 'dead'))).toBe(false);
  });

  it('does not write into a parallel groups/ tree', () => {
    createChat(root, { id: 'c1', vpId: 'alice' }).close();
    // Only the chat dir + chat.json + messages/ should exist.
    expect(existsSync(join(root, 'c1', 'chat.json'))).toBe(true);
    expect(existsSync(join(root, 'c1', 'messages'))).toBe(true);
    expect(existsSync(join(root, 'groups'))).toBe(false);
  });
});
