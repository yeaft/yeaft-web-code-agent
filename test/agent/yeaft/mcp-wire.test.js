/**
 * mcp-wire.test.js — Round-trip MCP wire CRUD ↔ config.json
 *
 * The web-bridge handlers use config-api's `listMcpServers / upsertMcpServer /
 * removeMcpServer` to mutate ~/.yeaft/config.json `mcpServers` and then call
 * the live `mcpManager.connect|disconnect` to apply at runtime. These tests
 * pin the config-api half — the storage contract that the bridge sits on
 * top of. Bridge-handler integration (broadcast, hot-swap call, etc.) is
 * covered by mcp-flatten.test.js + manual smoke; here we lock in the
 * data-plane invariants.
 *
 * Covers:
 *   (a) Empty config.json → list returns []
 *   (b) Upsert NEW name → appended + returned in the post-list
 *   (c) Upsert EXISTING name → replaces in place, list length unchanged
 *   (d) Remove existing → idempotent, returns removed:true
 *   (e) Remove non-existent → idempotent, returns removed:false
 *   (f) Invalid name / command / env shapes → validation errors
 *   (g) Round-trip stability — list (after add) matches what add returned
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  listMcpServers,
  upsertMcpServer,
  removeMcpServer,
} from '../../../agent/yeaft/config-api.js';

let testDir;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'yeaft-mcp-wire-'));
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe('listMcpServers — read path', () => {
  it('returns an empty array when config.json is missing', () => {
    const result = listMcpServers(testDir);
    expect(result.error).toBeUndefined();
    expect(result.servers).toEqual([]);
  });

  it('returns an empty array when config.json has no mcpServers field', () => {
    writeFileSync(join(testDir, 'config.json'), JSON.stringify({ providers: [] }), 'utf8');
    const result = listMcpServers(testDir);
    expect(result.servers).toEqual([]);
  });

  it('normalises corrupt entries away rather than blowing up', () => {
    writeFileSync(join(testDir, 'config.json'), JSON.stringify({
      mcpServers: [
        { name: 'good', command: 'npx', args: ['a'], env: { K: 'v' } },
        { name: 'missing-command' },          // dropped
        'string-not-an-object',                // dropped
        null,                                  // dropped
        { command: 'orphan-no-name' },         // dropped
        { name: 'numeric-args', command: 'x', args: [42, 'ok'] },  // args filtered to ['ok']
      ],
    }), 'utf8');

    const result = listMcpServers(testDir);
    expect(result.servers.map(s => s.name).sort()).toEqual(['good', 'numeric-args']);
    const numeric = result.servers.find(s => s.name === 'numeric-args');
    expect(numeric.args).toEqual(['ok']);
  });
});

describe('upsertMcpServer — add path', () => {
  it('writes a brand new server into config.json', () => {
    const result = upsertMcpServer({
      name: 'github',
      command: 'npx',
      args: ['@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'tok' },
    }, testDir);

    expect(result.error).toBeUndefined();
    expect(result.server.name).toBe('github');
    expect(result.servers).toHaveLength(1);

    const raw = JSON.parse(readFileSync(join(testDir, 'config.json'), 'utf8'));
    expect(raw.mcpServers).toHaveLength(1);
    expect(raw.mcpServers[0]).toEqual({
      name: 'github',
      command: 'npx',
      args: ['@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'tok' },
    });
  });

  it('preserves unrelated top-level fields when writing', () => {
    writeFileSync(join(testDir, 'config.json'), JSON.stringify({
      providers: [{ name: 'p', baseUrl: 'http://x/v1', apiKey: 'k', models: ['m'] }],
      primaryModel: 'p/m',
      debug: true,
      messageTokenBudget: 4096,
    }), 'utf8');

    upsertMcpServer({ name: 's1', command: 'npx', args: ['x'] }, testDir);

    const raw = JSON.parse(readFileSync(join(testDir, 'config.json'), 'utf8'));
    expect(raw.providers).toHaveLength(1);
    expect(raw.primaryModel).toBe('p/m');
    expect(raw.debug).toBe(true);
    expect(raw.messageTokenBudget).toBe(4096);
    expect(raw.mcpServers).toHaveLength(1);
  });

  it('replaces an existing entry with the same name (does NOT duplicate)', () => {
    upsertMcpServer({ name: 'srv', command: 'old', args: ['a'] }, testDir);
    const result = upsertMcpServer({ name: 'srv', command: 'new', args: ['b'], env: { K: 'v' } }, testDir);

    expect(result.servers).toHaveLength(1);
    expect(result.server.command).toBe('new');
    expect(result.server.args).toEqual(['b']);
    expect(result.server.env).toEqual({ K: 'v' });

    const raw = JSON.parse(readFileSync(join(testDir, 'config.json'), 'utf8'));
    expect(raw.mcpServers).toHaveLength(1);
    expect(raw.mcpServers[0].command).toBe('new');
  });

  it('appends multiple distinct servers in insertion order', () => {
    upsertMcpServer({ name: 'one', command: 'a' }, testDir);
    upsertMcpServer({ name: 'two', command: 'b' }, testDir);
    upsertMcpServer({ name: 'three', command: 'c' }, testDir);

    const result = listMcpServers(testDir);
    expect(result.servers.map(s => s.name)).toEqual(['one', 'two', 'three']);
  });

  it('post-add list matches the add result (round-trip stability)', () => {
    const r1 = upsertMcpServer({ name: 'first', command: 'npx', args: ['x'] }, testDir);
    const r2 = listMcpServers(testDir);
    expect(r2.servers).toEqual(r1.servers);
  });
});

describe('upsertMcpServer — validation', () => {
  it('rejects names that do not match /^[a-z0-9_-]+$/', () => {
    const cases = ['', 'Has Caps', 'has.dot', 'has space', 'has/slash', 'has+plus'];
    for (const bad of cases) {
      const result = upsertMcpServer({ name: bad, command: 'x' }, testDir);
      expect(result.error, `name="${bad}" should be rejected`).toMatch(/name/);
    }
  });

  it('accepts valid names (lowercase, digits, dash, underscore)', () => {
    const cases = ['github', 'my-server', 'srv_1', 'abc123', '0', 'a-b_c-1'];
    for (const ok of cases) {
      const result = upsertMcpServer({ name: ok, command: 'x' }, testDir);
      expect(result.error, `name="${ok}" should be accepted`).toBeUndefined();
      removeMcpServer(ok, testDir);  // cleanup so the next iter has a clean slate
    }
  });

  it('rejects missing/empty command', () => {
    expect(upsertMcpServer({ name: 's', command: '' }, testDir).error).toMatch(/command/);
    expect(upsertMcpServer({ name: 's' }, testDir).error).toMatch(/command/);
  });

  it('rejects non-string args', () => {
    const result = upsertMcpServer({ name: 's', command: 'x', args: [1, 2, 3] }, testDir);
    expect(result.error).toMatch(/args/);
  });

  it('rejects non-string env values', () => {
    const result = upsertMcpServer({ name: 's', command: 'x', env: { K: 42 } }, testDir);
    expect(result.error).toMatch(/env/);
  });

  it('rejects env that is an array or null (must be a plain object)', () => {
    expect(upsertMcpServer({ name: 's', command: 'x', env: [] }, testDir).error).toMatch(/env/);
    expect(upsertMcpServer({ name: 's', command: 'x', env: null }, testDir).error).toMatch(/env/);
  });
});

describe('removeMcpServer — delete path', () => {
  it('removes an existing entry and reports removed:true', () => {
    upsertMcpServer({ name: 'a', command: 'x' }, testDir);
    upsertMcpServer({ name: 'b', command: 'y' }, testDir);

    const result = removeMcpServer('a', testDir);
    expect(result.error).toBeUndefined();
    expect(result.removed).toBe(true);
    expect(result.servers.map(s => s.name)).toEqual(['b']);

    const raw = JSON.parse(readFileSync(join(testDir, 'config.json'), 'utf8'));
    expect(raw.mcpServers.map(s => s.name)).toEqual(['b']);
  });

  it('is idempotent for a missing name (removed:false, no error)', () => {
    upsertMcpServer({ name: 'real', command: 'x' }, testDir);

    const result = removeMcpServer('ghost', testDir);
    expect(result.error).toBeUndefined();
    expect(result.removed).toBe(false);
    expect(result.servers.map(s => s.name)).toEqual(['real']);
  });

  it('is idempotent on a completely empty config (removed:false, no error)', () => {
    const result = removeMcpServer('anything', testDir);
    expect(result.error).toBeUndefined();
    expect(result.removed).toBe(false);
    expect(result.servers).toEqual([]);
  });

  it('rejects empty / whitespace-only name', () => {
    expect(removeMcpServer('', testDir).error).toBe('name required');
    expect(removeMcpServer('   ', testDir).error).toBe('name required');
  });
});

describe('end-to-end CRUD round trip', () => {
  it('add → list → update → list → remove → list returns expected snapshots at each step', () => {
    // Empty → []
    expect(listMcpServers(testDir).servers).toEqual([]);

    // Add github
    upsertMcpServer({ name: 'github', command: 'npx', args: ['@m/server'], env: { TOKEN: 'a' } }, testDir);
    const afterAdd = listMcpServers(testDir).servers;
    expect(afterAdd).toHaveLength(1);
    expect(afterAdd[0].env.TOKEN).toBe('a');

    // Update github (rotate token)
    upsertMcpServer({ name: 'github', command: 'npx', args: ['@m/server'], env: { TOKEN: 'b' } }, testDir);
    const afterUpdate = listMcpServers(testDir).servers;
    expect(afterUpdate).toHaveLength(1);
    expect(afterUpdate[0].env.TOKEN).toBe('b');

    // Add slack alongside
    upsertMcpServer({ name: 'slack', command: 'npx', args: ['@m/slack'] }, testDir);
    const afterTwo = listMcpServers(testDir).servers.map(s => s.name).sort();
    expect(afterTwo).toEqual(['github', 'slack']);

    // Remove github
    const rm = removeMcpServer('github', testDir);
    expect(rm.removed).toBe(true);
    expect(listMcpServers(testDir).servers.map(s => s.name)).toEqual(['slack']);
  });
});
