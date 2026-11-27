import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeLogin } from '../../server/auth/login.js';
import { activeSessions, revokedTokens } from '../../server/auth/session-store.js';
import { userDb } from '../../server/database.js';
import { registerAuthRoutes } from '../../server/routes/auth-routes.js';
import { registerUserRoutes } from '../../server/routes/user-routes.js';
import { SESSION_COOKIE_NAME, setSessionCookie } from '../../server/auth/request-auth.js';

const createdUserIds = [];

function issue(username) {
  let user = userDb.getByUsername(username);
  if (!user) {
    user = userDb.getOrCreate(username);
    createdUserIds.push(user.id);
  }
  return completeLogin(username, `session-key-${username}`).token;
}

describe('request authentication', () => {
  beforeEach(() => {
    activeSessions.clear();
    revokedTokens.clear();
  });

  afterEach(() => {
    activeSessions.clear();
    revokedTokens.clear();
    while (createdUserIds.length > 0) userDb.deleteUser(createdUserIds.pop());
  });

  it('sets a secure HttpOnly same-origin session cookie behind HTTPS proxying', () => {
    const token = issue('secure-user');
    const res = { cookie: (...args) => { res.args = args; } };

    setSessionCookie({ headers: { 'x-forwarded-proto': 'https' } }, res, token);

    expect(res.args[0]).toBe(SESSION_COOKIE_NAME);
    expect(res.args[1]).toBe(token);
    expect(res.args[2]).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true, path: '/' });
    expect(res.args[2].maxAge).toBeGreaterThan(0);
  });

  it('revokes and clears a cookie-only session through the logout route', () => {
    const token = issue('logout-user');
    const routes = new Map();
    const app = {
      get() {},
      delete() {},
      post(path, ...handlers) { routes.set(path, handlers.at(-1)); },
    };
    registerAuthRoutes(app, { requireAuth() {}, checkRateLimit: () => true });
    const req = {
      secure: true,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    };
    const res = {
      clearCookie: (...args) => { res.cleared = args; },
      json: body => { res.body = body; return res; },
    };

    routes.get('/api/auth/logout')(req, res);

    expect(revokedTokens.has(token)).toBe(true);
    expect(activeSessions.has(token)).toBe(false);
    expect(res.cleared).toEqual([
      SESSION_COOKIE_NAME,
      { httpOnly: true, sameSite: 'lax', secure: true, path: '/' },
    ]);
    expect(res.body).toEqual({ success: true });
  });

  it('persists, merges, and validates cloud cosmosConfig through /api/user/preferences', () => {
    issue('cosmos-prefs-user');
    const getRoutes = new Map();
    const patchRoutes = new Map();
    const app = {
      get(path, ...handlers) { getRoutes.set(path, handlers.at(-1)); },
      patch(path, ...handlers) { patchRoutes.set(path, handlers.at(-1)); },
      put() {},
      post() {},
      delete() {},
    };
    registerUserRoutes(app, { requireAuth() {}, requireAdmin() {} });

    const callRoute = (map, path, body = undefined) => {
      const res = {
        statusCode: 200,
        headers: {},
        set(k, v) { res.headers[k] = v; return res; },
        status(code) { res.statusCode = code; return res; },
        json(payload) { res.body = payload; return res; },
      };
      map.get(path)({ user: { username: 'cosmos-prefs-user' }, body }, res);
      return res;
    };

    // Initial GET returns empty cosmosConfig
    const initial = callRoute(getRoutes, '/api/user/preferences');
    expect(initial.statusCode).toBe(200);
    expect(initial.body.cosmosConfig).toEqual({});

    // PATCH constants + planetBindings + drawerWidth + uiMode
    const p1 = callRoute(patchRoutes, '/api/user/preferences', {
      cosmosConfig: {
        constants: { orbitSpeed: 0.4, spinSpeed: 1.2, planetScale: 1.15, eventScale: 0.85, skyBright: 1.35, activeFlash: false, livePreviewMode: '3', renderQuality: 'lite' },
        planetBindings: { 'ag-1': 'saturn', 'ag-2': 'mars' },
        drawerWidth: 740,
        uiMode: 'cosmos',
      },
    });
    expect(p1.statusCode).toBe(200);
    expect(p1.body.cosmosConfig).toEqual({
      constants: { orbitSpeed: 0.4, spinSpeed: 1.2, planetScale: 1.15, eventScale: 0.85, skyBright: 1.35, activeFlash: false, livePreviewMode: '3', renderQuality: 'lite' },
      planetBindings: { 'ag-1': 'saturn', 'ag-2': 'mars' },
      drawerWidth: 740,
      uiMode: 'cosmos',
    });

    // Partial constants PATCH merges per-field; planetBindings replaces map cleanly; drawerWidth null resets; sidebar PATCH preserves cosmosConfig
    const p2 = callRoute(patchRoutes, '/api/user/preferences', {
      cosmosConfig: {
        constants: { starDensity: 1.6 },
        planetBindings: { 'ag-1': 'jupiter' },
        drawerWidth: null,
      },
    });
    expect(p2.statusCode).toBe(200);
    expect(p2.body.cosmosConfig).toEqual({
      constants: { orbitSpeed: 0.4, spinSpeed: 1.2, planetScale: 1.15, eventScale: 0.85, skyBright: 1.35, activeFlash: false, livePreviewMode: '3', renderQuality: 'lite', starDensity: 1.6 },
      planetBindings: { 'ag-1': 'jupiter' },
      drawerWidth: null,
      uiMode: 'cosmos',
    });

    const pSidebar = callRoute(patchRoutes, '/api/user/preferences', { sidebarActionsCompact: true });
    expect(pSidebar.statusCode).toBe(200);
    expect(pSidebar.body.sidebarActionsCompact).toBe(true);
    expect(pSidebar.body.cosmosConfig.constants.orbitSpeed).toBe(0.4);
    expect(pSidebar.body.cosmosConfig.planetBindings).toEqual({ 'ag-1': 'jupiter' });

    // Empty planetBindings {} is explicitly valid (clears all custom bindings)
    const pClearBindings = callRoute(patchRoutes, '/api/user/preferences', {
      cosmosConfig: { planetBindings: {} },
    });
    expect(pClearBindings.statusCode).toBe(200);
    expect(pClearBindings.body.cosmosConfig.planetBindings).toEqual({});

    // Strict validation rejects invalid bounds, unknown planets, unsafe prototype keys, non-integer widths, empty patches
    const invalidPayloads = [
      { cosmosConfig: {} },
      { cosmosConfig: { constants: {} } },
      { cosmosConfig: { constants: { orbitSpeed: 9.9 } } },
      { cosmosConfig: { constants: { spinSpeed: 2.6 } } },
      { cosmosConfig: { constants: { planetScale: 0.5 } } },
      { cosmosConfig: { constants: { planetScale: 1.6 } } },
      { cosmosConfig: { constants: { eventScale: 0.4 } } },
      { cosmosConfig: { constants: { eventScale: 1.9 } } },
      { cosmosConfig: { constants: { renderQuality: 'ultra-hd' } } },
      { cosmosConfig: { planetBindings: { 'ag-1': 'pluto' } } },
      { cosmosConfig: { planetBindings: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`a${i}`, 'earth'])) } },
      JSON.parse('{"cosmosConfig":{"planetBindings":{"__proto__":"earth"}}}'),
      JSON.parse('{"cosmosConfig":{"planetBindings":{"constructor":"earth"}}}'),
      JSON.parse('{"cosmosConfig":{"planetBindings":{"prototype":"earth"}}}'),
      JSON.parse('{"cosmosConfig":{"constants":{"__proto__":1}}}'),
      JSON.parse('{"cosmosConfig":{"constants":{"constructor":1}}}'),
      JSON.parse('{"cosmosConfig":{"__proto__":{}}}'),
      { cosmosConfig: { drawerWidth: 100 } },
      { cosmosConfig: { drawerWidth: 1281 } },
      { cosmosConfig: { drawerWidth: 500.5 } },
      { cosmosConfig: { uiMode: 'arcade' } },
      { cosmosConfig: { unknownField: true } },
    ];
    for (const payload of invalidPayloads) {
      const bad = callRoute(patchRoutes, '/api/user/preferences', payload);
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});
