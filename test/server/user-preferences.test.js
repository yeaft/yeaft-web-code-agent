import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    }
    expect(db.prepare('SELECT * FROM user_preferences').all()).toEqual([]);
  });

  it('returns the default without persisting a row until the first update', async () => {
    const response = await getPreferences(aliceToken);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ sidebarProjectsRatio: 0.5 });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(db.prepare('SELECT * FROM user_preferences').all()).toEqual([]);
  });

  it('scopes reads and writes to the authenticated username, not supplied identity hints', async () => {
    const suffix = `?userId=${bob.id}&username=${bob.username}`;
    const updated = await patchPreferences(aliceToken, { sidebarProjectsRatio: 0.67 }, suffix)
      .set('X-User-Id', bob.id);
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({ sidebarProjectsRatio: 0.67 });
    expect((await getPreferences(aliceToken, suffix)).body).toEqual({ sidebarProjectsRatio: 0.67 });
    expect((await getPreferences(bobToken, `?userId=${alice.id}`)).body).toEqual({ sidebarProjectsRatio: 0.5 });
    expect((await patchPreferences(bobToken, { sidebarProjectsRatio: 0.32 })).body)
      .toEqual({ sidebarProjectsRatio: 0.32 });
    expect((await getPreferences(aliceToken)).body).toEqual({ sidebarProjectsRatio: 0.67 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM user_preferences').get().count).toBe(2);
  });

  it('accepts inclusive range boundaries and updates the same user row', async () => {
    for (const sidebarProjectsRatio of [0.15, 0.85, 0.5, 0.631]) {
      const response = await patchPreferences(aliceToken, { sidebarProjectsRatio });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ sidebarProjectsRatio });
      expect((await getPreferences(aliceToken)).body).toEqual({ sidebarProjectsRatio });
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM user_preferences').get().count).toBe(1);
  });

  it('rejects invalid shapes, unknown fields, non-numbers and non-finite/out-of-range values atomically', async () => {
    await patchPreferences(aliceToken, { sidebarProjectsRatio: 0.62 });
    const invalidBodies = [
      {}, [], null, 'invalid', 0.5, true,
      { sidebarProjectsRatio: '0.5' },
      { sidebarProjectsRatio: null },
      { sidebarProjectsRatio: false },
      { sidebarProjectsRatio: [] },
      { sidebarProjectsRatio: {} },
      { sidebarProjectsRatio: 0.149999 },
      { sidebarProjectsRatio: 0.850001 },
      { sidebarProjectsRatio: 0.5, unknown: true },
      { sidebarProjectsRatio: 0.5, userId: bob.id },
      { sidebarProjectsRatio: 0.5, username: bob.username },
    ];
    for (const body of invalidBodies) {
      // Sending raw JSON also exercises primitive bodies rather than supertest's form encoding.
      const response = await request(app).patch(preferencesPath)
        .auth(aliceToken, { type: 'bearer' })
        .set('Content-Type', 'application/json').send(JSON.stringify(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    // JSON's exponent syntax can overflow to Infinity; NaN is invalid JSON itself.
    for (const value of ['1e309', '-1e309', 'NaN']) {
      const response = await request(app).patch(preferencesPath)
        .auth(aliceToken, { type: 'bearer' })
        .set('Content-Type', 'application/json').send(`{"sidebarProjectsRatio":${value}}`);
      expect(response.status, value).toBe(400);
    }
    expect((await patchPreferences(aliceToken, undefined)).status).toBe(400);
    expect((await getPreferences(aliceToken)).body).toEqual({ sidebarProjectsRatio: 0.62 });
    expect((await getPreferences(bobToken)).body).toEqual({ sidebarProjectsRatio: 0.5 });
  });

  it('reuses loadCurrentUser to bootstrap the skip-auth user', async () => {
    CONFIG.skipAuth = true;
    expect(userDb.getByUsername('dev-user')).toBeUndefined();
    const response = await getPreferences();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ sidebarProjectsRatio: 0.5 });
    const devUser = userDb.getByUsername('dev-user');
    expect(devUser).toBeDefined();
    expect((await patchPreferences(undefined, { sidebarProjectsRatio: 0.7 })).body)
      .toEqual({ sidebarProjectsRatio: 0.7 });
    expect(userPreferencesDb.get(devUser.id)).toEqual({ sidebarProjectsRatio: 0.7 });
    expect(userPreferencesDb.get(alice.id)).toEqual({ sidebarProjectsRatio: 0.5 });
  });

  it('cascades preference removal when the owner is deleted and enforces the foreign key', async () => {
    userPreferencesDb.update(alice.id, 0.6);
    userPreferencesDb.update(bob.id, 0.4);
    expect(userDb.deleteUser(alice.id)).toBe(true);
    expect(db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(alice.id)).toBeUndefined();
    expect(userPreferencesDb.get(bob.id)).toEqual({ sidebarProjectsRatio: 0.4 });
    expect(() => userPreferencesDb.update(alice.id, 0.6)).toThrow(/FOREIGN KEY/);
    expect((await getPreferences(aliceToken)).status).toBe(401);
  });

  it('preserves preferences across closed and reopened Server DB processes', () => {
    const persistenceDir = join(testDbDir, 'restart');
    // Import only DB modules: the legacy database barrel starts an invitation cleanup timer.
    const dbUrl = name => JSON.stringify(new URL(`../../server/db/${name}.js`, import.meta.url).href);
    const imports = `
      import { closeDb } from ${dbUrl('connection')};
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
      const user = userDb.getOrCreate('persisted-owner');
      userPreferencesDb.update(user.id, 0.73);
      closeDb();
    `);
    // A second process runs the normal idempotent schema initialization and DB read path.
    const output = run(`
      import assert from 'node:assert/strict';
      const user = userDb.getByUsername('persisted-owner');
      assert.deepEqual(userPreferencesDb.get(user.id), { sidebarProjectsRatio: 0.73 });
      closeDb();
      console.log('preferences-persisted');
    `);
    expect(output).toContain('preferences-persisted');
  });
});
