import { test as base } from '@playwright/test';
import { spawn } from 'child_process';
import { createServer } from 'node:net';
import { MockAgent } from './mock-agent.js';

const PROJECT_ROOT = process.env.E2E_PROJECT_ROOT || process.cwd();

export async function getAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!port) throw new Error('Failed to allocate E2E server port');
  return port;
}

export async function useTestServer(server, use) {
  try {
    await server.start();
    await use(server);
  } finally {
    await server.stop();
  }
}

export async function useMockAgent(agent, use) {
  try {
    await agent.connect();
    await use(agent);
  } finally {
    await agent.disconnect();
  }
}

export class TestServer {
  constructor(port) {
    this.port = port;
    this.process = null;
    this.url = `http://localhost:${port}`;
    this.env = {
      ...process.env,
      PORT: String(port),
      SKIP_AUTH: 'true',
      SANDBOX_ENABLED: 'false',
      BROWSER_RUNTIME_ENABLED: 'true',
      NODE_ENV: 'test',
      TEST_DB_DIR: `/tmp/e2e-test-${port}`
    };
  }

  async start() {
    this.process = spawn('node', ['server/index.js'], {
      cwd: PROJECT_ROOT,
      env: this.env,
      stdio: 'pipe'
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 20000);
      this.process.stdout.on('data', (data) => {
        if (data.toString().includes('Server running on')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      this.process.stderr.on('data', (data) => {
        const text = data.toString();
        if (text.includes('EADDRINUSE')) {
          clearTimeout(timeout);
          reject(new Error(`Port ${this.port} already in use`));
        }
      });
      this.process.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      this.process.on('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited before startup (code=${code}, signal=${signal || 'none'})`));
      });
    });
  }

  async kill() {
    if (this.process) {
      this.process.kill('SIGKILL');
      await new Promise(resolve => this.process.on('exit', resolve));
      this.process = null;
    }
  }

  async restart() {
    await this.kill();
    await this.start();
  }

  async stop() {
    if (!this.process) return;
    const process = this.process;
    this.process = null;
    if (process.exitCode !== null || process.signalCode !== null) return;
    let exitResolve;
    const exitPromise = new Promise(resolve => { exitResolve = resolve; });
    process.once('exit', exitResolve);
    process.kill('SIGTERM');
    const exited = await Promise.race([
      exitPromise.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 5000)),
    ]);
    if (!exited && process.exitCode === null && process.signalCode === null) {
      process.kill('SIGKILL');
      await exitPromise;
    }
  }
}

// Existing E2E suites assert classic sidebar/chat selectors; pass `uiMode: null`
// in Cosmos E2E tests to exercise the default first-run Cosmos landing experience.
export const UI_MODE_FIXTURES = {
  uiMode: ['classic', { option: true, scope: 'worker' }],

  browser: [async ({ browser, uiMode }, use) => {
    if (!uiMode) {
      await use(browser);
      return;
    }
    const origNewContext = browser.newContext.bind(browser);
    const wrapped = new Proxy(browser, {
      get(target, prop, receiver) {
        if (prop === 'newContext') {
          return async (...args) => {
            const ctx = await origNewContext(...args);
            await ctx.addInitScript((mode) => {
              try {
                if (!window.localStorage.getItem('yeaft-ui-mode')) {
                  window.localStorage.setItem('yeaft-ui-mode', mode);
                }
              } catch { /* ignore */ }
            }, uiMode);
            return ctx;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await use(wrapped);
  }, { scope: 'worker' }],

  page: async ({ page, uiMode }, use) => {
    if (uiMode) {
      await page.addInitScript((mode) => {
        try {
          if (!window.localStorage.getItem('yeaft-ui-mode')) {
            window.localStorage.setItem('yeaft-ui-mode', mode);
          }
        } catch { /* ignore */ }
      }, uiMode);
    }
    await use(page);
  },
};

export const test = base.extend({
  serverEnv: [{}, { option: true, scope: 'worker' }],
  ...UI_MODE_FIXTURES,

  testServer: [async ({ serverEnv }, use) => {
    const port = await getAvailablePort();
    const server = new TestServer(port);
    Object.assign(server.env, serverEnv);
    await useTestServer(server, use);
  }, { scope: 'worker' }],

  serverUrl: async ({ testServer }, use) => {
    await use(testServer.url);
  },

  mockAgent: [async ({ serverUrl }, use) => {
    const agent = new MockAgent(serverUrl);
    await useMockAgent(agent, use);
  }, { scope: 'test' }],

  chatPage: async ({ page, serverUrl, mockAgent }, use) => {
    await page.goto(serverUrl);
    await page.waitForSelector('.chat-page', { timeout: 10000 });
    await page.waitForSelector('.brand-label', { timeout: 5000 });
    await page.waitForFunction(agentId => {
      const store = window.Pinia?.useChatStore?.();
      return (store?.agents || []).some(agent => agent.id === agentId
        && agent.online === true && agent.status === 'ready');
    }, mockAgent.agentId, { timeout: 10000 });
    await use(page);
  }
});
