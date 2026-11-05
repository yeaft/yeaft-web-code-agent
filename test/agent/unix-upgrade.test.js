import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import ctx from '../../agent/context.js';
import { sendToServer } from '../../agent/connection/buffer.js';
import { buildUnixUpgradeScript } from '../../agent/connection/upgrade.js';
import { createUnixUpgradeRun, getUnixUpgradeLockPath, launchUnixUpgrade, shellQuote } from '../../agent/unix-upgrade.js';

const exec = promisify(execFile);
const temporary = [];
const children = [];
const units = [];
const runner = resolve(import.meta.dirname, '../../agent/yeaft/systemd-service-runner.js');
afterEach(async () => {
  for (const child of children.splice(0)) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  for (const unit of units.splice(0)) {
    try { await exec('systemctl', ['--user', 'stop', unit]); } catch {}
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
  it('keys the kernel lock by canonical shared install rather than instance, while separate installs stay independent', () => {
    const f = fixture();
    const alias = join(f.root, 'alias');
    const other = join(f.root, 'other');
    mkdirSync(other); symlinkSync(f.installDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const locks = join(f.root, 'locks');
    expect(getUnixUpgradeLockPath(alias, locks)).toBe(getUnixUpgradeLockPath(f.installDir, locks));
    expect(getUnixUpgradeLockPath(other, locks)).not.toBe(getUnixUpgradeLockPath(f.installDir, locks));
    expect(shellQuote(`O'Brien $safe`)).toBe(`'O'\\''Brien $safe'`);
  });

  it('starts a distinct exec-type transient service and acknowledges only after a live ready owner, without exposing env in argv', async () => {
    const f = fixture();
    const previousWs = ctx.ws;
    const previousEncryption = ctx.serverEncryptionRequired;
    const socket = new EventEmitter();
    socket.readyState = 1;
    let completed = false;
    socket.send = (data, callback) => {
      expect(existsSync(f.run.authorizePath)).toBe(false);
      expect(JSON.parse(data).type).toBe('upgrade_agent_ack');
      setTimeout(() => { completed = true; callback(); }, 20);
    };
    ctx.ws = socket; ctx.serverEncryptionRequired = false;
    const ack = vi.fn(async payload => {
      const outcome = await sendToServer({ type: 'upgrade_agent_ack', ...payload });
      expect(completed).toBe(true);
      setTimeout(() => writeFileSync(f.run.acceptedPath, 'accepted'), 10);
      return outcome;
    });
    const calls = [];
    const fakeExec = async (command, args) => {
      calls.push({ command, args });
      const payload = JSON.parse(readFileSync(args.at(-1), 'utf8'));
      expect(payload.env.AGENT_SECRET).toBe('private-test-secret');
      expect(payload.cwd).toBe(f.run.dir);
      expect(args.join(' ')).not.toContain('private-test-secret');
      expect(existsSync(f.run.authorizePath)).toBe(false);
      writeFileSync(f.run.readyPath, String(process.pid));
    };
    let result;
    try {
      result = await launchUnixUpgrade({
        run: f.run, instanceId: 'server-2', isSystemd: true, serviceRunnerPath: runner,
        env: { PATH: process.env.PATH, AGENT_SECRET: 'private-test-secret' },
        sendUpgradeAck: ack, version: '1.0.900',
      }, { execFileAsync: fakeExec });
    } finally { ctx.ws = previousWs; ctx.serverEncryptionRequired = previousEncryption; }
    expect(calls[0].command).toBe('systemd-run');
    expect(calls[0].args).toEqual(expect.arrayContaining(['--user', '--collect', '--service-type=exec']));
    expect(calls[0].args).not.toContain('--scope');
    expect(result.unit).toMatch(/^yeaft-upgrade-server-2-.*\.service$/);
    expect(ack).toHaveBeenCalledOnce();
    expect(existsSync(f.run.authorizePath)).toBe(true);
  });

  it('keeps the Agent online on launch, lock, readiness and ACK failures, cancelling late runners without a detached fallback', async () => {
    for (const failure of ['launch', 'lock', 'timeout', 'dead', 'ack', 'dropped', 'slow-ack', 'lost-runner', 'no-accept']) {
      const f = fixture(failure);
      let alive = failure !== 'dead';
      const ack = vi.fn(async () => {
        if (failure === 'ack') throw new Error('ack failed');
        if (failure === 'dropped') return 'dropped';
        if (failure === 'slow-ack') await new Promise(() => {});
        if (failure === 'lost-runner') alive = false;
        return 'sent';
      });
      const spawnProcess = vi.fn();
      const calls = [];
      const fakeExec = async (command, args) => {
        calls.push({ command, args });
        if (command === 'systemctl') return;
        if (failure === 'launch') throw new Error('manager unavailable');
        if (failure === 'lock') writeFileSync(f.run.errorPath, 'Another Agent is upgrading this shared installation');
        if (!['launch', 'lock', 'timeout'].includes(failure)) writeFileSync(f.run.readyPath, String(process.pid));
      };
      await expect(launchUnixUpgrade({
        run: f.run, instanceId: 'server-2', isSystemd: true, serviceRunnerPath: runner,
        sendUpgradeAck: ack, version: '1.0.900', timeoutMs: 65,
      }, { execFileAsync: fakeExec, spawn: spawnProcess, processRunning: () => alive })).rejects.toThrow();
      expect(existsSync(f.run.authorizePath)).toBe(failure === 'no-accept');
      expect(existsSync(f.run.cancelPath)).toBe(true);
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(calls.at(-1).args.slice(0, 2)).toEqual(['--user', 'stop']);
      if (['launch', 'lock', 'timeout', 'dead'].includes(failure)) expect(ack).not.toHaveBeenCalled();
    }
  });

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

  it.skipIf(process.platform !== 'linux' || process.env.YEAFT_TEST_SYSTEMD_UPGRADE !== '1')('survives real KillMode=mixed Agent-service exit in a different cgroup (isolated fixture only)', async () => {
    const f = fixture();
    const parentUnit = `yeaft-upgrade-test-parent-${process.pid}-${Date.now()}.service`;
    units.push(parentUnit);
    const launcher = join(f.root, 'parent.mjs');
    const launched = join(f.root, 'launched.json');
    const survived = join(f.root, 'survived');
    const cgroup = join(f.root, 'updater.cgroup');
    const helperUrl = new URL('../../agent/unix-upgrade.js', import.meta.url).href;
    writeFileSync(f.run.scriptPath, `#!/bin/bash\necho $$ > ${shellQuote(f.run.readyPath)}\nwhile [ ! -f ${shellQuote(f.run.authorizePath)} ]; do sleep 0.05; done\ntouch ${shellQuote(f.run.acceptedPath)}\nsleep 1\ncat /proc/self/cgroup > ${shellQuote(cgroup)}\ntouch ${shellQuote(survived)}\n`);
    writeFileSync(launcher, `import {launchUnixUpgrade} from ${JSON.stringify(helperUrl)}; import fs from 'node:fs'; const result = await launchUnixUpgrade({run:${JSON.stringify(f.run)},instanceId:'fixture',isSystemd:true,serviceRunnerPath:${JSON.stringify(runner)},sendUpgradeAck:async()=> 'sent',version:'fixture'}); fs.writeFileSync(${JSON.stringify(launched)},JSON.stringify(result));`);
    await exec('systemd-run', ['--user', '--quiet', '--collect', '--service-type=exec', `--unit=${parentUnit}`, '--property=KillMode=mixed', '--property=TimeoutStopSec=1', '--', process.execPath, launcher]);
    await until(() => existsSync(launched));
    const { unit } = JSON.parse(readFileSync(launched, 'utf8'));
    units.push(unit);
    await until(() => existsSync(survived));
    expect(readFileSync(cgroup, 'utf8')).toContain(unit);
    expect(readFileSync(cgroup, 'utf8')).not.toContain(parentUnit);
    expect(existsSync(join(f.run.dir, 'invocation'))).toBe(false);
  }, 15_000);
});
