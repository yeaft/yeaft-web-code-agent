/**
 * task-334a — VP entity + RoleInstance base tests.
 *
 * Covers slice-spec acceptance #1 (role.md parse), #2 (hot-reload +
 * runtimeState preservation), #3 (RoleInstance idempotency + LRU), and
 * #4 (count() API).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  parseRoleMd,
  loadVpFromDir,
  scanVpLibrary,
  count,
} from '../../../../agent/unify/vp/vp-store.js';
import { RoleInstance } from '../../../../agent/unify/vp/role-instance.js';
import { Registry } from '../../../../agent/unify/vp/registry.js';
import { VpLoader } from '../../../../agent/unify/vp/vp-loader.js';

function makeLib() {
  return mkdtempSync(join(tmpdir(), 'yeaft-vp-'));
}

function writeVp(root, name, meta, body = 'persona body') {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const yaml = Object.entries(meta)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}:\n` + v.map(item => `  - ${item}`).join('\n');
      }
      return `${k}: ${v}`;
    })
    .join('\n');
  const source = `---\n${yaml}\n---\n${body}\n`;
  writeFileSync(join(dir, 'role.md'), source);
  return dir;
}

describe('vp-store.parseRoleMd', () => {
  it('parses scalars + list frontmatter + body', () => {
    const src = `---\nid: alice\nname: Alice\nrole: PM\ntraits:\n  - curious\n  - pragmatic\nmodelHint: primary\n---\nBody content here.`;
    const { meta, body } = parseRoleMd(src);
    expect(meta.id).toBe('alice');
    expect(meta.name).toBe('Alice');
    expect(meta.role).toBe('PM');
    expect(meta.traits).toEqual(['curious', 'pragmatic']);
    expect(meta.modelHint).toBe('primary');
    expect(body).toBe('Body content here.');
  });

  it('handles source without frontmatter', () => {
    const { meta, body } = parseRoleMd('just text');
    expect(meta).toEqual({});
    expect(body).toBe('just text');
  });

  it('strips surrounding quotes', () => {
    const src = `---\nid: "bob"\nname: 'Bob Smith'\n---\nx`;
    const { meta } = parseRoleMd(src);
    expect(meta.id).toBe('bob');
    expect(meta.name).toBe('Bob Smith');
  });
});

describe('vp-store.loadVpFromDir / scanVpLibrary / count', () => {
  let root;
  beforeEach(() => { root = makeLib(); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /**/ } });

  it('returns VP and mkdir -p memory/ (no shard-store touch)', () => {
    const dir = writeVp(root, 'alice', { id: 'alice', name: 'Alice', role: 'PM' });
    const vp = loadVpFromDir(dir);
    expect(vp).toBeTruthy();
    expect(vp.id).toBe('alice');
    expect(vp.role).toBe('PM');
    expect(vp.memoryDir).toBe(join(dir, 'memory'));
    expect(existsSync(vp.memoryDir)).toBe(true);
    // No files created inside memory/ — just mkdir (hard constraint a)
    expect(readdirSync(vp.memoryDir).length).toBe(0);
  });

  it('falls back to dir name when id omitted', () => {
    const dir = writeVp(root, 'carol', { name: 'Carol' });
    const vp = loadVpFromDir(dir);
    expect(vp.id).toBe('carol');
  });

  it('returns null when role.md missing', () => {
    const dir = join(root, 'empty');
    mkdirSync(dir);
    expect(loadVpFromDir(dir)).toBeNull();
  });

  it('scanVpLibrary returns all VPs, skips dotfiles / non-dirs', () => {
    writeVp(root, 'a', { id: 'a' });
    writeVp(root, 'b', { id: 'b' });
    writeVp(root, '.hidden', { id: 'hidden' });
    writeFileSync(join(root, 'README.md'), '#');
    const vps = scanVpLibrary({ dir: root });
    const ids = vps.map(v => v.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('count matches number of dirs containing role.md', () => {
    writeVp(root, 'a', { id: 'a' });
    writeVp(root, 'b', { id: 'b' });
    mkdirSync(join(root, 'no-role')); // no role.md
    expect(count({ dir: root })).toBe(2);
  });

  it('count returns 0 for missing library dir', () => {
    expect(count({ dir: join(root, 'does-not-exist') })).toBe(0);
  });

  it('personaHash is sha256(body).slice(0,8); same body → same hash', () => {
    const d1 = writeVp(root, 'h1', { id: 'h1' }, 'persona body shared');
    const d2 = writeVp(root, 'h2', { id: 'h2' }, 'persona body shared');
    const v1 = loadVpFromDir(d1);
    const v2 = loadVpFromDir(d2);
    expect(v1.personaHash).toBeTruthy();
    expect(v1.personaHash).toMatch(/^[0-9a-f]{8}$/);
    expect(v1.personaHash).toBe(v2.personaHash);
  });

  it('personaHash changes when persona body changes', () => {
    const dir = writeVp(root, 'changer', { id: 'changer' }, 'first body');
    const before = loadVpFromDir(dir).personaHash;
    writeFileSync(join(dir, 'role.md'), `---\nid: changer\n---\nsecond body different\n`);
    const after = loadVpFromDir(dir).personaHash;
    expect(after).toMatch(/^[0-9a-f]{8}$/);
    expect(after).not.toBe(before);
  });
});

describe('RoleInstance + Registry', () => {
  let root;
  let registry;
  beforeEach(() => {
    root = makeLib();
    writeVp(root, 'alice', { id: 'alice', name: 'Alice' });
    writeVp(root, 'bob', { id: 'bob', name: 'Bob' });
    registry = new Registry({ maxActiveRoleInstances: 40 });
    for (const vp of scanVpLibrary({ dir: root })) registry.setVp(vp);
  });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /**/ } });

  it('getOrCreateRoleInstance is idempotent per (vpId, groupId)', () => {
    const a1 = registry.getOrCreateRoleInstance('alice', 'g1');
    const a2 = registry.getOrCreateRoleInstance('alice', 'g1');
    expect(a1).toBe(a2);
  });

  it('different groups yield distinct instances', () => {
    const a = registry.getOrCreateRoleInstance('alice', 'g1');
    const b = registry.getOrCreateRoleInstance('alice', 'g2');
    expect(a).not.toBe(b);
  });

  it('throws for unknown vpId', () => {
    expect(() => registry.getOrCreateRoleInstance('ghost', 'g1')).toThrow(/unknown vpId/);
  });

  it('snapshot reports id + state + counters', () => {
    const ri = registry.getOrCreateRoleInstance('alice', 'g1');
    ri.messages.push({ role: 'user', content: 'hi' });
    const snap = ri.snapshot();
    expect(snap.vpId).toBe('alice');
    expect(snap.groupId).toBe('g1');
    expect(snap.state).toBe('idle');
    expect(snap.messageCount).toBe(1);
  });

  it('LRU evicts least-recently-used idle instance when limit exceeded', async () => {
    const r = new Registry({ maxActiveRoleInstances: 2 });
    r.setVp({ id: 'a', name: 'A', role: '', traits: [], modelHint: undefined, persona: '', dir: '', memoryDir: '', mtimeMs: 0 });

    const r1 = r.getOrCreateRoleInstance('a', 'g1');
    await new Promise(res => setTimeout(res, 5));
    const r2 = r.getOrCreateRoleInstance('a', 'g2');
    await new Promise(res => setTimeout(res, 5));
    r1.touch(); // make r1 MRU, r2 LRU
    await new Promise(res => setTimeout(res, 5));
    const r3 = r.getOrCreateRoleInstance('a', 'g3');

    expect(r.activeRoleInstanceCount()).toBe(2);
    expect(r.getRoleInstance('a', 'g2')).toBeUndefined(); // evicted
    expect(r.getRoleInstance('a', 'g1')).toBe(r1);
    expect(r.getRoleInstance('a', 'g3')).toBe(r3);
  });

  it('LRU skips non-idle instances (soft-limit breach accepted)', () => {
    const r = new Registry({ maxActiveRoleInstances: 1 });
    r.setVp({ id: 'a', name: 'A', role: '', traits: [], modelHint: undefined, persona: '', dir: '', memoryDir: '', mtimeMs: 0 });
    const r1 = r.getOrCreateRoleInstance('a', 'g1');
    r1.setState('running');
    const r2 = r.getOrCreateRoleInstance('a', 'g2');
    // r1 was running; r2 must also exist (soft cap)
    expect(r.activeRoleInstanceCount()).toBe(2);
    expect(r.getRoleInstance('a', 'g1')).toBe(r1);
    expect(r.getRoleInstance('a', 'g2')).toBe(r2);
  });

  it('removeVp drops all its RoleInstances', () => {
    registry.getOrCreateRoleInstance('alice', 'g1');
    registry.getOrCreateRoleInstance('alice', 'g2');
    registry.getOrCreateRoleInstance('bob', 'g1');
    registry.removeVp('alice');
    expect(registry.getVp('alice')).toBeUndefined();
    expect(registry.getRoleInstance('alice', 'g1')).toBeUndefined();
    expect(registry.getRoleInstance('alice', 'g2')).toBeUndefined();
    expect(registry.getRoleInstance('bob', 'g1')).toBeTruthy();
  });
});

describe('VpLoader hot-reload', () => {
  let root;
  let registry;
  let loader;
  beforeEach(() => {
    root = makeLib();
    registry = new Registry();
    loader = new VpLoader({ dir: root, registry, debounceMs: 10 });
  });
  afterEach(() => {
    loader.stop();
    try { rmSync(root, { recursive: true, force: true }); } catch { /**/ }
  });

  it('initial start() loads existing VPs into the registry', () => {
    writeVp(root, 'alice', { id: 'alice', name: 'Alice' });
    const vps = loader.start();
    expect(vps.map(v => v.id)).toEqual(['alice']);
    expect(registry.getVp('alice')).toBeTruthy();
  });

  it('rescanNow detects added / removed VPs', () => {
    writeVp(root, 'alice', { id: 'alice' });
    loader.start();
    writeVp(root, 'bob', { id: 'bob' });
    const s1 = loader.rescanNow();
    expect(s1.added).toEqual(['bob']);
    expect(registry.getVp('bob')).toBeTruthy();

    rmSync(join(root, 'alice'), { recursive: true, force: true });
    const s2 = loader.rescanNow();
    expect(s2.removed).toEqual(['alice']);
    expect(registry.getVp('alice')).toBeUndefined();
  });

  it('role.md update preserves VP identity + RoleInstance.runtimeState', () => {
    writeVp(root, 'alice', { id: 'alice', name: 'Alice', role: 'PM' }, 'old persona');
    loader.start();
    const vpBefore = registry.getVp('alice');
    const ri = registry.getOrCreateRoleInstance('alice', 'g1');
    ri.messages.push({ role: 'user', content: 'hi' });
    ri.setState('running');

    // Rewrite role.md with new persona + bump mtime to force update detection
    writeVp(root, 'alice', { id: 'alice', name: 'Alice 2', role: 'Architect' }, 'new persona');
    const future = new Date(Date.now() + 10_000);
    utimesSync(join(root, 'alice', 'role.md'), future, future);

    const s = loader.rescanNow();
    expect(s.updated).toEqual(['alice']);

    const vpAfter = registry.getVp('alice');
    // Same object identity → RoleInstance.vp reference still valid
    expect(vpAfter).toBe(vpBefore);
    expect(ri.vp).toBe(vpAfter);
    expect(vpAfter.name).toBe('Alice 2');
    expect(vpAfter.role).toBe('Architect');
    expect(vpAfter.persona).toBe('new persona');

    // RoleInstance runtime state untouched
    expect(ri.messages.length).toBe(1);
    expect(ri.state).toBe('running');
  });

  it('debounces multiple rapid change events', async () => {
    writeVp(root, 'alice', { id: 'alice' });
    let fires = 0;
    loader = new VpLoader({ dir: root, registry, debounceMs: 30, onChange: () => { fires++; } });
    loader.start();
    // Simulate a burst
    loader._scheduleRescan();
    loader._scheduleRescan();
    loader._scheduleRescan();
    await new Promise(res => setTimeout(res, 80));
    // No actual changes on disk → onChange should not fire at all.
    expect(fires).toBe(0);

    writeVp(root, 'bob', { id: 'bob' });
    loader._scheduleRescan();
    loader._scheduleRescan();
    await new Promise(res => setTimeout(res, 80));
    expect(fires).toBe(1);
  });

  it('stop() is safe to call repeatedly', () => {
    loader.start();
    loader.stop();
    expect(() => loader.stop()).not.toThrow();
  });
});

describe('module does not import 334o storage (hard constraint a)', () => {
  it('vp-store does not import from a storage module', () => {
    const src = readFileSync(
      join(process.cwd(), 'agent/unify/vp/vp-store.js'),
      'utf-8'
    );
    expect(src).not.toMatch(/from ['"][^'"]*storage[^'"]*['"]/);
    expect(src).not.toMatch(/require\(['"][^'"]*storage/);
  });

  it('role-instance does not import from a storage module', () => {
    const src = readFileSync(
      join(process.cwd(), 'agent/unify/vp/role-instance.js'),
      'utf-8'
    );
    expect(src).not.toMatch(/from ['"][^'"]*storage[^'"]*['"]/);
    expect(src).not.toMatch(/require\(['"][^'"]*storage/);
  });

  it('vp-loader does not import from a storage module', () => {
    const src = readFileSync(
      join(process.cwd(), 'agent/unify/vp/vp-loader.js'),
      'utf-8'
    );
    expect(src).not.toMatch(/from ['"][^'"]*storage[^'"]*['"]/);
  });
});
