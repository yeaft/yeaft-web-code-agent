import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function createRuntime() {
  return {
    check: vi.fn(async () => ({ serverVersion: '28.5.1' })),
    create: vi.fn(),
    ensureSlice: vi.fn(),
    inspect: vi.fn(async () => ({ exists: false, status: 'absent', running: false })),
    isSliceReady: vi.fn(async () => true),
    remove: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    writeSecret: vi.fn(),
  };
}

function createFakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
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
  const request = { user: { username: 'owner', role: 'pro' }, body: {}, headers: {}, ...req };
  let index = -1;
  const next = async () => {
    index += 1;
    const handler = handlers[index];
    if (handler) await handler(request, res, next);
  };
  await next();
  return res;
}

describe('Sandbox status routes', () => {
  let ContainerAgentService;
  let registerSandboxRoutes;
  let stateDirs;

  beforeEach(async () => {
    stateDirs = [];
    vi.resetModules();
    vi.doMock('../../server/config.js', () => ({
      CONFIG: {
        sandbox: {
          enabled: false,
          image: 'example.test/agent:dev',
          serverUrl: 'wss://example.test',
          stateDir: '/tmp/yeaft-sandbox-test',
        },
      },
    }));
    vi.doMock('../../server/database.js', () => ({
      userDb: {
        getByUsername: vi.fn(),
        getOrCreate: vi.fn(),
        getAgentSecret: vi.fn(),
        resetAgentSecret: vi.fn(),
        isActive: vi.fn(() => true),
      },
    }));
    ({ ContainerAgentService } = await import('../../server/container-agent-service.js'));
    ({ registerSandboxRoutes } = await import('../../server/routes/sandbox-routes.js'));
  });

  afterEach(async () => {
    await Promise.all(stateDirs.map(dir => rm(dir, { recursive: true, force: true })));
  });

  async function createStateDir() {
    const dir = await mkdtemp(join(tmpdir(), 'yeaft-sandbox-route-'));
    stateDirs.push(dir);
    return dir;
  }

  function createUserDb() {
    return {
      getByUsername: vi.fn(() => ({ id: 'user-1', username: 'owner' })),
      getOrCreate: vi.fn(),
      getAgentSecret: vi.fn(),
      resetAgentSecret: vi.fn(),
      isActive: vi.fn(() => true),
    };
  }

  it('rejects lifecycle side effects after the owner becomes inactive', async () => {
    const runtime = createRuntime();
    const sandboxUserDb = createUserDb();
    sandboxUserDb.isActive.mockReturnValue(false);
    const sandboxService = new ContainerAgentService({ enabled: true }, runtime, sandboxUserDb);
    const app = createFakeApp();
    registerSandboxRoutes(app, {
      requireAuth: (_req, _res, next) => next(),
      sandboxService,
      sandboxUserDb,
    });

    const createResponse = await runRoute(app, 'POST /api/sandbox');
    const actionResponse = await runRoute(app, 'POST /api/sandbox/start');

    expect(createResponse).toMatchObject({ statusCode: 409, body: { code: 'SANDBOX_OWNER_INACTIVE' } });
    expect(actionResponse).toMatchObject({ statusCode: 409, body: { code: 'SANDBOX_OWNER_INACTIVE' } });
    expect(runtime.writeSecret).not.toHaveBeenCalled();
    expect(runtime.create).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('serializes an admitted create with owner cleanup and deletion admission', async () => {
    const runtime = createRuntime();
    const stateDir = await createStateDir();
    let releaseCheck;
    const checkBlocked = new Promise(resolve => { releaseCheck = resolve; });
    let checkEntered;
    const checkStarted = new Promise(resolve => { checkEntered = resolve; });
    runtime.check.mockImplementation(async () => {
      checkEntered();
      await checkBlocked;
      return { serverVersion: '28.5.1' };
    });
    runtime.writeSecret.mockImplementation(async (path, secret) => {
      await mkdir(join(stateDir, 'sandbox-user-1'), { recursive: true });
      await writeFile(path, `${secret}\n`);
    });
    const ownerDb = { isActive: vi.fn(() => true) };
    const service = new ContainerAgentService({
      enabled: true,
      stateDir,
      serverUrl: 'wss://example.test',
      image: 'example.test/agent:dev',
    }, runtime, ownerDb);

    const creating = service.create({ id: 'user-1', agent_secret: 'secret' });
    await checkStarted;
    const beginDeletion = vi.fn(() => ({ deletionId: 'deletion-1', status: 'pending' }));
    const deleting = service.prepareOwnerDeletion('user-1', beginDeletion);

    await Promise.resolve();
    expect(beginDeletion).not.toHaveBeenCalled();
    releaseCheck();
    await expect(creating).resolves.toMatchObject({ replayed: false });
    await expect(deleting).resolves.toEqual({ deletionId: 'deletion-1', status: 'pending' });
    expect(runtime.remove).toHaveBeenCalledWith('sandbox-user-1');
    expect(runtime.create.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.remove.mock.invocationCallOrder[0]);
    expect(runtime.remove.mock.invocationCallOrder[0])
      .toBeLessThan(beginDeletion.mock.invocationCallOrder[0]);
  });
});
