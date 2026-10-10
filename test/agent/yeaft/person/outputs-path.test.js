import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, openSync: vi.fn(actual.openSync), readSync: vi.fn(actual.readSync) };
});
import * as fs from 'node:fs';
import { outputFilePublicationSupport, snapshotOutput } from '../../../../agent/yeaft/person/outputs.js';

let root, workspace, actual;
beforeEach(async () => {
  actual = await vi.importActual('node:fs');
  root = fs.mkdtempSync(join(tmpdir(), 'person-output-path-')); workspace = join(root, 'workspace');
  fs.mkdirSync(workspace); fs.mkdirSync(join(workspace, 'safe')); fs.mkdirSync(join(root, 'outside'));
  fs.writeFileSync(join(workspace, 'safe', 'file.txt'), 'authorized');
  fs.writeFileSync(join(root, 'outside', 'file.txt'), 'private');
  fs.openSync.mockImplementation(actual.openSync); fs.readSync.mockImplementation(actual.readSync);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });

describe('Output pinned descriptor boundary', () => {
  it('explicitly fails closed if the descriptor filesystem is inaccessible', () => {
    fs.openSync.mockImplementation((path, flags) => {
      if (String(path).startsWith('/proc/self/fd/')) throw new Error('private mount information');
      return actual.openSync(path, flags);
    });
    expect(outputFilePublicationSupport()).toMatchObject({ supported: false, reason: expect.stringContaining('Linux') });
    expect(() => snapshotOutput(workspace, 'safe/file.txt')).toThrow(expect.objectContaining({ code: 'OUTPUT_PLATFORM' }));
    expect(fs.readSync).not.toHaveBeenCalled();
  });

  it('rejects an ancestor replaced with a symlink immediately before that component opens', () => {
    fs.openSync.mockImplementation((path, flags) => {
      if (String(path).endsWith('/safe')) {
        fs.renameSync(join(workspace, 'safe'), join(workspace, 'old'));
        fs.symlinkSync(join(root, 'outside'), join(workspace, 'safe'));
      }
      return actual.openSync(path, flags);
    });
    expect(() => snapshotOutput(workspace, 'safe/file.txt')).toThrow(expect.objectContaining({ code: 'OUTPUT_PATH' }));
    expect(fs.readSync).not.toHaveBeenCalled();
  });

  it('pins an opened ancestor even if its path becomes an escaping symlink before file open', () => {
    fs.openSync.mockImplementation((path, flags) => {
      if (String(path).endsWith('/file.txt')) {
        fs.renameSync(join(workspace, 'safe'), join(workspace, 'old'));
        fs.symlinkSync(join(root, 'outside'), join(workspace, 'safe'));
      }
      return actual.openSync(path, flags);
    });
    // The pinned descriptor opens the original, relocated file. Its changed
    // canonical path fails validation before any bytes (especially private bytes).
    expect(() => snapshotOutput(workspace, 'safe/file.txt')).toThrow(expect.objectContaining({ code: 'OUTPUT_PATH' }));
    expect(fs.readSync).not.toHaveBeenCalled();
  });

  it('rejects final-file symlink substitution immediately before opening without reading it', () => {
    fs.openSync.mockImplementation((path, flags) => {
      if (String(path).endsWith('/file.txt')) {
        fs.unlinkSync(join(workspace, 'safe', 'file.txt'));
        fs.symlinkSync(join(root, 'outside', 'file.txt'), join(workspace, 'safe', 'file.txt'));
      }
      return actual.openSync(path, flags);
    });
    expect(() => snapshotOutput(workspace, 'safe/file.txt')).toThrow(expect.objectContaining({ code: 'OUTPUT_PATH' }));
    expect(fs.readSync).not.toHaveBeenCalled();
  });

  it('never follows a final-file substitution after validation and before fd read', () => {
    let swapped = false;
    fs.readSync.mockImplementation((...args) => {
      if (!swapped) {
        swapped = true;
        fs.renameSync(join(workspace, 'safe', 'file.txt'), join(workspace, 'safe', 'old.txt'));
        fs.symlinkSync(join(root, 'outside', 'file.txt'), join(workspace, 'safe', 'file.txt'));
      }
      return actual.readSync(...args);
    });
    let result;
    try { result = snapshotOutput(workspace, 'safe/file.txt'); }
    catch (error) { expect(error.code).toBe('OUTPUT_PATH'); }
    // Renaming may change ctime (safe rejection) or preserve it (original bytes).
    if (result) expect(result.data.toString()).toBe('authorized');
    expect(fs.readSync).toHaveBeenCalled();
  });
});
