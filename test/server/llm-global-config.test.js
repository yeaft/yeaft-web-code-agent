import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let dir;
let mod;
let userDb;
let closeDb;

beforeEach(async () => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'yeaft-server-llm-'));
  process.env.TEST_DB_DIR = dir;
  process.env.TEST_DB_PATH = join(dir, 'webchat.db');
  process.env.JWT_SECRET = 'test-secret';
  mod = await import('../../server/llm-global-config.js');
  const db = await import('../../server/database.js');
  userDb = db.userDb;
  closeDb = db.closeDb;
});

afterEach(() => {
  try { closeDb?.(); } catch {}
  vi.unstubAllGlobals();
  delete process.env.TEST_DB_DIR;
  delete process.env.TEST_DB_PATH;
  delete process.env.JWT_SECRET;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('server global LLM config', () => {
  it('encrypts stored secrets and masks them for web while exposing plaintext to agents', () => {
    const user = userDb.getOrCreate('alice');
    const web = mod.saveGlobalLlmConfigFromWeb(user.id, {
      providers: [{ name: 'p', baseUrl: 'http://p/v1', apiKey: 'secret-key', models: ['m'] }]
    });

    expect(web.providers[0].apiKey).toBe('********');
    expect(web.providers[0].hasSecret).toBe(true);

    const agent = mod.readGlobalLlmConfigForAgent(user.id);
    expect(agent.providers[0].apiKey).toBe('secret-key');
    expect(JSON.stringify(mod.readGlobalLlmConfigForWeb(user.id))).not.toContain('secret-key');
  });

  it('keeps previous secret when web sends a masked value back', () => {
    const user = userDb.getOrCreate('bob');
    mod.saveGlobalLlmConfigFromWeb(user.id, {
      providers: [{ name: 'p', baseUrl: 'http://p/v1', apiKey: 'secret-key', models: ['m'] }]
    });
    mod.saveGlobalLlmConfigFromWeb(user.id, {
      providers: [{ name: 'p', baseUrl: 'http://p/v1', apiKey: '********', models: ['m2'] }]
    });

    const agent = mod.readGlobalLlmConfigForAgent(user.id);
    expect(agent.providers[0].apiKey).toBe('secret-key');
    expect(agent.providers[0].models).toEqual(['m2']);
  });

  it('runs mocked GitHub device start and poll success', async () => {
    const startFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ device_code: 'dev', user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }) }));
    const started = await mod.startGithubDeviceFlow({ fetchFn: startFetch });
    expect(started.deviceCode).toBe('dev');

    const pollFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'gho_token' }) }));
    const polled = await mod.pollGithubDeviceFlow({ deviceCode: 'dev', fetchFn: pollFetch });
    expect(polled.ok).toBe(true);
    expect(polled.provider.type).toBe('github-device');
    expect(polled.provider.githubToken).toBe('gho_token');
  });

  it('reports mocked GitHub authorization pending as non-fatal pending state', async () => {
    const pollFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ error: 'authorization_pending' }) }));
    const result = await mod.pollGithubDeviceFlow({ deviceCode: 'dev', fetchFn: pollFetch });
    expect(result.ok).toBe(false);
    expect(result.pending).toBe(true);
  });
});
