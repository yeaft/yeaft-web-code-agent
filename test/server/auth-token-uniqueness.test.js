import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeLogin } from '../../server/auth/login.js';
import { storePendingResult } from '../../server/auth/oauth-flow.js';
import { registerAuthRoutes } from '../../server/routes/auth-routes.js';
import { logout, verifyToken } from '../../server/auth/token.js';
import { generateSessionKey } from '../../server/encryption.js';
import { activeSessions, revokedTokens } from '../../server/auth/session-store.js';
import { CONFIG, getUserByUsername } from '../../server/config.js';
import db, { userDb } from '../../server/database.js';

const createdUserIds = [];
const configuredUsernames = [];
const tombstoneUsernames = [];

function configureUser(username) {
  CONFIG.users.push({
    username,
    passwordHash: 'configured-password-hash',
    email: `${username}@example.test`
  });
  configuredUsernames.push(username);
}

function createSsoOnlyUser(username, role = 'admin') {
  const existing = userDb.getByUsername(username);
  if (existing) return existing;
  const user = userDb.createFromAad(
    username,
    `${username}@example.test`,
    `test-${randomUUID()}`,
    role,
    username
  );
  createdUserIds.push(user.id);
  return user;
}

describe('session token issuance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-03T08:30:00Z'));
    activeSessions.clear();
    revokedTokens.clear();
  });

  afterEach(() => {
    activeSessions.clear();
    revokedTokens.clear();
    while (createdUserIds.length > 0) {
      const id = createdUserIds.pop();
      try { userDb.deleteUser(id); } catch {
        // ignore cleanup failures from already-deleted rows
      }
    }
    while (configuredUsernames.length > 0) {
      const username = configuredUsernames.pop();
      const index = CONFIG.users.findIndex(candidate => candidate.username === username);
      if (index !== -1) CONFIG.users.splice(index, 1);
    }
    while (tombstoneUsernames.length > 0) {
      const username = tombstoneUsernames.pop();
      try {
        db.prepare('DELETE FROM user_deletion_tombstones WHERE username = ?').run(username);
      } catch {
        // The regression test runs once against the pre-tombstone schema.
      }
    }
    vi.useRealTimers();
  });

  it('does not let logging out an old same-second session revoke a new login', () => {
    createSsoOnlyUser('same-user', 'pro');
    const first = completeLogin('same-user', generateSessionKey(), 'pro');
    const second = completeLogin('same-user', generateSessionKey(), 'pro');

    logout(first.token);

    expect(verifyToken(first.token).valid).toBe(false);
    expect(verifyToken(second.token).valid).toBe(true);
  });

  it('keeps a finalized configured-user deletion authoritative for fallback and startup migration', () => {
    const username = 'finalized-config-user';
    configureUser(username);
    tombstoneUsernames.push(username);
    const user = userDb.migrateUser(
      username, 'configured-password-hash', `${username}@example.test`, 'admin'
    );
    createdUserIds.push(user.id);
    userDb.beginDeletion(user.id);
    expect(userDb.deleteUser(user.id, { requirePending: true })).toBe(true);
    createdUserIds.splice(createdUserIds.indexOf(user.id), 1);

    expect(userDb.getByUsername(username)).toBeUndefined();
    expect(getUserByUsername(username)).toBeNull();
    expect(userDb.migrateUser(
      username, 'configured-password-hash', `${username}@example.test`, 'admin'
    )).toBeNull();
    expect(userDb.getByUsername(username)).toBeUndefined();
  });

  it('preserves SSO-only user roles when verifying a freshly issued JWT', async () => {
    createSsoOnlyUser('sso-only-admin-token', 'admin');
    const login = completeLogin('sso-only-admin-token', generateSessionKey(), 'admin');

    expect(login.userId).toBe(getUserByUsername('sso-only-admin-token').id);
    expect(verifyToken(login.token)).toMatchObject({
      valid: true,
      username: 'sso-only-admin-token',
      role: 'admin',
    });

    const routes = new Map();
    const app = {
      get: (path, ...handlers) => routes.set(`GET ${path}`, handlers),
      post: (path, ...handlers) => routes.set(`POST ${path}`, handlers),
      delete: (path, ...handlers) => routes.set(`DELETE ${path}`, handlers),
    };
    registerAuthRoutes(app, {
      requireAuth: (_req, _res, next) => next(),
      checkRateLimit: () => true,
    });
    const state = `qr-user-id-${randomUUID()}`;
    storePendingResult(state, { kind: 'login', ...login });
    const response = {
      body: null,
      cookie: vi.fn(),
      json(body) { this.body = body; return this; },
    };
    const handlers = routes.get('GET /api/auth/sso/poll/:state');
    await handlers[0]({ params: { state }, headers: {} }, response);
    expect(response.cookie).toHaveBeenCalled();
    expect(response.body).toMatchObject({
      status: 'login',
      token: login.token,
      userId: login.userId,
      role: 'admin',
    });
  });
});
