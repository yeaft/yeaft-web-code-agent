import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadGroupConfig,
  saveGroupConfig,
  resolveGroupConfig,
  validateGroupConfig,
  ensureGroupConfigFile,
  groupConfigPath,
  GroupConfigError,
} from '../../../../agent/unify/groups/group-config.js';
import { createGroupFromSpec } from '../../../../agent/unify/groups/group-crud.js';

let yeaftDir;

beforeEach(() => {
  yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-group-config-'));
  mkdirSync(join(yeaftDir, 'groups'), { recursive: true });
});

afterEach(() => {
  rmSync(yeaftDir, { recursive: true, force: true });
});

function makeGroup(name = 'Alpha') {
  return createGroupFromSpec(yeaftDir, { name, roster: [] });
}

describe('group-config: loadGroupConfig', () => {
  it('returns {} when the file is missing', () => {
    const { id } = makeGroup();
    expect(loadGroupConfig(yeaftDir, id)).toEqual({});
  });

  it('returns {} when JSON is corrupt', () => {
    const { id } = makeGroup();
    writeFileSync(groupConfigPath(yeaftDir, id), '{not json');
    expect(loadGroupConfig(yeaftDir, id)).toEqual({});
  });

  it('strips unknown keys defensively', () => {
    const { id } = makeGroup();
    writeFileSync(groupConfigPath(yeaftDir, id), JSON.stringify({ model: 'm', stale: 1 }));
    expect(loadGroupConfig(yeaftDir, id)).toEqual({ model: 'm' });
  });
});

describe('group-config: saveGroupConfig', () => {
  it('persists model overrides and trims whitespace', () => {
    const { id } = makeGroup();
    const saved = saveGroupConfig(yeaftDir, id, { model: '  my/m1  ' });
    expect(saved).toEqual({ model: 'my/m1' });
    expect(loadGroupConfig(yeaftDir, id)).toEqual({ model: 'my/m1' });
  });

  it('clearing a field removes it', () => {
    const { id } = makeGroup();
    saveGroupConfig(yeaftDir, id, { model: 'm' });
    const cleared = saveGroupConfig(yeaftDir, id, { model: '' });
    expect(cleared).toEqual({});
  });

  it('throws on unknown keys', () => {
    const { id } = makeGroup();
    expect(() => saveGroupConfig(yeaftDir, id, { primaryModel: 'x' })).toThrow(GroupConfigError);
  });

  it('throws on non-string model', () => {
    const { id } = makeGroup();
    expect(() => saveGroupConfig(yeaftDir, id, { model: 123 })).toThrow(GroupConfigError);
  });
});

describe('group-config: validateGroupConfig', () => {
  it('accepts null/empty input', () => {
    expect(() => validateGroupConfig({})).not.toThrow();
    expect(() => validateGroupConfig(null)).not.toThrow();
    expect(() => validateGroupConfig(undefined)).not.toThrow();
  });

  it('rejects arrays', () => {
    expect(() => validateGroupConfig([])).toThrow(GroupConfigError);
  });

  it('rejects unknown keys', () => {
    expect(() => validateGroupConfig({ foo: 'bar' })).toThrow(GroupConfigError);
  });

  it('allows clearing model with null/empty string', () => {
    expect(() => validateGroupConfig({ model: null })).not.toThrow();
    expect(() => validateGroupConfig({ model: '' })).not.toThrow();
  });
});

describe('group-config: resolveGroupConfig', () => {
  it('falls back to user model when group has no override', () => {
    const user = { model: 'user/m', primaryModel: 'user/m', language: 'en' };
    const resolved = resolveGroupConfig(user, {});
    expect(resolved.model).toBe('user/m');
    expect(resolved.primaryModel).toBe('user/m');
    expect(resolved.language).toBe('en');
  });

  it('group model overrides user model', () => {
    const user = { model: 'user/m', primaryModel: 'user/m', language: 'en' };
    const resolved = resolveGroupConfig(user, { model: 'group/m' });
    expect(resolved.model).toBe('group/m');
    expect(resolved.primaryModel).toBe('group/m');
    expect(resolved.language).toBe('en'); // untouched
  });

  it('does not mutate the user config object', () => {
    const user = { model: 'user/m', primaryModel: 'user/m' };
    resolveGroupConfig(user, { model: 'group/m' });
    expect(user.model).toBe('user/m');
    expect(user.primaryModel).toBe('user/m');
  });

  it('empty / null user config still works', () => {
    const resolved = resolveGroupConfig(null, { model: 'group/m' });
    expect(resolved.model).toBe('group/m');
  });
});

describe('group-config: ensureGroupConfigFile', () => {
  it('writes an empty json when missing', () => {
    const { id } = makeGroup();
    const path = groupConfigPath(yeaftDir, id);
    // createGroupFromSpec doesn't write config.json by default in v1 storage tests,
    // so we exercise the helper directly.
    if (existsSync(path)) rmSync(path);
    ensureGroupConfigFile(yeaftDir, id);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({});
  });

  it('does not overwrite an existing file', () => {
    const { id } = makeGroup();
    saveGroupConfig(yeaftDir, id, { model: 'keep/me' });
    ensureGroupConfigFile(yeaftDir, id);
    expect(loadGroupConfig(yeaftDir, id)).toEqual({ model: 'keep/me' });
  });
});
