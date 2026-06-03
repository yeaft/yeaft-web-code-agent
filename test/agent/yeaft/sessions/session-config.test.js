import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadSessionConfig,
  saveSessionConfig,
  resolveSessionConfig,
  validateSessionConfig,
  ensureSessionConfigFile,
  sessionConfigPath,
  SessionConfigError,
} from '../../../../agent/yeaft/sessions/session-config.js';
import { createSessionFromSpec } from '../../../../agent/yeaft/sessions/session-crud.js';

let yeaftDir;

beforeEach(() => {
  yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-group-config-'));
  mkdirSync(join(yeaftDir, 'sessions'), { recursive: true });
});

afterEach(() => {
  rmSync(yeaftDir, { recursive: true, force: true });
});

function makeGroup(name = 'Alpha') {
  return createSessionFromSpec(yeaftDir, { name, roster: [] });
}

describe('group-config: loadSessionConfig', () => {
  it('returns {} when the file is missing', () => {
    const { id } = makeGroup();
    expect(loadSessionConfig(yeaftDir, id)).toEqual({});
  });

  it('returns {} when JSON is corrupt', () => {
    const { id } = makeGroup();
    writeFileSync(sessionConfigPath(yeaftDir, id), '{not json');
    expect(loadSessionConfig(yeaftDir, id)).toEqual({});
  });

  it('strips unknown keys defensively', () => {
    const { id } = makeGroup();
    writeFileSync(sessionConfigPath(yeaftDir, id), JSON.stringify({ model: 'm', stale: 1 }));
    expect(loadSessionConfig(yeaftDir, id)).toEqual({ model: 'm' });
  });
});

describe('group-config: saveSessionConfig', () => {
  it('persists model overrides and trims whitespace', () => {
    const { id } = makeGroup();
    const saved = saveSessionConfig(yeaftDir, id, { model: '  my/m1  ' });
    expect(saved).toEqual({ model: 'my/m1' });
    expect(loadSessionConfig(yeaftDir, id)).toEqual({ model: 'my/m1' });
  });

  it('clearing a field removes it', () => {
    const { id } = makeGroup();
    saveSessionConfig(yeaftDir, id, { model: 'm' });
    const cleared = saveSessionConfig(yeaftDir, id, { model: '' });
    expect(cleared).toEqual({});
  });

  it('throws on unknown keys', () => {
    const { id } = makeGroup();
    expect(() => saveSessionConfig(yeaftDir, id, { primaryModel: 'x' })).toThrow(SessionConfigError);
  });

  it('throws on non-string model', () => {
    const { id } = makeGroup();
    expect(() => saveSessionConfig(yeaftDir, id, { model: 123 })).toThrow(SessionConfigError);
  });
});

describe('group-config: validateSessionConfig', () => {
  it('accepts null/empty input', () => {
    expect(() => validateSessionConfig({})).not.toThrow();
    expect(() => validateSessionConfig(null)).not.toThrow();
    expect(() => validateSessionConfig(undefined)).not.toThrow();
  });

  it('rejects arrays', () => {
    expect(() => validateSessionConfig([])).toThrow(SessionConfigError);
  });

  it('rejects unknown keys', () => {
    expect(() => validateSessionConfig({ foo: 'bar' })).toThrow(SessionConfigError);
  });

  it('allows clearing model with null/empty string', () => {
    expect(() => validateSessionConfig({ model: null })).not.toThrow();
    expect(() => validateSessionConfig({ model: '' })).not.toThrow();
  });
});

describe('group-config: resolveSessionConfig', () => {
  it('falls back to user model when group has no override', () => {
    const user = { model: 'user/m', primaryModel: 'user/m', language: 'en' };
    const resolved = resolveSessionConfig(user, {});
    expect(resolved.model).toBe('user/m');
    expect(resolved.primaryModel).toBe('user/m');
    expect(resolved.language).toBe('en');
  });

  it('group model overrides user model', () => {
    const user = { model: 'user/m', primaryModel: 'user/m', language: 'en' };
    const resolved = resolveSessionConfig(user, { model: 'group/m' });
    expect(resolved.model).toBe('group/m');
    expect(resolved.primaryModel).toBe('group/m');
    expect(resolved.language).toBe('en'); // untouched
  });

  it('does not mutate the user config object', () => {
    const user = { model: 'user/m', primaryModel: 'user/m' };
    resolveSessionConfig(user, { model: 'group/m' });
    expect(user.model).toBe('user/m');
    expect(user.primaryModel).toBe('user/m');
  });

  it('empty / null user config still works', () => {
    const resolved = resolveSessionConfig(null, { model: 'group/m' });
    expect(resolved.model).toBe('group/m');
  });
});

describe('group-config: ensureSessionConfigFile', () => {
  it('writes an empty json when missing', () => {
    const { id } = makeGroup();
    const path = sessionConfigPath(yeaftDir, id);
    // createSessionFromSpec doesn't write config.json by default in v1 storage tests,
    // so we exercise the helper directly.
    if (existsSync(path)) rmSync(path);
    ensureSessionConfigFile(yeaftDir, id);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({});
  });

  it('does not overwrite an existing file', () => {
    const { id } = makeGroup();
    saveSessionConfig(yeaftDir, id, { model: 'keep/me' });
    ensureSessionConfigFile(yeaftDir, id);
    expect(loadSessionConfig(yeaftDir, id)).toEqual({ model: 'keep/me' });
  });
});
