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

  it('pins XDG_RUNTIME_DIR / DBUS so detached `systemctl --user` can reach the user manager', () => {
    // Root cause of the post-upgrade "stays offline" bug: the detached shell
    // may not inherit XDG_RUNTIME_DIR, so `systemctl --user` fails to connect
    // to the bus and the restart silently never runs. The script must pin
    // per-user defaults (keeping any inherited value).
    const script = buildUnixUpgradeScript({ ...BASE, instanceId: 'server-e7a9eb' });
    expect(script).toContain('export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$YEAFT_UID}"');
    expect(script).toContain('export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$YEAFT_UID/bus}"');
    // Env pin must precede the systemctl calls that depend on it.
    expect(script.indexOf('XDG_RUNTIME_DIR')).toBeLessThan(script.indexOf('systemctl --user stop'));
  });

  it('logs and retries a failed systemd restart instead of failing silently', () => {
    const script = buildUnixUpgradeScript({ ...BASE, instanceId: 'server-e7a9eb' });
    // start wrapped in if/else so a failure is observable in the log...
    expect(script).toMatch(/if systemctl --user start "yeaft-agent@server-e7a9eb"; then/);
    expect(script).toContain('retrying after reload');
    // ...and a terminal failure tells the operator exactly how to recover.
    expect(script).toContain('Manual start required: systemctl --user start yeaft-agent@server-e7a9eb');
  });

  it('does NOT leak systemd env/restart scaffolding into the launchd branch', () => {
    serviceManager = 'launchd';
    const script = buildUnixUpgradeScript({
      ...BASE,
      instanceId: 'server-e7a9eb',
      isDarwin: true,
    });
    // launchd reaches its manager via Mach bootstrap, not these env vars —
    // injecting them would be dead weight and risks masking real issues.
    expect(script).not.toContain('XDG_RUNTIME_DIR');
    expect(script).not.toContain('DBUS_SESSION_BUS_ADDRESS');
    expect(script).not.toContain('systemctl');
    expect(script).not.toContain('retrying after reload');
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

// String-containment asserts can't catch a dropped `fi` or an unbalanced quote.
// Run the generated script through `bash -n` (parse only, never execute) so the
// added if/else restart scaffolding is held to "syntactically valid", not just
// "contains the right substrings". Platform-independent: bash -n needs no
// systemd/launchd present.
describe('buildUnixUpgradeScript — generated shell is syntactically valid', () => {
  const realFs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');

  let hasBash = true;
  try { execFileSync('bash', ['-c', 'true']); } catch { hasBash = false; }

  const check = (script) => {
    const file = path.join(os.tmpdir(), `yeaft-upgrade-bashn-${process.pid}-${Math.floor(performance.now())}.sh`);
    realFs.writeFileSync(file, script);
    try {
      execFileSync('bash', ['-n', file]); // throws on syntax error
    } finally {
      realFs.rmSync(file, { force: true });
    }
  };

  beforeEach(() => { serviceManager = 'systemd'; });

  it.skipIf(!hasBash)('systemd branch (named instance) parses cleanly', () => {
    expect(() => check(buildUnixUpgradeScript({ ...BASE, instanceId: 'server-e7a9eb' }))).not.toThrow();
  });

  it.skipIf(!hasBash)('systemd branch (default instance) parses cleanly', () => {
    expect(() => check(buildUnixUpgradeScript({ ...BASE, instanceId: 'default' }))).not.toThrow();
  });

  it.skipIf(!hasBash)('launchd branch parses cleanly', () => {
    serviceManager = 'launchd';
    expect(() => check(buildUnixUpgradeScript({ ...BASE, instanceId: 'server-e7a9eb', isDarwin: true }))).not.toThrow();
  });

  it.skipIf(!hasBash)('local (non-global) install variant parses cleanly', () => {
    expect(() => check(buildUnixUpgradeScript({ ...BASE, instanceId: 'server-e7a9eb', isGlobalInstall: false }))).not.toThrow();
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
