import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { buildUnixUpgradeScript } from '../../agent/connection/upgrade.js';
import { createUnixUpgradeRun, getUnixUpgradeLockPath, shellQuote } from '../../agent/unix-upgrade.js';

const exec = promisify(execFile);
const temporary = [];
const children = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  for (const root of temporary.splice(0)) rmSync(root, { force: true, recursive: true });
});
function fixture(name = 'server-2') {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-unix-upgrade-'));
  temporary.push(root);
  const configDir = join(root, `config '${name}' $safe`);
  const installDir = join(root, 'shared install');
  const bin = join(root, 'bin');
  mkdirSync(join(configDir, 'logs'), { recursive: true });
  mkdirSync(installDir); mkdirSync(bin);
  const run = createUnixUpgradeRun(configDir);
  return { root, configDir, installDir, bin, run };
}
function executable(path, source) {
  writeFileSync(path, `#!/bin/bash\n${source}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}
async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for fixture');
}
function startScript(f, options = {}) {
  const script = buildUnixUpgradeScript({
    pkgName: '@yeaft/webchat-agent', targetVersion: '1.0.900',
    installDir: f.installDir, isGlobalInstall: false, pid: 2147483647,
    configDir: f.configDir, npmPath: join(f.bin, 'npm'), safePath: `${f.bin}:${process.env.PATH}`,
    instanceId: 'server-2', run: f.run, lockPath: getUnixUpgradeLockPath(f.installDir, join(f.root, 'locks')),
    isSystemd: true, ...options,
  });
  writeFileSync(f.run.scriptPath, script);
  writeFileSync(f.run.authorizePath, 'authorized');
  const child = spawn('bash', [f.run.scriptPath], { detached: true, stdio: 'ignore' });
  children.push(child);
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
  return { child, finished };
}

describe('Unix remote upgrade ownership and handoff', () => {
  it.skipIf(process.platform !== 'linux')('serializes two actual shell updaters sharing an install, rejects the loser before handoff, and releases the kernel lock on exit', async () => {
    const f = fixture();
    const entered = join(f.root, 'entered');
    const release = join(f.root, 'release');
    const commands = join(f.root, 'commands');
    executable(join(f.bin, 'systemctl'), `echo "$*" >> ${shellQuote(commands)}`);
    executable(join(f.bin, 'npm'), `echo install >> ${shellQuote(commands)}; touch ${shellQuote(entered)}; while [ ! -f ${shellQuote(release)} ]; do sleep 0.05; done`);
    const first = startScript(f);
    await until(() => existsSync(entered));
    const secondConfig = join(f.root, 'second config');
    mkdirSync(join(secondConfig, 'logs'), { recursive: true });
    const secondRun = createUnixUpgradeRun(secondConfig);
    const second = startScript({ ...f, configDir: secondConfig, run: secondRun });
    expect(await second.finished).toBe(1);
    expect(readFileSync(secondRun.errorPath, 'utf8')).toContain('Another Agent');
    expect(existsSync(secondRun.readyPath)).toBe(false);
    writeFileSync(release, 'release');
    expect(await first.finished).toBe(0);
    expect(readFileSync(commands, 'utf8').match(/^install$/gm)).toHaveLength(1);
    expect(readFileSync(commands, 'utf8')).toContain('--user start yeaft-agent@server-2');
    expect(readFileSync(commands, 'utf8')).not.toContain('daisy');
    const lockPath = getUnixUpgradeLockPath(f.installDir, join(f.root, 'locks'));
    expect((await exec('flock', ['-n', lockPath, '/bin/true'])).stderr).toBe('');
  });

  it.skipIf(process.platform !== 'linux')('does not downgrade an already updated shared package, restarts on npm failure, and refuses cancelled or live-parent installs', async () => {
    for (const mode of ['newer', 'same', 'npm-fail', 'cancelled', 'live-parent']) {
      const f = fixture(mode);
      const commands = join(f.root, 'commands');
      executable(join(f.bin, 'systemctl'), `echo "$*" >> ${shellQuote(commands)}`);
      executable(join(f.bin, 'npm'), `echo install >> ${shellQuote(commands)}; exit 7`);
      if (mode === 'newer' || mode === 'same') {
        const pkg = join(f.installDir, 'node_modules/@yeaft/webchat-agent');
        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: mode === 'same' ? '1.0.900' : '1.0.901' }));
      }
      if (mode === 'cancelled') writeFileSync(f.run.cancelPath, 'cancelled');
      // Make the bounded wait immediate without altering production safety checks.
      if (mode === 'live-parent') executable(join(f.bin, 'sleep'), 'exit 0');
      const { finished } = startScript(f, mode === 'live-parent' ? { pid: process.pid } : {});
      const code = await finished;
      const log = existsSync(commands) ? readFileSync(commands, 'utf8') : '';
      if (mode === 'cancelled' || mode === 'live-parent') {
        expect(code).toBe(1); expect(log).toBe('');
      } else {
        expect(code).toBe(0);
        expect(log).toContain('--user start yeaft-agent@server-2');
        expect(log.includes('install')).toBe(mode === 'npm-fail');
      }
    }
  }, 15_000);

});
