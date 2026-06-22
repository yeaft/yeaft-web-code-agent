import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';

// Regression test for the UI-triggered self-upgrade leaving a *named* instance
// permanently offline. Root cause: the generated upgrade.sh hardcoded the
// systemd unit / launchd plist as the bare `yeaft-agent` default, so a named
// instance (e.g. `server-e7a9eb`) installed the new package but its real unit
// `yeaft-agent@server-e7a9eb` was never restarted.

const HOME = '/home/tester';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    homedir: () => HOME,
    // default platform = linux; individual tests override via the isDarwin arg
    platform: () => 'linux',
  };
});

// existsSync drives systemd/launchd detection. A real host has exactly ONE
// service manager, so the mock answers by path family: systemd unit files vs
// launchd plists. `serviceManager` selects which family "exists" per test.
let serviceManager = 'systemd';
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn((p) => {
      const path = String(p);
      if (path.includes('/systemd/user/')) return serviceManager === 'systemd' || serviceManager === 'both';
      if (path.includes('/LaunchAgents/')) return serviceManager === 'launchd' || serviceManager === 'both';
      return false;
    }),
  };
});

const { buildUnixUpgradeScript, resolveInstanceId } = await import('../../agent/connection/upgrade.js');
const { default: ctx } = await import('../../agent/context.js');

const BASE = {
  pkgName: '@yeaft/webchat-agent',
  installDir: '/opt/agent',
  isGlobalInstall: true,
  pid: 4242,
  configDir: `${HOME}/.config/yeaft-agent/instances/server-e7a9eb`,
  npmPath: '/usr/bin/npm',
  safePath: '/usr/bin:/bin',
};

describe('buildUnixUpgradeScript — instance-aware service restart', () => {
  beforeEach(() => { vi.clearAllMocks(); serviceManager = 'systemd'; });
  afterEach(() => vi.clearAllMocks());

  it('targets the templated systemd unit for a named instance', () => {
    const script = buildUnixUpgradeScript({ ...BASE, instanceId: 'server-e7a9eb' });
    // Both stop (pre-install) and start (post-install) must hit the @instance unit.
    expect(script).toContain('systemctl --user stop "yeaft-agent@server-e7a9eb"');
    expect(script).toContain('systemctl --user start "yeaft-agent@server-e7a9eb"');
    // And must NOT fall back to the bare default unit.
    expect(script).not.toContain('systemctl --user start "yeaft-agent"');
    expect(script).not.toMatch(/systemctl --user start yeaft-agent(?!@)/);
  });

  it('targets the bare unit for the default instance (back-compat)', () => {
    const script = buildUnixUpgradeScript({ ...BASE, instanceId: 'default' });
    expect(script).toContain('systemctl --user stop "yeaft-agent"');
    expect(script).toContain('systemctl --user start "yeaft-agent"');
    expect(script).not.toContain('yeaft-agent@');
  });

  it('omitting instanceId behaves like the default instance', () => {
    const script = buildUnixUpgradeScript({ ...BASE });
    expect(script).toContain('systemctl --user start "yeaft-agent"');
    expect(script).not.toContain('yeaft-agent@');
  });

  it('checks the correct templated unit-file path for systemd detection', () => {
    buildUnixUpgradeScript({ ...BASE, instanceId: 'server-e7a9eb' });
    const checked = existsSync.mock.calls.map((c) => c[0]);
    expect(checked).toContain(
      `${HOME}/.config/systemd/user/yeaft-agent@server-e7a9eb.service`,
    );
  });

  it('targets the instance-scoped launchd label/plist on macOS', () => {
    serviceManager = 'launchd';
    const script = buildUnixUpgradeScript({
      ...BASE,
      instanceId: 'server-e7a9eb',
      isDarwin: true,
    });
    const plist = `${HOME}/Library/LaunchAgents/com.yeaft.agent.server-e7a9eb.plist`;
    expect(script).toContain(`launchctl unload "${plist}"`);
    expect(script).toContain(`launchctl load "${plist}"`);
    expect(script).not.toContain('com.yeaft.agent.plist');
  });

  it('still installs the package and writes the version-agnostic body', () => {
    const script = buildUnixUpgradeScript({ ...BASE, instanceId: 'server-e7a9eb' });
    expect(script).toContain('"$NPM" install -g "$PKG"');
    expect(script).toContain('PID=4242');
    expect(script).toMatch(/^#!\/bin\/bash/);
  });

  it('prefers systemd when both managers somehow look present', () => {
    // existsSync answers true for BOTH families this once; the systemd branch
    // must win and no launchctl line should leak into the script.
    serviceManager = 'both';
    const script = buildUnixUpgradeScript({
      ...BASE,
      instanceId: 'server-e7a9eb',
      isDarwin: true,
    });
    expect(script).toContain('systemctl --user start "yeaft-agent@server-e7a9eb"');
    expect(script).not.toContain('launchctl');
  });
});

describe('resolveInstanceId — pinned instance resolution', () => {
  const OLD_ENV = { ...process.env };
  const OLD_CONFIG = ctx.CONFIG;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.YEAFT_AGENT_INSTANCE;
    ctx.CONFIG = null;
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
    ctx.CONFIG = OLD_CONFIG;
  });

  it('prefers ctx.CONFIG.instanceId (the validated single source of truth)', () => {
    ctx.CONFIG = { instanceId: 'server-e7a9eb' };
    process.env.YEAFT_AGENT_INSTANCE = 'env-loser';
    expect(resolveInstanceId()).toBe('server-e7a9eb');
  });

  it('falls back to YEAFT_AGENT_INSTANCE when CONFIG is not yet loaded', () => {
    ctx.CONFIG = null;
    process.env.YEAFT_AGENT_INSTANCE = 'from-env';
    expect(resolveInstanceId()).toBe('from-env');
  });

  it('falls back to the default instance when nothing is set', () => {
    expect(resolveInstanceId()).toBe('default');
  });
});
