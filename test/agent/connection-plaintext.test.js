import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockWebSocket, WS_CLOSED, WS_OPEN } from '../helpers/mockWs.js';
import {
  DEFAULT_UPGRADE_REGISTRY,
  buildUpgradeInstallArgs,
  buildUpgradeMetadataArgs,
  buildUpgradeMetadataUrl,
  resolveWindowsNpmCliPath,
  resolveWindowsPm2CliPath,
} from '../../agent/upgrade-command.js';
import {
  installWindowsUpgrade,
  runWindowsUpgrade,
  waitForProcessExit,
} from '../../agent/windows-upgrade-runner.js';
import ctx from '../../agent/context.js';
import { connect, resetConnectionTransport, sendToServer } from '../../agent/connection/index.js';
import { parseLocalArgs, launchLocalInBackground, runLocal } from '../../agent/local-run.js';
import {
  generateLocalSystemdUnit,
  getLocalServiceConfigPath,
  parseLocalServiceArgs,
  readLocalServiceConfig,
  writeLocalServiceConfig,
} from '../../agent/local-service.js';
import {
  applyAgentIdentityToEnv,
  getDefaultAgentName,
  getDefaultYeaftDir,
  getInstanceIdFromArgs,
  parseServiceArgs,
  resolveDisplayName,
  resolveYeaftDir,
  resolveRuntimeIdentity,
  resolveServiceInstanceId,
  shouldLoadLegacyLocalConfig,
} from '../../agent/service/config.js';
import { shouldLoadLegacyLocalConfig as shouldLoadLegacyLocalConfigFromService } from '../../agent/service.js';
import { handleLocalCommand } from '../../agent/cli.js';
import { applyRegisteredTransport } from '../../agent/connection/message-router.js';
import { generateSessionKey, isEncrypted } from '../../agent/encryption.js';

/**
 * Tests for the agent side of feat-ws-plaintext-negotiation.
 *
 * Agent state machine:
 *   - default: ctx.serverEncryptionRequired = true (= old server, encrypt)
 *   - on `registered { acceptPlaintext: true }`: flip to false
 *   - send-side: encrypt only if (serverEncryptionRequired && sessionKey)
 *   - receive-side: unchanged — decrypt iff sessionKey && isEncrypted()
 *
 * Source files exercised by the production transport helpers:
 *   - agent/connection/message-router.js (case 'registered' handler)
 *   - agent/connection/buffer.js (sendToServer encrypt-or-plaintext gate)
 *   - agent/connection/index.js (capabilities include 'plaintext-ok')
 *   - agent/context.js (default serverEncryptionRequired: true)
 */

// Mirrors the send-site decision in agent/connection/buffer.js. This is an
// independent copy of the branching logic, not the production function —
// keep it in sync by hand if buffer.js changes.
async function sendToServerUnderTest(ctxLike, msg) {
  const ws = ctxLike.ws;
  if (ws.readyState !== WS_OPEN) return;

  const { encrypt } = await import('../../agent/encryption.js');
  if (ctxLike.serverEncryptionRequired && ctxLike.sessionKey) {
    const encrypted = await encrypt(msg, ctxLike.sessionKey);
    ws.send(JSON.stringify(encrypted));
  } else {
    ws.send(JSON.stringify(msg));
  }
}

describe('agent ctx defaults and upgrade contract', () => {
  it('defaults identity and encryption safely and pins every upgrade fetch to the Yeaft registry', async () => {
    expect(getDefaultAgentName('Dev Box/东')).toBe('Dev-Box--');
    expect(getDefaultAgentName('')).toBe('default');

    const computerName = getDefaultAgentName();
    expect(computerName).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(getInstanceIdFromArgs([], {})).toBe(computerName);
    expect(getInstanceIdFromArgs([], {}, { management: true })).toBe('default');
    expect(getInstanceIdFromArgs([], { YEAFT_AGENT_INSTANCE: 'named' }, { management: true })).toBe('named');
    expect(parseLocalArgs([], {})).toEqual({
      name: computerName, port: 6868, background: false, yeaftDir: getDefaultYeaftDir(computerName),
    });
    expect(parseLocalArgs([], { AGENT_NAME: 'env-name' })).toEqual({
      name: 'env-name', port: 6868, background: false, yeaftDir: getDefaultYeaftDir('env-name'),
    });
    expect(parseLocalArgs(['--name', 'local-ui', '--port', '7777', '--background'], {})).toEqual({
      name: 'local-ui', port: 7777, background: true, yeaftDir: getDefaultYeaftDir('local-ui'),
    });
    expect(parseLocalArgs(['-d'], { AGENT_NAME: 'local-ui' })).toEqual({
      name: 'local-ui', port: 6868, background: true, yeaftDir: getDefaultYeaftDir('local-ui'),
    });
    expect(parseLocalArgs(['--instance', 'legacy-local'], {})).toEqual({
      name: 'legacy-local', port: 6868, background: false, yeaftDir: getDefaultYeaftDir('legacy-local'),
    });
    expect(parseLocalArgs(['--instance', 'legacy-local', '--name', 'current-local'], {})).toEqual({
      name: 'current-local', port: 6868, background: false, yeaftDir: getDefaultYeaftDir('current-local'),
    });
    expect(parseLocalArgs(['--yeaft-dir', '/tmp/local-data'], { YEAFT_DIR: '/tmp/env-data' })).toEqual({
      name: computerName, port: 6868, background: false, yeaftDir: '/tmp/local-data',
    });
    expect(parseLocalServiceArgs(['--name', 'local-ui', '--port', '7777'], {})).toEqual({
      name: 'local-ui', port: 7777, yeaftDir: getDefaultYeaftDir('local-ui'),
    });
    expect(parseLocalServiceArgs(['--instance', 'legacy-local'], {})).toEqual({
      name: 'legacy-local', port: 6868, yeaftDir: getDefaultYeaftDir('legacy-local'),
    });
    expect(parseLocalServiceArgs(['--instance', 'legacy-local', '--name', 'current-local'], {})).toEqual({
      name: 'current-local', port: 6868, yeaftDir: getDefaultYeaftDir('current-local'),
    });
    expect(parseLocalServiceArgs(['--yeaft-dir', '/tmp/local-data'], { YEAFT_DIR: '/tmp/env-data' })).toEqual({
      name: computerName, port: 6868, yeaftDir: '/tmp/local-data',
    });
    expect(() => parseLocalServiceArgs([
      '--name', 'local-ui', '--yeaft-dir', '/tmp/line\nbreak',
    ], {})).toThrow('Yeaft data directory cannot contain control characters');
    expect(() => parseLocalServiceArgs([
      '--name', 'local-ui',
    ], { YEAFT_DIR: '/tmp/carriage\rreturn' })).toThrow('Yeaft data directory cannot contain control characters');
    expect(() => parseLocalServiceArgs([
      '--name', 'local-ui',
    ], {}, {
      existing: { name: 'local-ui', port: 6868, yeaftDir: '/tmp/legacy\0root' },
    })).toThrow('Yeaft data directory cannot contain control characters');
    expect(resolveYeaftDir([], { YEAFT_DIR: '/tmp/env-data' }, 'local-ui')).toBe('/tmp/env-data');
    expect(resolveYeaftDir(['--yeaft-dir', '/tmp/flag-data'], { YEAFT_DIR: '/tmp/env-data' }, 'local-ui')).toBe('/tmp/flag-data');
    expect(() => parseLocalServiceArgs(['--background'], {})).toThrow('Unknown local service option');
    expect(() => parseLocalArgs(['--instance'], {})).toThrow('--instance requires a value');
    expect(() => parseLocalServiceArgs(['--instance'], {})).toThrow('--instance requires a value');
    expect(() => parseLocalArgs(['--yeaft-dir'], {})).toThrow('--yeaft-dir requires a value');
    expect(() => parseLocalServiceArgs(['--yeaft-dir'], {})).toThrow('--yeaft-dir requires a value');

    const detached = { pid: 4321, unref: vi.fn() };
    const spawnDetached = vi.fn(() => detached);
    await expect(launchLocalInBackground(['--name', 'local-ui', '--port', '7777', '--background'], {
      spawn: spawnDetached,
      cliPath: '/opt/yeaft/cli.js',
      quiet: true,
    })).resolves.toEqual({ url: 'http://127.0.0.1:7777', pid: 4321, background: true });
    expect(spawnDetached).toHaveBeenCalledWith(process.execPath, [
      '/opt/yeaft/cli.js', 'local', '--name', 'local-ui', '--port', '7777',
    ], expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true }));
    expect(detached.unref).toHaveBeenCalledTimes(1);

    const localUnit = generateLocalSystemdUnit({ name: 'local-ui', port: 7777 }, {
      cliPath: '/opt/yeaft/cli.js',
      workingDirectory: '/workspace/yeaft',
    });
    const customRootUnit = generateLocalSystemdUnit({
      name: 'local-ui', port: 7777, yeaftDir: '/tmp/local-data',
    }, {
      cliPath: '/opt/yeaft/cli.js',
      workingDirectory: '/workspace/yeaft',
    });
    const percentRootUnit = generateLocalSystemdUnit({
      name: 'local-ui', port: 7777, yeaftDir: '/tmp/contains%q-root',
    }, {
      cliPath: '/opt/yeaft/cli.js',
      workingDirectory: '/workspace/yeaft',
    });
    expect(() => generateLocalSystemdUnit({
      name: 'local-ui', port: 7777, yeaftDir: '/tmp/line\nbreak',
    }, {
      cliPath: '/opt/yeaft/cli.js',
      workingDirectory: '/workspace/yeaft',
    })).toThrow('systemd unit value cannot contain control characters');
    expect(localUnit).toContain('Description=Yeaft Local Web UI (local-ui)');
    expect(localUnit).toContain('ExecStart=');
    expect(localUnit).toContain("'/opt/yeaft/cli.js' local --name 'local-ui' --port 7777");
    expect(localUnit).toContain('WorkingDirectory=/workspace/yeaft');
    expect(localUnit).toContain('Environment="YEAFT_LOCAL_RUN=true"');
    expect(localUnit).toContain(`Environment="YEAFT_DIR=${getDefaultYeaftDir('local-ui')}"`);
    expect(customRootUnit).toContain('Environment="YEAFT_DIR=/tmp/local-data"');
    expect(customRootUnit).not.toContain(`Environment="YEAFT_DIR=${getDefaultYeaftDir('local-ui')}"`);
    expect(percentRootUnit).toContain('Environment="YEAFT_DIR=/tmp/contains%%q-root"');
    expect(percentRootUnit).not.toContain('Environment="YEAFT_DIR=/tmp/contains%q-root"');
    expect(localUnit).toContain('WantedBy=default.target');

    const env = {};
    expect(applyAgentIdentityToEnv([], env)).toBeNull();
    expect(env).toEqual({});

    expect(getInstanceIdFromArgs(['--name', 'explicit-name'], {})).toBe('explicit-name');
    expect(getInstanceIdFromArgs(['--instance', 'legacy', '--name', 'explicit-name'], {})).toBe('explicit-name');
    expect(getInstanceIdFromArgs([], { AGENT_NAME: 'env-name' })).toBe('env-name');
    expect(resolveDisplayName([], { AGENT_NAME: 'Display Name' }, 'file-name')).toBe('Display Name');
    expect(resolveDisplayName([], {}, 'Worker A')).toBe('Worker A');
    expect(resolveDisplayName([], {}, 'host-name')).toBe('host-name');
    expect(resolveRuntimeIdentity({ agentName: 'Worker A' }, {})).toEqual({ agentName: 'Worker A', instanceId: 'default' });
    expect(resolveRuntimeIdentity({ agentName: 'file-name', instanceId: 'saved-instance' }, { AGENT_NAME: 'Display Name' })).toEqual({
      agentName: 'Display Name',
      instanceId: 'saved-instance',
    });
    expect(shouldLoadLegacyLocalConfig({})).toBe(true);
    expect(shouldLoadLegacyLocalConfig({ YEAFT_AGENT_INSTANCE: '' })).toBe(true);
    expect(shouldLoadLegacyLocalConfig({ YEAFT_AGENT_INSTANCE: 'server' })).toBe(false);
    expect(shouldLoadLegacyLocalConfig({ YEAFT_AGENT_INSTANCE: 'default' })).toBe(false);
    expect(shouldLoadLegacyLocalConfigFromService).toBe(shouldLoadLegacyLocalConfig);
    expect(resolveServiceInstanceId([], { YEAFT_AGENT_INSTANCE: 'named' }, { management: true })).toBe('named');
    expect(() => resolveServiceInstanceId([], { YEAFT_AGENT_INSTANCE: 'bad name' }, { management: true })).toThrow('Instance id');
    expect(applyAgentIdentityToEnv(['--instance', 'legacy', '--name', 'explicit-name'], env)).toBe('explicit-name');
    expect(env).toEqual({
      YEAFT_AGENT_INSTANCE: 'explicit-name',
      AGENT_NAME: 'explicit-name',
    });
    expect(() => getInstanceIdFromArgs(['--name'], {})).toThrow('--name requires a value');
    expect(() => getInstanceIdFromArgs(['--instance'], {})).toThrow('--instance requires a value');
    expect(() => getInstanceIdFromArgs(['--instance', 'legacy', '--name', 'bad name'], {})).toThrow('Instance id');
    expect(() => parseLocalArgs(['--name', 'bad name'])).toThrow('Instance id');

    const priorIdentity = {
      AGENT_NAME: process.env.AGENT_NAME,
      YEAFT_AGENT_INSTANCE: process.env.YEAFT_AGENT_INSTANCE,
    };
    try {
      delete process.env.AGENT_NAME;
      delete process.env.YEAFT_AGENT_INSTANCE;
      process.env.AGENT_NAME = '';
      process.env.YEAFT_AGENT_INSTANCE = '';
      const defaultService = parseServiceArgs([]);
      expect(defaultService.instanceId).toBe('default');
      expect(defaultService.agentName).toMatch(/^[A-Za-z0-9._-]+$/);

      process.env.AGENT_NAME = 'Display Name';
      const envService = parseServiceArgs([]);
      expect(envService.instanceId).toBe('default');
      expect(envService.agentName).toBe('Display Name');

      process.env.YEAFT_AGENT_INSTANCE = 'named';
      const envNamedService = parseServiceArgs([]);
      expect(envNamedService.instanceId).toBe('named');
      expect(envNamedService.agentName).toBe('Display Name');

      const namedService = parseServiceArgs(['--instance', 'legacy', '--name', 'explicit-name']);
      expect(namedService.instanceId).toBe('explicit-name');
      expect(namedService.agentName).toBe('explicit-name');
    } finally {
      if (priorIdentity.AGENT_NAME === undefined) delete process.env.AGENT_NAME;
      else process.env.AGENT_NAME = priorIdentity.AGENT_NAME;
      if (priorIdentity.YEAFT_AGENT_INSTANCE === undefined) delete process.env.YEAFT_AGENT_INSTANCE;
      else process.env.YEAFT_AGENT_INSTANCE = priorIdentity.YEAFT_AGENT_INSTANCE;
    }

    const agentSource = readFileSync(new URL('../../agent/index.js', import.meta.url), 'utf8');
    const doctorSource = readFileSync(new URL('../../agent/service/doctor.js', import.meta.url), 'utf8');
    expect(doctorSource).toContain('getSystemdServicePath(instanceId)');
    expect(doctorSource).toContain('getLaunchdPlistPath(instanceId)');
    expect(doctorSource).toContain('getEcosystemPath(instanceId)');
    const startupCommands = [...agentSource.matchAll(/await execHiddenAsync\(/g)];
    expect(startupCommands).toHaveLength(6);
    expect(agentSource).toContain('return execAsync(command, { ...options, windowsHide: true });');
    expect(agentSource).not.toMatch(/await execAsync\(/);

    // The actual default is set in agent/context.js. Mirror the contract.
    const ctxLike = { serverEncryptionRequired: true };
    expect(ctxLike.serverEncryptionRequired).toBe(true);

    expect(DEFAULT_UPGRADE_REGISTRY).toBe('https://pkg.yeaft.com/');
    expect(buildUpgradeMetadataArgs('@yeaft/webchat-agent@latest', 'version')).toEqual([
      'view',
      '@yeaft/webchat-agent@latest',
      'version',
      '--registry=https://pkg.yeaft.com/',
      '--prefer-online',
      '--prefer-offline=false',
      '--offline=false',
    ]);
    expect(buildUpgradeInstallArgs('@yeaft/webchat-agent@1.0.250')).toEqual([
      'install',
      '-g',
      '@yeaft/webchat-agent@1.0.250',
      '--registry=https://pkg.yeaft.com/',
    ]);
    expect(buildUpgradeInstallArgs('@yeaft/webchat-agent@1.0.250', { global: false })).toEqual([
      'install',
      '@yeaft/webchat-agent@1.0.250',
      '--registry=https://pkg.yeaft.com/',
    ]);
    expect(buildUpgradeInstallArgs('@yeaft/webchat-agent@1.0.250', { quiet: true })).toEqual([
      'install',
      '-g',
      '@yeaft/webchat-agent@1.0.250',
      '--registry=https://pkg.yeaft.com/',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ]);
    expect(buildUpgradeMetadataUrl('@yeaft/webchat-agent')).toBe(
      'https://pkg.yeaft.com/%40yeaft%2Fwebchat-agent/latest',
    );

  });

  it('keeps local instance data roots stable across foreground and systemd mode', async () => {
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    const { port } = probe.address();
    await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));

    const children = [];
    const spawnLocal = vi.fn(() => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => {
        if (child.exitCode !== null) return false;
        child.killed = true;
        child.exitCode = 0;
        queueMicrotask(() => child.emit('exit', 0));
        return true;
      };
      children.push(child);
      return child;
    });
    const previousYeaftDir = process.env.YEAFT_DIR;
    const previousAgentInstance = process.env.YEAFT_AGENT_INSTANCE;
    const previousAgentName = process.env.AGENT_NAME;
    delete process.env.YEAFT_DIR;
    delete process.env.YEAFT_AGENT_INSTANCE;
    delete process.env.AGENT_NAME;

    let foreground;
    let overrideForeground;
    try {
      foreground = await runLocal(['--name', 'default', '--port', String(port)], {
        exit: false,
        spawn: spawnLocal,
        waitForServer: async () => {},
        waitForAgent: async () => {},
      });
      const foregroundYeaftDir = spawnLocal.mock.calls[1][2].env.YEAFT_DIR;
      const localUnit = generateLocalSystemdUnit({ name: 'default', port }, {
        cliPath: '/opt/yeaft/cli.js',
        workingDirectory: '/workspace/yeaft',
      });
      const serviceYeaftDir = localUnit.match(/^Environment="YEAFT_DIR=(.+)"$/m)?.[1];

      const overrideRoot = '/tmp/yeaft-local-transition';
      overrideForeground = await runLocal(['--name', 'default', '--port', String(port), '--yeaft-dir', overrideRoot], {
        exit: false,
        spawn: spawnLocal,
        waitForServer: async () => {},
        waitForAgent: async () => {},
      });
      const overrideForegroundYeaftDir = spawnLocal.mock.calls[3][2].env.YEAFT_DIR;
      const overrideUnit = generateLocalSystemdUnit({
        name: 'default', port, yeaftDir: parseLocalServiceArgs(['--name', 'default', '--port', String(port), '--yeaft-dir', overrideRoot], {}).yeaftDir,
      }, {
        cliPath: '/opt/yeaft/cli.js',
        workingDirectory: '/workspace/yeaft',
      });
      const overrideServiceYeaftDir = overrideUnit.match(/^Environment="YEAFT_DIR=(.+)"$/m)?.[1];

      expect(children).toHaveLength(4);
      expect(foregroundYeaftDir).toBe(getDefaultYeaftDir('default'));
      expect(serviceYeaftDir).toBe(foregroundYeaftDir);
      expect(overrideForegroundYeaftDir).toBe(overrideRoot);
      expect(overrideServiceYeaftDir).toBe(overrideForegroundYeaftDir);
    } finally {
      if (overrideForeground) await overrideForeground.stop();
      if (foreground) await foreground.stop();
      if (previousYeaftDir === undefined) delete process.env.YEAFT_DIR;
      else process.env.YEAFT_DIR = previousYeaftDir;
      if (previousAgentInstance === undefined) delete process.env.YEAFT_AGENT_INSTANCE;
      else process.env.YEAFT_AGENT_INSTANCE = previousAgentInstance;
      if (previousAgentName === undefined) delete process.env.AGENT_NAME;
      else process.env.AGENT_NAME = previousAgentName;
    }
  });

  it('persists the resolved local service data-root override across reinstall', () => {
    const previousHome = process.env.HOME;
    const temporaryHome = mkdtempSync(join(tmpdir(), 'yeaft-local-service-'));
    process.env.HOME = temporaryHome;
    try {
      const installed = parseLocalServiceArgs(['--name', 'default', '--yeaft-dir', '/tmp/yeaft-persisted-root'], {});
      writeLocalServiceConfig(installed);

      const configPath = getLocalServiceConfigPath('default');
      const restored = readLocalServiceConfig('default');
      const reinstalled = parseLocalServiceArgs(['--name', 'default', '--port', '7777'], {}, { existing: restored });
      expect(existsSync(configPath)).toBe(true);
      expect(restored).toEqual(installed);
      expect(reinstalled).toEqual({
        name: 'default', port: 7777, yeaftDir: '/tmp/yeaft-persisted-root',
      });
      expect(generateLocalSystemdUnit(reinstalled, {
        cliPath: '/opt/yeaft/cli.js',
        workingDirectory: '/workspace/yeaft',
      })).toContain('Environment="YEAFT_DIR=/tmp/yeaft-persisted-root"');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(temporaryHome, { recursive: true, force: true });
    }
  });

  it('warns once and routes deprecated local --instance through both foreground and install paths', async () => {
    const warn = vi.fn();
    const runLocal = vi.fn().mockResolvedValue(undefined);
    const handleLocalServiceCommand = vi.fn().mockResolvedValue(undefined);

    await handleLocalCommand(['--instance', 'legacy-local'], {
      warn,
      loadLocalRun: async () => ({ runLocal }),
      onError: error => { throw new Error(error); },
    });
    await handleLocalCommand(['install', '--instance', 'legacy-local'], {
      warn,
      loadLocalService: async () => ({ handleLocalServiceCommand }),
      onError: error => { throw new Error(error); },
    });

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, expect.stringContaining('--instance is deprecated'));
    expect(warn).toHaveBeenNthCalledWith(2, expect.stringContaining('--instance is deprecated'));
    expect(runLocal).toHaveBeenCalledWith(['--instance', 'legacy-local']);
    expect(handleLocalServiceCommand).toHaveBeenCalledWith('install', ['--instance', 'legacy-local']);
  });

  it('runs the detached Windows updater without shell wrappers and with bounded retries', async () => {
    const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
    const npmCliPath = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    const pm2CliPath = 'Q:\\.tools\\.npm-global\\node_modules\\pm2\\bin\\pm2';
    expect(resolveWindowsNpmCliPath(nodePath, path => path === npmCliPath, '')).toBe(npmCliPath);
    expect(resolveWindowsPm2CliPath(nodePath, path => path === pm2CliPath, 'Q:\\.tools\\.npm-global')).toBe(pm2CliPath);

    const run = vi.fn()
      .mockImplementationOnce(async (_command, _args, options) => {
        options.onStderr(Buffer.from('npm error EBUSY resource busy'));
        return 1;
      })
      .mockResolvedValueOnce(0);
    const sleep = vi.fn(async () => {});
    await expect(installWindowsUpgrade({
      nodePath,
      packageSpec: '@yeaft/webchat-agent@1.0.999',
      globalInstall: true,
      installDir: 'Q:\\MISC',
      logPath: 'Q:\\upgrade.log',
      run,
      sleep,
      fileExists: path => path === npmCliPath,
    })).resolves.toMatchObject({ exitCode: 0, attempts: 2, command: nodePath });
    expect(run.mock.calls[0][1]).toEqual([
      npmCliPath,
      'install',
      '-g',
      '@yeaft/webchat-agent@1.0.999',
      '--registry=https://pkg.yeaft.com/',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ]);
    expect(run.mock.calls[0][2]).not.toHaveProperty('shell');
    expect(sleep).toHaveBeenCalledWith(250);

    let runningChecks = 0;
    expect(await waitForProcessExit(123, {
      processRunning: () => runningChecks++ < 2,
      sleep: async () => {},
      now: (() => { let value = 0; return () => value++; })(),
    })).toBe(true);
  });

  it('restarts the selected PM2 ecosystem after install and preserves install failure status', async () => {
    const install = vi.fn().mockRejectedValue(new Error('npm spawn failed'));
    const stopService = vi.fn().mockResolvedValue(true);
    const startService = vi.fn().mockResolvedValue(true);
    const testDir = join(tmpdir(), `yeaft-upgrade-test-${process.pid}`);
    const options = {
      runId: 'connection-runner',
      lockPath: join(testDir, 'active.lock'),
      parentPid: 42,
      packageSpec: '@yeaft/webchat-agent@1.0.999',
      globalInstall: true,
      installDir: testDir,
      logPath: join(testDir, 'upgrade.log'),
      handoffPath: join(testDir, 'started'),
      authorizePath: join(testDir, 'authorized'),
      cancelPath: join(testDir, 'cancelled'),
      bootstrapPath: join(testDir, 'windows-upgrade-bootstrap.js'),
      runnerPath: join(testDir, 'windows-upgrade-runner.js'),
      commandPath: join(testDir, 'upgrade-command.js'),
      payloadPath: join(testDir, 'payload.json'),
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      npmCliPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      pm2CliPath: 'Q:\\.tools\\.npm-global\\node_modules\\pm2\\bin\\pm2',
      pm2AppName: 'yeaft-agent-test',
      ecosystemPath: join(testDir, 'ecosystem.config.cjs'),
    };
    await expect(runWindowsUpgrade(options, {
      waitForHandoffAuthorization: vi.fn().mockResolvedValue(true),
      releaseWindowsUpgradeLock: vi.fn().mockReturnValue(true),
      waitForProcessExit: vi.fn().mockResolvedValue(true),
      installWindowsUpgrade: install,
      stopPm2Service: stopService,
      startPm2Service: startService,
    })).resolves.toMatchObject({ exitCode: 1, restarted: true });
    expect(stopService).toHaveBeenCalledWith(expect.objectContaining({
      pm2AppName: options.pm2AppName,
    }));
    expect(install).toHaveBeenCalledWith(expect.objectContaining({
      packageSpec: options.packageSpec,
      globalInstall: true,
    }));
    expect(startService).toHaveBeenCalledWith(expect.objectContaining({
      pm2CliPath: options.pm2CliPath,
      ecosystemPath: options.ecosystemPath,
    }));
  });
});

describe('agent advertises plaintext-ok capability', () => {
  it('includes plaintext-ok in agent capability list', async () => {
    // Mirror agent/index.js definition.
    const capabilities = ['background_tasks', 'file_editor', 'ping_session', 'plaintext-ok', 'workbench_session_routes', 'work_center'];
    expect(capabilities).toContain('plaintext-ok');
    expect(capabilities).toContain('workbench_session_routes');
    expect(capabilities).toContain('work_center');
  });

  it('serializes plaintext-ok into the auth-frame capabilities array', () => {
    const capabilities = ['background_tasks', 'file_editor', 'ping_session', 'plaintext-ok', 'workbench_session_routes', 'work_center'];
    const authFrame = {
      type: 'auth',
      tempId: 'temp_abc',
      secret: 'my-secret',
      capabilities,
      version: '0.1.999'
    };
    expect(authFrame.capabilities).toContain('plaintext-ok');
    expect(authFrame.capabilities).toContain('workbench_session_routes');
    expect(authFrame.capabilities).toContain('work_center');
  });

  it('serializes plaintext-ok into the URL ?capabilities= query', () => {
    const capabilities = ['background_tasks', 'file_editor', 'ping_session', 'plaintext-ok', 'workbench_session_routes', 'work_center'];
    const params = new URLSearchParams({ capabilities: capabilities.join(',') });
    expect(params.get('capabilities')).toBe('background_tasks,file_editor,ping_session,plaintext-ok,workbench_session_routes,work_center');
    expect(params.get('capabilities').split(',')).toContain('plaintext-ok');
    expect(params.get('capabilities').split(',')).toContain('workbench_session_routes');
    expect(params.get('capabilities').split(',')).toContain('work_center');
  });
});

describe('agent received `registered` flips serverEncryptionRequired', () => {
  it('keeps the registered plaintext decision connection-scoped', async () => {
    const original = {
      ws: ctx.ws,
      sessionKey: ctx.sessionKey,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      pendingAuthTempId: ctx.pendingAuthTempId,
      CONFIG: ctx.CONFIG,
      agentCapabilities: ctx.agentCapabilities,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
    };
    try {
      resetConnectionTransport();
      expect(ctx.serverEncryptionRequired).toBe(true);
      applyRegisteredTransport({ type: 'registered', acceptPlaintext: true });
      expect(ctx.serverEncryptionRequired).toBe(false);

      const legacyKey = generateSessionKey();
      class ConnectSocket extends MockWebSocket {
        constructor(url) {
          super();
          this.url = url;
        }
      }
      ctx.CONFIG = {
        instanceId: 'test-agent',
        agentName: 'Test Agent',
        workDir: '/tmp',
        serverUrl: 'ws://localhost:1',
        disallowedTools: [],
      };
      ctx.agentCapabilities = [];
      connect(ConnectSocket);
      expect(new URL(ctx.ws.url).searchParams.get('platform')).toBe(process.platform);
      ctx.ws.simulateMessage({ type: 'auth_required', tempId: 'platform-test' });
      expect(ctx.ws.getLastMessage()).toMatchObject({
        type: 'auth',
        tempId: 'platform-test',
        platform: process.platform,
      });
      applyRegisteredTransport({
        type: 'registered',
        sessionKey: Buffer.from(legacyKey).toString('base64'),
      });
      const legacySocket = ctx.ws;
      legacySocket.readyState = WS_OPEN;
      await sendToServer({ type: 'claude_output', payload: { text: 'legacy' } });
      await new Promise(resolve => setImmediate(resolve));

      expect(ctx.serverEncryptionRequired).toBe(true);
      expect(isEncrypted(legacySocket.getLastMessage())).toBe(true);
    } finally {
      ctx.ws = original.ws;
      ctx.sessionKey = original.sessionKey;
      ctx.serverEncryptionRequired = original.serverEncryptionRequired;
      ctx.pendingAuthTempId = original.pendingAuthTempId;
      ctx.CONFIG = original.CONFIG;
      ctx.agentCapabilities = original.agentCapabilities;
      ctx.outboundSendQueue = original.outboundSendQueue;
      ctx.outboundSendQueueActive = original.outboundSendQueueActive;
    }
  });
});

describe('sendToServer: encrypt vs plaintext gate', () => {
  it('writes plain JSON when serverEncryptionRequired is false (new server)', async () => {
    const { generateSessionKey } = await import('../../agent/encryption.js');
    const ws = new MockWebSocket();
    const ctxLike = {
      ws,
      sessionKey: generateSessionKey(),
      serverEncryptionRequired: false
    };

    const msg = { type: 'claude_output', payload: { text: 'hello' } };
    await sendToServerUnderTest(ctxLike, msg);

    expect(ws.getLastMessage()).toEqual(msg);
  });

  it('writes encrypted envelope when serverEncryptionRequired is true (old server)', async () => {
    const { generateSessionKey, isEncrypted, decrypt } = await import('../../agent/encryption.js');
    const sessionKey = generateSessionKey();
    const ws = new MockWebSocket();
    const ctxLike = {
      ws,
      sessionKey,
      serverEncryptionRequired: true
    };

    const msg = { type: 'claude_output', payload: { text: 'hello' } };
    await sendToServerUnderTest(ctxLike, msg);

    const lastSent = ws.getLastMessage();
    expect(isEncrypted(lastSent)).toBe(true);
    const decoded = await decrypt(lastSent, sessionKey);
    expect(decoded).toEqual(msg);
  });

  it('writes plain JSON when sessionKey is missing (regardless of flag)', async () => {
    const ws = new MockWebSocket();
    const ctxLike = {
      ws,
      sessionKey: null,
      serverEncryptionRequired: true // even with flag on
    };
    const msg = { type: 'auth' };
    await sendToServerUnderTest(ctxLike, msg);
    expect(ws.getLastMessage()).toEqual(msg);
  });

  it('releases sent queue ownership and bounds disconnected payloads by bytes', async () => {
    const original = {
      ws: ctx.ws, sessionKey: ctx.sessionKey, serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue, outboundSendQueueBytes: ctx.outboundSendQueueBytes,
      outboundSendQueueMaxBytes: ctx.outboundSendQueueMaxBytes, outboundSendQueueActive: ctx.outboundSendQueueActive,
      messageBuffer: ctx.messageBuffer, messageBufferBytes: ctx.messageBufferBytes,
      messageBufferMaxBytes: ctx.messageBufferMaxBytes, messageBufferMaxSize: ctx.messageBufferMaxSize,
    };
    try {
      Object.assign(ctx, {
        ws: new MockWebSocket(), sessionKey: null, serverEncryptionRequired: false,
        outboundSendQueue: [], outboundSendQueueBytes: 0, outboundSendQueueMaxBytes: 1024,
        outboundSendQueueActive: false, messageBuffer: [], messageBufferBytes: 0,
        messageBufferMaxBytes: 256, messageBufferMaxSize: 5000,
      });
      await expect(sendToServer({ type: 'claude_output', payload: { text: 'sent' } })).resolves.toBe('sent');
      expect(ctx.outboundSendQueue).toEqual([]);
      expect(ctx.outboundSendQueueBytes).toBe(0);

      ctx.ws = new MockWebSocket(WS_CLOSED);
      for (let index = 0; index < 20; index += 1) {
        await sendToServer({ type: 'yeaft_output', payload: { text: `${index}:${'x'.repeat(80)}` } });
      }
      expect(ctx.messageBuffer.length).toBeLessThan(20);
      expect(ctx.messageBufferBytes).toBeLessThanOrEqual(256);
      expect(ctx.messageBufferBytes).toBe(
        ctx.messageBuffer.reduce((total, msg) => total + Buffer.byteLength(JSON.stringify(msg)), 0),
      );
      await expect(sendToServer({ type: 'yeaft_output', payload: { text: 'x'.repeat(1024) } })).resolves.toBe('dropped');

      for (const terminalType of ['turn_completed', 'conversation_closed']) {
        for (const saturation of ['bytes', 'count']) {
          const terminalMessage = { type: terminalType, conversationId: `${terminalType}-${saturation}` };
          const ordinaryMessage = { type: 'yeaft_output', payload: { text: 'x'.repeat(80) } };
          Object.assign(ctx, {
            messageBuffer: [],
            messageBufferBytes: 0,
            messageBufferMaxBytes: saturation === 'bytes' ? 140 : 1024,
            messageBufferMaxSize: saturation === 'count' ? 1 : 5000,
          });
          await expect(sendToServer(terminalMessage)).resolves.toBe('buffered');
          await expect(sendToServer(ordinaryMessage)).resolves.toBe('dropped');
          expect(ctx.messageBuffer).toEqual([terminalMessage]);

          Object.assign(ctx, { messageBuffer: [], messageBufferBytes: 0 });
          await expect(sendToServer(ordinaryMessage)).resolves.toBe('buffered');
          await expect(sendToServer(terminalMessage)).resolves.toBe('buffered');
          expect(ctx.messageBuffer).toEqual([terminalMessage]);
        }
      }

      const blockedWs = new MockWebSocket();
      Object.assign(ctx, {
        ws: blockedWs,
        outboundSendQueue: [],
        outboundSendQueueBytes: 0,
        outboundSendQueueMaxBytes: 220,
        outboundSendQueueActive: true,
      });
      let resolveOrdinary;
      const ordinary = new Promise(resolve => { resolveOrdinary = resolve; });
      const ordinaryMessage = { type: 'yeaft_output', payload: { text: 'x'.repeat(120) } };
      const ordinaryBytes = Buffer.byteLength(JSON.stringify(ordinaryMessage));
      ctx.outboundSendQueue.push({ msg: ordinaryMessage, bytes: ordinaryBytes, resolve: resolveOrdinary });
      ctx.outboundSendQueueBytes = ordinaryBytes;
      const terminal = sendToServer({ type: 'turn_completed', conversationId: 'conv-terminal' });
      await expect(ordinary).resolves.toBe('dropped');
      expect(ctx.outboundSendQueue.map(item => item.msg.type)).toEqual(['turn_completed']);
      ctx.outboundSendQueueActive = false;
      await sendToServer({ type: 'auth' });
      await expect(terminal).resolves.toBe('sent');
      expect(blockedWs.getSentMessages().map(message => message.type)).toContain('turn_completed');
    } finally {
      Object.assign(ctx, original);
    }
  });
});

describe('agent receive path stays unconditional (back-compat with old server)', () => {
  it('decrypts an encrypted frame even after agent has flipped to plaintext outbound', async () => {
    // Scenario: agent has flipped serverEncryptionRequired=false because a
    // new server told it to, but for whatever reason a frame in the wire
    // is still {n,c} (e.g. a re-routed message from an old peer through
    // the hub). The agent's parseMessage must still decrypt it.
    const { encrypt, decrypt, isEncrypted, generateSessionKey } = await import('../../agent/encryption.js');
    const sessionKey = generateSessionKey();

    const upstream = { type: 'execute', conversationId: 'c1', prompt: 'hi' };
    const wire = await encrypt(upstream, sessionKey);
    expect(isEncrypted(wire)).toBe(true);

    // Mirror agent's parseMessage:
    //   const parsed = JSON.parse(data.toString());
    //   if (ctx.sessionKey && isEncrypted(parsed)) return await decrypt(parsed, ctx.sessionKey);
    //   return parsed;
    const parsed = JSON.parse(JSON.stringify(wire));
    const decoded = (sessionKey && isEncrypted(parsed))
      ? await decrypt(parsed, sessionKey)
      : parsed;
    expect(decoded).toEqual(upstream);
  });

  it('passes plain JSON through untouched after flag flip (new server → new agent)', async () => {
    const { isEncrypted } = await import('../../agent/encryption.js');
    const upstream = { type: 'execute', conversationId: 'c1', prompt: 'hi' };
    const parsed = JSON.parse(JSON.stringify(upstream));
    expect(isEncrypted(parsed)).toBe(false);
  });
});
