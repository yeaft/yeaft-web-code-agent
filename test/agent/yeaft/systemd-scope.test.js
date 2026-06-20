import { describe, expect, it } from 'vitest';
import {
  buildSystemdScopeName,
  sanitizeSystemdUnitPart,
  shouldUseSystemdUserScope,
  wrapInvocationInSystemdUserScope,
} from '../../../agent/yeaft/systemd-scope.js';

describe('systemd scope helpers', () => {
  const linuxPlatform = { isLinux: true, isWindows: false, platform: 'linux' };
  const baseEnv = {
    INVOCATION_ID: 'abc',
    XDG_RUNTIME_DIR: '/run/user/1000',
    PATH: '/usr/bin:/bin',
  };

  it('sanitizes unit name parts for transient scope names', () => {
    expect(sanitizeSystemdUnitPart('task foo/bar:baz')).toBe('task-foo-bar-baz');
    expect(buildSystemdScopeName('task foo/bar:baz')).toBe('yeaft-shell-task-foo-bar-baz.scope');
  });

  it('only enables systemd user scopes for Linux services with systemd-run available', () => {
    expect(shouldUseSystemdUserScope({
      runtimePlatform: linuxPlatform,
      env: baseEnv,
      systemdRunPath: '/usr/bin/systemd-run',
    })).toBe(true);

    expect(shouldUseSystemdUserScope({
      runtimePlatform: { isLinux: false, isWindows: false, platform: 'darwin' },
      env: baseEnv,
      systemdRunPath: '/usr/bin/systemd-run',
    })).toBe(false);

    expect(shouldUseSystemdUserScope({
      runtimePlatform: linuxPlatform,
      env: { ...baseEnv, YEAFT_DISABLE_SYSTEMD_SCOPE: '1' },
      systemdRunPath: '/usr/bin/systemd-run',
    })).toBe(false);

    expect(shouldUseSystemdUserScope({
      runtimePlatform: linuxPlatform,
      env: { PATH: '/usr/bin:/bin' },
      systemdRunPath: '/usr/bin/systemd-run',
    })).toBe(false);
  });

  it('wraps shell invocations in systemd-run --user --scope with a stable unit', () => {
    const wrapped = wrapInvocationInSystemdUserScope(
      { command: '/bin/bash', args: ['-c', 'echo ok'], family: 'posix' },
      {
        runtimePlatform: linuxPlatform,
        env: baseEnv,
        scopeId: 'task 123',
        systemdRunPath: '/usr/bin/systemd-run',
      },
    );

    expect(wrapped.command).toBe('/usr/bin/systemd-run');
    expect(wrapped.args).toEqual([
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--unit=yeaft-shell-task-123.scope',
      '/bin/bash',
      '-c',
      'echo ok',
    ]);
    expect(wrapped.systemdScope).toBe('yeaft-shell-task-123.scope');
    expect(wrapped.wrappedCommand).toBe('/bin/bash');
  });

  it('returns the original invocation when scope isolation is unavailable', () => {
    const invocation = { command: '/bin/bash', args: ['-c', 'echo ok'], family: 'posix' };
    const wrapped = wrapInvocationInSystemdUserScope(invocation, {
      runtimePlatform: linuxPlatform,
      env: { PATH: '/usr/bin:/bin' },
      systemdRunPath: '/usr/bin/systemd-run',
    });

    expect(wrapped).toEqual({ ...invocation, systemdScope: null });
  });
});
