/**
 * Tests for the GitHub Copilot credential provider — every branch of
 * env / disk / gh CLI resolution, token exchange caching, and device flow
 * polling. Network and child_process are stubbed; no real GitHub calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validateRawToken,
  resolveRawToken,
  tryGhCliToken,
  exchangeToken,
  getApiToken,
  copilotRequestHeaders,
  startDeviceFlow,
  pollDeviceFlow,
  runDeviceFlow,
  _resetCacheForTests,
} from '../../agent/unify/llm/credentials/github-copilot.js';

// Stub child_process.execFile via the module the provider uses.
vi.mock('child_process', () => {
  const _impl = { execFile: vi.fn() };
  return {
    execFile: (...args) => _impl.execFile(...args),
    __setExecFileImpl: (fn) => { _impl.execFile = fn; },
  };
});

// Stub fs/promises so disk reads/writes don't touch the real home dir.
vi.mock('fs/promises', () => {
  let _file = null;
  return {
    readFile: vi.fn(async () => {
      if (_file === null) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      return _file;
    }),
    writeFile: vi.fn(async (_path, data) => { _file = data; }),
    mkdir: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ mode: 0o700 })),
    chmod: vi.fn(async () => {}),
    __setFile: (data) => { _file = data; },
    __getFile: () => _file,
    __clearFile: () => { _file = null; },
  };
});

describe('validateRawToken', () => {
  it('rejects empty', () => {
    expect(validateRawToken('').valid).toBe(false);
    expect(validateRawToken('   ').valid).toBe(false);
  });
  it('rejects classic PAT', () => {
    expect(validateRawToken('ghp_abc123').valid).toBe(false);
  });
  it('accepts supported prefixes', () => {
    expect(validateRawToken('gho_xyz').valid).toBe(true);
    expect(validateRawToken('github_pat_aaa').valid).toBe(true);
    expect(validateRawToken('ghu_bbb').valid).toBe(true);
  });
  it('accepts unknown prefix (forward compat)', () => {
    expect(validateRawToken('ghx_new_prefix').valid).toBe(true);
  });
});

describe('resolveRawToken — priority order', () => {
  const ENV_KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
  const saved = {};

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    const fs = await import('fs/promises');
    fs.__clearFile();
    const cp = await import('child_process');
    cp.__setExecFileImpl((_bin, _args, _opts, cb) => cb(new Error('gh not present')));
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns env COPILOT_GITHUB_TOKEN first', async () => {
    process.env.COPILOT_GITHUB_TOKEN = 'gho_aaa';
    process.env.GH_TOKEN = 'gho_bbb';
    const r = await resolveRawToken();
    expect(r).toEqual({ token: 'gho_aaa', source: 'env:COPILOT_GITHUB_TOKEN' });
  });

  it('skips classic PAT in env and falls through', async () => {
    process.env.COPILOT_GITHUB_TOKEN = 'ghp_classic';
    process.env.GH_TOKEN = 'gho_ok';
    const r = await resolveRawToken();
    expect(r).toEqual({ token: 'gho_ok', source: 'env:GH_TOKEN' });
  });

  it('reads persisted disk token when no env', async () => {
    const fs = await import('fs/promises');
    fs.__setFile(JSON.stringify({ token: 'gho_disk', source: 'device-flow' }));
    const r = await resolveRawToken();
    expect(r.token).toBe('gho_disk');
    expect(r.source).toBe('device-flow');
  });

  it('falls back to gh CLI last', async () => {
    const cp = await import('child_process');
    cp.__setExecFileImpl((_bin, _args, _opts, cb) =>
      cb(null, { stdout: 'gho_from_gh\n', stderr: '' }));
    const r = await resolveRawToken();
    expect(r).toEqual({ token: 'gho_from_gh', source: 'gh-cli' });
  });

  it('returns null when nothing works', async () => {
    expect(await resolveRawToken()).toBeNull();
  });
});

describe('tryGhCliToken strips GITHUB_TOKEN/GH_TOKEN from subprocess env', () => {
  it('removes the env vars before invoking gh', async () => {
    process.env.GITHUB_TOKEN = 'should-not-leak';
    process.env.GH_TOKEN = 'should-not-leak-either';
    let observedEnv = null;
    const cp = await import('child_process');
    cp.__setExecFileImpl((_bin, _args, opts, cb) => {
      observedEnv = opts.env;
      cb(null, { stdout: 'gho_clean\n', stderr: '' });
    });
    const tok = await tryGhCliToken();
    expect(tok).toBe('gho_clean');
    expect(observedEnv.GITHUB_TOKEN).toBeUndefined();
    expect(observedEnv.GH_TOKEN).toBeUndefined();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });
});

describe('exchangeToken', () => {
  beforeEach(() => _resetCacheForTests());

  it('returns and caches the api token', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ token: 'tok_xxx', expires_at: Math.floor(Date.now() / 1000) + 1800 }),
      };
    });
    const a = await exchangeToken('gho_raw', { fetchFn });
    expect(a.apiToken).toBe('tok_xxx');
    const b = await exchangeToken('gho_raw', { fetchFn });
    expect(b.apiToken).toBe('tok_xxx');
    expect(calls).toBe(1); // second call served from cache
  });

  it('refreshes when within the refresh margin', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      // expires 60s from now → inside the 120s refresh margin → must refresh
      return {
        ok: true,
        json: async () => ({ token: `tok_${calls}`, expires_at: Math.floor(Date.now() / 1000) + 60 }),
      };
    });
    await exchangeToken('gho_raw', { fetchFn });
    const r = await exchangeToken('gho_raw', { fetchFn });
    expect(r.apiToken).toBe('tok_2');
    expect(calls).toBe(2);
  });

  it('defaults expires_at to +1800s when missing', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: 'tok_no_exp' }), // no expires_at
    }));
    const before = Math.floor(Date.now() / 1000);
    const r = await exchangeToken('gho_raw', { fetchFn });
    expect(r.expiresAt - before).toBeGreaterThanOrEqual(1799);
    expect(r.expiresAt - before).toBeLessThanOrEqual(1801);
  });

  it('throws on non-OK response', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    }));
    await expect(exchangeToken('gho_raw', { fetchFn })).rejects.toThrow(/HTTP 401/);
  });

  it('throws on empty token in response', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: '' }),
    }));
    await expect(exchangeToken('gho_raw', { fetchFn })).rejects.toThrow(/empty token/);
  });
});

describe('getApiToken — falls back to raw token on exchange failure', () => {
  const ENV_KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
  const saved = {};

  beforeEach(async () => {
    _resetCacheForTests();
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.COPILOT_GITHUB_TOKEN = 'gho_raw';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns exchanged token when exchange succeeds', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: 'exch_yyy', expires_at: Math.floor(Date.now() / 1000) + 1800 }),
    }));
    const r = await getApiToken({ fetchFn });
    expect(r).toEqual({ token: 'exch_yyy', source: 'env:COPILOT_GITHUB_TOKEN', exchanged: true });
  });

  it('returns raw token when exchange throws', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'oops' }));
    const r = await getApiToken({ fetchFn });
    expect(r).toEqual({ token: 'gho_raw', source: 'env:COPILOT_GITHUB_TOKEN', exchanged: false });
  });

  it('returns null when no raw token resolvable', async () => {
    delete process.env.COPILOT_GITHUB_TOKEN;
    const cp = await import('child_process');
    cp.__setExecFileImpl((_b, _a, _o, cb) => cb(new Error('no gh')));
    const r = await getApiToken();
    expect(r).toBeNull();
  });
});

describe('copilotRequestHeaders', () => {
  it('has the standard set + agent initiator by default', () => {
    const h = copilotRequestHeaders();
    expect(h['Editor-Version']).toBe('vscode/1.104.1');
    expect(h['Copilot-Integration-Id']).toBe('vscode-chat');
    expect(h['x-initiator']).toBe('agent');
    expect(h['Copilot-Vision-Request']).toBeUndefined();
  });
  it('switches initiator and adds vision header on opt-in', () => {
    const h = copilotRequestHeaders({ isAgentTurn: false, isVision: true });
    expect(h['x-initiator']).toBe('user');
    expect(h['Copilot-Vision-Request']).toBe('true');
  });
});

describe('device flow', () => {
  it('startDeviceFlow returns the user-visible info', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        device_code: 'DEV',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        interval: 5,
        expires_in: 900,
      }),
    }));
    const r = await startDeviceFlow({ fetchFn });
    expect(r).toMatchObject({
      deviceCode: 'DEV',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      interval: 5,
      expiresIn: 900,
    });
  });

  it('pollDeviceFlow surfaces every documented branch', async () => {
    const make = (json) => ({ ok: true, json: async () => json });

    const success = await pollDeviceFlow({ deviceCode: 'DEV', fetchFn: vi.fn(async () => make({ access_token: 'gho_done' })) });
    expect(success).toEqual({ status: 'success', token: 'gho_done' });

    const pending = await pollDeviceFlow({ deviceCode: 'DEV', fetchFn: vi.fn(async () => make({ error: 'authorization_pending' })) });
    expect(pending).toEqual({ status: 'pending' });

    const slow = await pollDeviceFlow({ deviceCode: 'DEV', fetchFn: vi.fn(async () => make({ error: 'slow_down', interval: 11 })) });
    expect(slow).toEqual({ status: 'slow_down', interval: 11 });

    const expired = await pollDeviceFlow({ deviceCode: 'DEV', fetchFn: vi.fn(async () => make({ error: 'expired_token' })) });
    expect(expired).toEqual({ status: 'expired' });

    const denied = await pollDeviceFlow({ deviceCode: 'DEV', fetchFn: vi.fn(async () => make({ error: 'access_denied' })) });
    expect(denied).toEqual({ status: 'denied' });
  });

  it('runDeviceFlow drives start → pending → success and persists', async () => {
    const fs = await import('fs/promises');
    fs.__clearFile();
    let calls = 0;
    const fetchFn = vi.fn(async (url) => {
      if (url.includes('/login/device/code')) {
        return { ok: true, json: async () => ({ device_code: 'DEV', user_code: 'AB-12', verification_uri: 'x', interval: 0, expires_in: 60 }) };
      }
      // access_token endpoint: first call pending, second success
      calls += 1;
      if (calls === 1) return { ok: true, json: async () => ({ error: 'authorization_pending' }) };
      return { ok: true, json: async () => ({ access_token: 'gho_final' }) };
    });
    const onPending = vi.fn();
    const token = await runDeviceFlow({
      onPending,
      fetchFn,
      sleepFn: async () => {}, // no real waiting in tests
    });
    expect(token).toBe('gho_final');
    expect(onPending).toHaveBeenCalledWith({ userCode: 'AB-12', verificationUri: 'x', expiresIn: 60 });
    expect(fs.__getFile()).toContain('gho_final');
  });
});
