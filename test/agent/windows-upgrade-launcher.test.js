import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

const { launchWindowsUpgradeScript } = await import('../../agent/connection/upgrade.js');

function mockSpawnSuccess() {
  const child = new EventEmitter();
  child.unref = vi.fn();
  spawnMock.mockReturnValue(child);
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

function mockSpawnError(error) {
  const child = new EventEmitter();
  child.unref = vi.fn();
  spawnMock.mockReturnValue(child);
  queueMicrotask(() => child.emit('error', error));
  return child;
}

describe('launchWindowsUpgradeScript', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('uses wscript.exe when Windows Script Host can launch', async () => {
    const child = mockSpawnSuccess();

    await expect(launchWindowsUpgradeScript({
      vbsPath: 'C:\\Users\\me\\.yeaft\\upgrade.vbs',
      batPath: 'C:\\Users\\me\\.yeaft\\upgrade.bat',
    })).resolves.toBe('VBScript');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith('wscript.exe', ['C:\\Users\\me\\.yeaft\\upgrade.vbs'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('falls back to cmd.exe when wscript.exe is unavailable or blocked', async () => {
    const wscriptError = Object.assign(new Error('spawn Unknown system error -2145452028'), {
      errno: -2145452028,
      code: 'Unknown system error -2145452028',
    });
    const wscriptChild = new EventEmitter();
    wscriptChild.unref = vi.fn();
    const cmdChild = new EventEmitter();
    cmdChild.unref = vi.fn();

    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => wscriptChild.emit('error', wscriptError));
        return wscriptChild;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => cmdChild.emit('spawn'));
        return cmdChild;
      });

    await expect(launchWindowsUpgradeScript({
      vbsPath: 'C:\\Users\\me\\.yeaft\\upgrade.vbs',
      batPath: 'C:\\Users\\me\\.yeaft\\upgrade.bat',
    })).resolves.toBe('cmd.exe');

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenNthCalledWith(1, 'wscript.exe', ['C:\\Users\\me\\.yeaft\\upgrade.vbs'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(spawnMock).toHaveBeenNthCalledWith(2, 'cmd.exe', ['/d', '/s', '/c', '"C:\\Users\\me\\.yeaft\\upgrade.bat"'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(wscriptChild.unref).not.toHaveBeenCalled();
    expect(cmdChild.unref).toHaveBeenCalledTimes(1);
  });
});
