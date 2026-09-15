import { test as base } from '@playwright/test';
import { spawn } from 'child_process';
import { createServer } from 'node:net';
import { MockAgent } from './mock-agent.js';

const PROJECT_ROOT = process.env.E2E_PROJECT_ROOT || process.cwd();

async function getAvailablePort() {
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

class TestServer {
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

export const test = base.extend({
  serverEnv: [{}, { option: true, scope: 'worker' }],

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
      const compatible = (store?.agents || []).filter(agent => agent.online === true
        && Array.isArray(agent.capabilities)
        && agent.capabilities.includes('work_center'));
      return compatible.length === 1
        && compatible[0].id === agentId
        && compatible[0].status === 'ready';
    }, mockAgent.agentId, { timeout: 10000 });
    await use(page);
  }
});
