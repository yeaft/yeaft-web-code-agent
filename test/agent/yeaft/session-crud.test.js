import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createSessionFromSpec, SessionCrudError } from '../../../agent/yeaft/sessions/session-crud.js';

const roots = [];

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('session CRUD storage errors', () => {
  it('surfaces an explicit error when the workdir session root cannot be created', () => {
    const yeaftDir = tempRoot('yeaft-session-crud-default-');
    const workDir = tempRoot('yeaft-session-crud-workdir-');
    writeFileSync(join(workDir, '.yeaft'), 'not a directory');

    expect(() => createSessionFromSpec(yeaftDir, {
      name: 'Blocked Workdir',
      roster: ['omni'],
      defaultVpId: 'omni',
      workDir,
    })).toThrow(SessionCrudError);

    try {
      createSessionFromSpec(yeaftDir, {
        name: 'Blocked Workdir',
        roster: ['omni'],
        defaultVpId: 'omni',
        workDir,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(SessionCrudError);
      expect(err.code).toBe('workdir_not_writable');
      expect(err.message).toContain(join(workDir, '.yeaft', 'sessions'));
      return;
    }
    throw new Error('expected createSessionFromSpec to fail');
  });
});
