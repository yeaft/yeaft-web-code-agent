import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const testDbDir = mkdtempSync(join(tmpdir(), 'yeaft-user-preferences-'));
vi.stubEnv('SERVER_DATA_DIR', undefined);
vi.stubEnv('TEST_DB_PATH', undefined);
vi.stubEnv('TEST_DB_DIR', testDbDir);

const { default: db, closeDb, userDb, userPreferencesDb } = await import('../../server/database.js');
const { CONFIG } = await import('../../server/config.js');
const { issueSessionToken } = await import('../../server/auth/token.js');
const { activeSessions, revokedTokens } = await import('../../server/auth/session-store.js');
const { registerApiRoutes } = await import('../../server/api.js');
const originalSkipAuth = CONFIG.skipAuth;
const preferencesPath = '/api/user/preferences';
const defaults = { sidebarProjectsRatio: 0.5, sidebarActionsCompact: false };
const app = express();
app.use(express.json());
registerApiRoutes(app);
// Keep expected malformed-JSON failures quiet and JSON-shaped in this test app.
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

let alice;
let bob;
let aliceToken;
let bobToken;

beforeEach(() => {
  CONFIG.skipAuth = false;
  activeSessions.clear();
  revokedTokens.clear();
  for (const user of userDb.getAll()) userDb.deleteUser(user.id);
  alice = userDb.getOrCreate('preferences-alice');
  bob = userDb.getOrCreate('preferences-bob');
  aliceToken = issueSessionToken(alice.username);
  bobToken = issueSessionToken(bob.username);
});

afterAll(() => {
  CONFIG.skipAuth = originalSkipAuth;
  activeSessions.clear();
  revokedTokens.clear();
  closeDb();
  rmSync(testDbDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function getPreferences(token, suffix = '') {
  const req = request(app).get(`${preferencesPath}${suffix}`);
  return token ? req.auth(token, { type: 'bearer' }) : req;
}

function patchPreferences(token, body, suffix = '') {
  const req = request(app).patch(`${preferencesPath}${suffix}`);
  if (token) req.auth(token, { type: 'bearer' });
  return req.send(body);
}

describe('Server-owned user preferences', () => {
  it('requires authentication for reads and writes without creating a preference row', async () => {
    for (const token of [undefined, 'invalid-token']) {
      expect((await getPreferences(token)).status).toBe(401);
      expect((await patchPreferences(token, { sidebarProjectsRatio: 0.6 })).status).toBe(401);
      expect((await patchPreferences(token, { sidebarActionsCompact: true })).status).toBe(401);
    }
    expect(db.prepare('SELECT * FROM user_preferences').all()).toEqual([]);
  });

  it('returns both defaults without persisting a row until the first update', async () => {
    const response = await getPreferences(aliceToken);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(defaults);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(db.prepare('SELECT * FROM user_preferences').all()).toEqual([]);
  });

  it('scopes reads and writes to the authenticated username, not supplied identity hints', async () => {
    const suffix = `?userId=${bob.id}&username=${bob.username}`;
    const alicePreferences = { sidebarProjectsRatio: 0.67, sidebarActionsCompact: true };
    const bobPreferences = { sidebarProjectsRatio: 0.32, sidebarActionsCompact: false };
    const updated = await patchPreferences(aliceToken, alicePreferences, suffix)
      .set('X-User-Id', bob.id);
    expect(updated.status).toBe(200);
    expect(updated.headers['cache-control']).toBe('private, no-store');
    expect(updated.body).toEqual(alicePreferences);
    expect((await getPreferences(aliceToken, suffix)).body).toEqual(alicePreferences);
    expect((await getPreferences(bobToken, `?userId=${alice.id}`)).body).toEqual(defaults);
    expect((await patchPreferences(bobToken, bobPreferences)).body).toEqual(bobPreferences);
    expect((await getPreferences(aliceToken)).body).toEqual(alicePreferences);
    expect(db.prepare('SELECT COUNT(*) AS count FROM user_preferences').get().count).toBe(2);
  });

  it('accepts partial and combined patches, preserving omitted fields even across independent desktop requests', async () => {
    const compactOnly = await patchPreferences(aliceToken, { sidebarActionsCompact: true });
    expect(compactOnly.status).toBe(200);
    expect(compactOnly.body).toEqual({ ...defaults, sidebarActionsCompact: true });
    for (const sidebarProjectsRatio of [0.15, 0.85, 0.5, 0.631]) {
      const response = await patchPreferences(aliceToken, { sidebarProjectsRatio });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ sidebarProjectsRatio, sidebarActionsCompact: true });
      expect((await getPreferences(aliceToken)).body).toEqual(response.body);
    }
    const expanded = await patchPreferences(aliceToken, { sidebarActionsCompact: false });
    expect(expanded.status).toBe(200);
    expect(expanded.body).toEqual({ sidebarProjectsRatio: 0.631, sidebarActionsCompact: false });

    const otherDesktopToken = issueSessionToken(alice.username);
    for (const existingRow of [false, true]) {
      if (existingRow) {
        expect((await patchPreferences(aliceToken, defaults)).body).toEqual(defaults);
      } else {
        db.prepare('DELETE FROM user_preferences WHERE user_id = ?').run(alice.id);
      }
      // Both desktops send only their own field, with neither reading/merging the other's value.
      const responses = await Promise.all([
        patchPreferences(aliceToken, { sidebarProjectsRatio: 0.72 }),
        patchPreferences(otherDesktopToken, { sidebarActionsCompact: true }),
      ]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      expect((await getPreferences(aliceToken)).body)
        .toEqual({ sidebarProjectsRatio: 0.72, sidebarActionsCompact: true });
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM user_preferences').get().count).toBe(1);
    expect((await getPreferences(bobToken)).body).toEqual(defaults);
  });

  it('rejects invalid shapes, unknown fields, wrong types and non-finite/out-of-range values atomically', async () => {
    const original = { sidebarProjectsRatio: 0.62, sidebarActionsCompact: true };
    await patchPreferences(aliceToken, original);
    const invalidBodies = [
      {}, [], null, 'invalid', 0.5, true,
      { sidebarProjectsRatio: '0.5' },
      { sidebarProjectsRatio: null },
      { sidebarProjectsRatio: false },
      { sidebarProjectsRatio: [] },
      { sidebarProjectsRatio: {} },
      { sidebarProjectsRatio: 0.149999 },
      { sidebarProjectsRatio: 0.850001 },
      { sidebarActionsCompact: 'true' },
      { sidebarActionsCompact: 1 },
      { sidebarActionsCompact: 0 },
      { sidebarActionsCompact: null },
      { sidebarActionsCompact: [] },
      { sidebarActionsCompact: {} },
      { unknown: true },
      { sidebarProjectsRatio: 0.5, unknown: true },
      { sidebarActionsCompact: false, unknown: true },
      { sidebarProjectsRatio: 0.5, userId: bob.id },
      { sidebarActionsCompact: false, username: bob.username },
      { sidebarProjectsRatio: 0.8, sidebarActionsCompact: 'false' },
      { sidebarProjectsRatio: 0.9, sidebarActionsCompact: false },
    ];
    for (const body of invalidBodies) {
      // Sending raw JSON also exercises primitive bodies rather than supertest's form encoding.
      const response = await request(app).patch(preferencesPath)
        .auth(aliceToken, { type: 'bearer' })
        .set('Content-Type', 'application/json').send(JSON.stringify(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(userPreferencesDb.get(alice.id), JSON.stringify(body)).toEqual(original);
    }
    // JSON's exponent syntax can overflow to Infinity; NaN is invalid JSON itself.
    for (const value of ['1e309', '-1e309', 'NaN']) {
      const response = await request(app).patch(preferencesPath)
        .auth(aliceToken, { type: 'bearer' })
        .set('Content-Type', 'application/json')
        .send(`{"sidebarProjectsRatio":${value},"sidebarActionsCompact":false}`);
      expect(response.status, value).toBe(400);
      expect(userPreferencesDb.get(alice.id), value).toEqual(original);
    }
    expect((await patchPreferences(aliceToken, undefined)).status).toBe(400);
    expect((await getPreferences(aliceToken)).body).toEqual(original);
    expect((await getPreferences(bobToken)).body).toEqual(defaults);
  });

  it('reuses loadCurrentUser to bootstrap the skip-auth user', async () => {
    CONFIG.skipAuth = true;
    expect(userDb.getByUsername('dev-user')).toBeUndefined();
    const response = await getPreferences();
    expect(response.status).toBe(200);
    expect(response.body).toEqual(defaults);
    const devUser = userDb.getByUsername('dev-user');
    expect(devUser).toBeDefined();
    const devPreferences = { sidebarProjectsRatio: 0.7, sidebarActionsCompact: true };
    expect((await patchPreferences(undefined, devPreferences)).body).toEqual(devPreferences);
    expect(userPreferencesDb.get(devUser.id)).toEqual(devPreferences);
    expect(userPreferencesDb.get(alice.id)).toEqual(defaults);
  });

  it('cascades preference removal when the owner is deleted and enforces the foreign key', async () => {
    userPreferencesDb.update(alice.id, { sidebarProjectsRatio: 0.6, sidebarActionsCompact: true });
    userPreferencesDb.update(bob.id, { sidebarProjectsRatio: 0.4 });
    expect(userDb.deleteUser(alice.id)).toBe(true);
    expect(db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(alice.id)).toBeUndefined();
    expect(userPreferencesDb.get(bob.id)).toEqual({ ...defaults, sidebarProjectsRatio: 0.4 });
    expect(() => userPreferencesDb.update(alice.id, { sidebarActionsCompact: true })).toThrow(/FOREIGN KEY/);
    expect((await getPreferences(aliceToken)).status).toBe(401);
  });

  it('migrates ratio-only rows and persists both preferences across repeated Server DB restarts', () => {
    const persistenceDir = join(testDbDir, 'restart');
    mkdirSync(persistenceDir);
    const legacyDb = new DatabaseSync(join(persistenceDir, 'webchat.db'));
    legacyDb.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT,
        created_at INTEGER NOT NULL, last_login_at INTEGER
      );
      CREATE TABLE user_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        sidebar_projects_ratio REAL NOT NULL DEFAULT 0.5
          CHECK (sidebar_projects_ratio >= 0.15 AND sidebar_projects_ratio <= 0.85)
      );
      INSERT INTO users (id, username, created_at) VALUES
        ('legacy-owner', 'persisted-owner', 1), ('legacy-other', 'persisted-other', 2);
      INSERT INTO user_preferences (user_id, sidebar_projects_ratio) VALUES
        ('legacy-owner', 0.73), ('legacy-other', 0.28);
    `);
    legacyDb.close();

    // Import only DB modules: the legacy database barrel starts an invitation cleanup timer.
    const dbUrl = name => JSON.stringify(new URL(`../../server/db/${name}.js`, import.meta.url).href);
    const imports = `
      import assert from 'node:assert/strict';
      import db, { closeDb } from ${dbUrl('connection')};
      import { userDb } from ${dbUrl('user-db')};
      import { userPreferencesDb } from ${dbUrl('user-preferences-db')};
    `;
    const env = { ...process.env, SERVER_DATA_DIR: persistenceDir };
    function run(code) {
      return execFileSync(process.execPath, ['--input-type=module', '-e', imports + code], {
        env, encoding: 'utf8', timeout: 10000,
      });
    }
    run(`
      const user = userDb.getByUsername('persisted-owner');
      assert.equal(user.id, 'legacy-owner');
      assert.deepEqual(userPreferencesDb.get(user.id), { sidebarProjectsRatio: 0.73, sidebarActionsCompact: false });
      assert.deepEqual(userPreferencesDb.get('legacy-other'), { sidebarProjectsRatio: 0.28, sidebarActionsCompact: false });
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_preferences').get().count, 2);
      userPreferencesDb.update(user.id, { sidebarActionsCompact: true });
      closeDb();
    `);
    // Reinitializing an already migrated DB must preserve the new preference too.
    run(`
      assert.deepEqual(userPreferencesDb.get('legacy-owner'), { sidebarProjectsRatio: 0.73, sidebarActionsCompact: true });
      userPreferencesDb.update('legacy-owner', { sidebarProjectsRatio: 0.64 });
      closeDb();
    `);
    const output = run(`
      assert.deepEqual(userPreferencesDb.get('legacy-owner'), { sidebarProjectsRatio: 0.64, sidebarActionsCompact: true });
      assert.deepEqual(userPreferencesDb.get('legacy-other'), { sidebarProjectsRatio: 0.28, sidebarActionsCompact: false });
      assert.equal(db.prepare('PRAGMA table_info(user_preferences)').all().filter(column => column.name === 'sidebar_actions_compact').length, 1);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      closeDb();
      console.log('preferences-persisted');
    `);
    expect(output).toContain('preferences-persisted');
  });
});
