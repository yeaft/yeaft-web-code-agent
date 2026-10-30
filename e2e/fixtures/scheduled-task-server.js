import { test as base } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestServer, getAvailablePort, useTestServer, useMockAgent } from './test-server.js';
import { MockAgent } from './mock-agent.js';

// Each task scenario owns a fresh SQLite directory and ephemeral listen port.
// Disconnected Agents/catalog rows from another case must not alter identity or
// task/recents assertions; never reuse an online service or the developer DB.
export const test = base.extend({
  serverEnv: [{}, { option: true }],
  serverUrl: async ({ serverEnv }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'yeaft-task-browser-'));
    const server = new TestServer(await getAvailablePort());
    Object.assign(server.env, serverEnv, { TEST_DB_DIR: directory });
    try { await useTestServer(server, () => use(server.url)); }
    finally { await rm(directory, { recursive: true, force: true }); }
  },
  mockAgent: async ({ serverUrl }, use) => {
    await useMockAgent(new MockAgent(serverUrl), use);
  },
});
