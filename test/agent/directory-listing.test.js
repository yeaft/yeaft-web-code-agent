import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import { platform } from 'os';
import { resolve } from 'node:path';
import ctx from '../../agent/context.js';
import { handleListDirectory } from '../../agent/workbench/file-ops.js';

vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal(), execFile: vi.fn() }));
vi.mock('fs', async importOriginal => ({ ...await importOriginal(), existsSync: vi.fn() }));
vi.mock('os', async importOriginal => ({ ...await importOriginal(), platform: vi.fn() }));
vi.mock('fs/promises', async importOriginal => ({
  ...await importOriginal(),
  readdir: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(async () => ({})),
  realpath: vi.fn(async path => path),
}));

const drive = name => ({ name, type: 'directory', size: 0 });
const request = {
  conversationId: '_workdir_picker', directoryPickerScope: 'agent', dirPath: '',
  requestId: 'public-1', _requestUserId: 'user-1', _requestClientId: 'client-1',
  _workbenchRequestId: 'opaque-1',
};
let previousConfig;
let previousSend;

function completeWith(stdout = 'C:\\\r\n', error = null, stderr = '') {
  execFile.mockImplementation((_file, _args, _options, callback) => callback(error, stdout, stderr));
}

beforeEach(() => {
  vi.clearAllMocks();
  execFile.mockReset();
  platform.mockReturnValue('win32');
  readdir.mockResolvedValue([]);
  previousConfig = ctx.CONFIG;
  previousSend = ctx.sendToServer;
  ctx.CONFIG = { workDir: resolve('workspace') };
  ctx.sendToServer = vi.fn();
});

afterEach(() => {
  ctx.CONFIG = previousConfig;
  ctx.sendToServer = previousSend;
});

describe('Workbench directory listing', () => {
  it('queries only fixed drive types asynchronously without probing roots, preserving response ownership', async () => {
    completeWith('Q:\\\r\nC:\\\r\n');
    await handleListDirectory(request);

    expect(execFile).toHaveBeenCalledExactlyOnceWith('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      expect.stringContaining('Where-Object { $_.DriveType -eq [System.IO.DriveType]::Fixed }'),
    ], { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024, encoding: 'utf8' }, expect.any(Function));
    expect(execFile.mock.calls[0][1][4]).toContain("$ErrorActionPreference = 'Stop'");
    expect(execFile.mock.calls[0][1][4]).not.toMatch(/IsReady|Test-Path|Get-ChildItem/);
    expect(existsSync).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
    expect(ctx.sendToServer).toHaveBeenCalledExactlyOnceWith({
      ...request, type: 'directory_listing', entries: [drive('C:'), drive('Q:')],
    });
  });

  it.each(['', 'C:\\\n'])('accepts zero or one fixed drive: %j', async stdout => {
    completeWith(stdout);
    await handleListDirectory(request);
    expect(ctx.sendToServer).toHaveBeenCalledExactlyOnceWith({
      ...request, type: 'directory_listing', entries: stdout ? [drive('C:')] : [],
    });
  });

  it('shares in-flight enumeration while timers run, keeps each route, and refreshes after settlement', async () => {
    let complete;
    execFile.mockImplementation((_file, _args, _options, callback) => { complete = callback; });
    const secondRequest = {
      conversationId: '_workbench:yeaft:agent-1:session-2:files-folder-picker', dirPath: '',
      requestId: 'public-2', _requestUserId: 'user-2', _requestClientId: 'client-2',
      _workbenchRequestId: 'opaque-2', workbenchRouteKey: 'yeaft:agent-1:session-2',
      workbenchWorkspaceGeneration: 'generation-2',
    };
    const first = handleListDirectory(request);
    const second = handleListDirectory(secondRequest);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(ctx.sendToServer).not.toHaveBeenCalled();
    complete(null, 'C:\\\r\n', '');
    await Promise.all([first, second]);
    expect(ctx.sendToServer).toHaveBeenCalledTimes(2);
    for (const source of [request, secondRequest]) {
      expect(ctx.sendToServer).toHaveBeenCalledWith({
        ...source, type: 'directory_listing', entries: [drive('C:')],
      });
    }

    completeWith('Q:\\\r\n');
    await handleListDirectory(request);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(ctx.sendToServer).toHaveBeenLastCalledWith({
      ...request, type: 'directory_listing', entries: [drive('Q:')],
    });
  });

  it.each([
    { error: new Error('spawn powershell.exe ENOENT'), message: 'spawn powershell.exe ENOENT' },
    { error: Object.assign(new Error('Command timed out'), { killed: true }), message: 'Command timed out' },
    { stderr: 'Drive enumeration failed', message: 'Drive enumeration failed' },
    { stdout: 'C:\\\r\nunexpected output\r\n', message: 'Invalid Windows drive listing' },
  ])('reports $message to concurrent callers and permits retry', async ({ error = null, stdout = '', stderr = '', message }) => {
    let complete;
    execFile.mockImplementation((_file, _args, _options, callback) => { complete = callback; });
    const secondRequest = { ...request, requestId: 'public-2', _workbenchRequestId: 'opaque-2' };
    const first = handleListDirectory(request);
    const second = handleListDirectory(secondRequest);
    complete(error, stdout, stderr);
    await Promise.all([first, second]);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(ctx.sendToServer).toHaveBeenCalledTimes(2);
    for (const source of [request, secondRequest]) {
      expect(ctx.sendToServer).toHaveBeenCalledWith({
        ...source, type: 'directory_listing', entries: [], error: message,
      });
    }
    expect(existsSync).not.toHaveBeenCalled();
    completeWith();
    await handleListDirectory(request);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(ctx.sendToServer).toHaveBeenLastCalledWith({
      ...request, type: 'directory_listing', entries: [drive('C:')],
    });
  });

  it.each(['linux', 'darwin'])('preserves %s root browsing without PowerShell', async os => {
    platform.mockReturnValue(os);
    readdir.mockResolvedValue([
      { name: 'usr', isDirectory: () => true },
      { name: 'file.txt', isDirectory: () => false },
      { name: 'node_modules', isDirectory: () => true },
    ]);
    await handleListDirectory(request);
    expect(execFile).not.toHaveBeenCalled();
    expect(readdir).toHaveBeenCalledExactlyOnceWith('/', { withFileTypes: true });
    expect(ctx.sendToServer).toHaveBeenCalledExactlyOnceWith({
      ...request, type: 'directory_listing', dirPath: '/',
      entries: [{ name: 'file.txt', type: 'file', size: 0 }, drive('usr')],
    });
  });

  it.each(['C:\\projects', 'Z:\\projects', '\\\\server\\share\\projects'])('keeps direct path %s browsing without enumeration', async dirPath => {
    readdir.mockResolvedValue([{ name: 'project', isDirectory: () => true }]);
    stat.mockResolvedValue({ size: 123 });
    await handleListDirectory({ ...request, dirPath });
    const resolved = resolve(ctx.CONFIG.workDir, dirPath);
    expect(execFile).not.toHaveBeenCalled();
    expect(existsSync).not.toHaveBeenCalled();
    expect(readdir).toHaveBeenCalledExactlyOnceWith(resolved, { withFileTypes: true });
    expect(ctx.sendToServer).toHaveBeenCalledExactlyOnceWith({
      ...request, type: 'directory_listing', dirPath: resolved,
      entries: [{ name: 'project', type: 'directory', size: 123 }],
    });
  });

  it('keeps empty WorkItem requests in their workspace rather than listing drives', async () => {
    const workDir = ctx.CONFIG.workDir;
    await handleListDirectory({
      ...request, workDir, workbenchRoute: { runtimeProvider: 'work-center' },
    });
    expect(execFile).not.toHaveBeenCalled();
    expect(readdir).toHaveBeenCalledExactlyOnceWith(workDir, { withFileTypes: true });
    expect(ctx.sendToServer).toHaveBeenCalledWith({
      ...request, type: 'directory_listing', dirPath: workDir, entries: [],
    });
  });

  it.skipIf(process.platform !== 'win32')('runs the real bounded Windows PowerShell query', async () => {
    const childProcess = await vi.importActual('node:child_process');
    execFile.mockImplementation(childProcess.execFile);
    await handleListDirectory(request);
    const response = ctx.sendToServer.mock.calls[0][0];
    expect(response).not.toHaveProperty('error');
    expect(response.entries).toEqual(expect.any(Array));
    for (const entry of response.entries) {
      expect(entry).toEqual({ name: expect.stringMatching(/^[A-Za-z]:$/), type: 'directory', size: 0 });
    }
    expect(existsSync).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
  });
});
