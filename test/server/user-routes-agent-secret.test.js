import { beforeEach, describe, expect, it, vi } from 'vitest';

function createFakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
    put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
    delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); },
  };
}

async function runRoute(app, key, req = {}) {
  const handlers = app.routes.get(key);
  if (!handlers) throw new Error(`Missing route ${key}`);
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const request = { user: { username: 'dev-user', role: 'admin' }, body: {}, headers: {}, ...req };
  let idx = -1;
  const next = async () => {
    idx += 1;
    const handler = handlers[idx];
    if (!handler) return;
    await handler(request, res, next);
  };
  await next();
  return res;
}

describe('user agent secret routes', () => {
  let userDb;
  let registerUserRoutes;

  beforeEach(async () => {
    vi.resetModules();
    userDb = {
      getByUsername: vi.fn(),
      getOrCreate: vi.fn(),
      resetAgentSecret: vi.fn(() => 'agent-secret-generated'),
      getAll: vi.fn(() => []),
    };

    vi.doMock('../../server/config.js', () => ({ CONFIG: { skipAuth: true } }));
    vi.doMock('../../server/database.js', () => ({
      userDb,
      sessionDb: { getByUserId: vi.fn(() => []), deleteByUserId: vi.fn() },
    }));
    vi.doMock('../../server/auth.js', () => ({
      hashPassword: vi.fn(async () => 'hashed-password'),
      verifyPassword: vi.fn(async () => true),
    }));
    vi.doMock('../../server/auth/session-store.js', () => ({
      activeSessions: new Map(),
      revokedTokens: new Set(),
    }));

    ({ registerUserRoutes } = await import('../../server/routes/user-routes.js'));
  });

  function mountRoutes() {
    const app = createFakeApp();
    registerUserRoutes(app, {
      requireAuth: (_req, _res, next) => next(),
      requireAdmin: (_req, _res, next) => next(),
    });
    return app;
  }

  it('generates a per-user Agent secret instead of returning null in skipAuth mode', async () => {
    userDb.getByUsername.mockReturnValue(null);
    userDb.getOrCreate.mockReturnValue({ id: 'u-dev', username: 'dev-user', display_name: 'dev-user' });

    const res = await runRoute(mountRoutes(), 'GET /api/user/agent-secret');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ agentSecret: 'agent-secret-generated' });
    expect(userDb.getOrCreate).toHaveBeenCalledWith('dev-user', 'dev-user');
    expect(userDb.resetAgentSecret).toHaveBeenCalledWith('u-dev');
  });

  it('repairs an existing user with a missing Agent secret', async () => {
    userDb.getByUsername.mockReturnValue({ id: 'u1', username: 'dev-user', agent_secret: null });

    const res = await runRoute(mountRoutes(), 'GET /api/user/agent-secret');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ agentSecret: 'agent-secret-generated' });
    expect(userDb.resetAgentSecret).toHaveBeenCalledWith('u1');
  });

  it('returns an existing Agent secret without rotating it', async () => {
    userDb.getByUsername.mockReturnValue({ id: 'u1', username: 'dev-user', agent_secret: 'agent-secret-existing' });

    const res = await runRoute(mountRoutes(), 'GET /api/user/agent-secret');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ agentSecret: 'agent-secret-existing' });
    expect(userDb.resetAgentSecret).not.toHaveBeenCalled();
  });

  it('resets the current user Agent secret on explicit reset', async () => {
    userDb.getByUsername.mockReturnValue({ id: 'u1', username: 'dev-user', agent_secret: 'old-secret' });
    userDb.resetAgentSecret.mockReturnValue('agent-secret-new');

    const res = await runRoute(mountRoutes(), 'POST /api/user/agent-secret/reset');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ agentSecret: 'agent-secret-new' });
    expect(userDb.resetAgentSecret).toHaveBeenCalledWith('u1');
  });
});
