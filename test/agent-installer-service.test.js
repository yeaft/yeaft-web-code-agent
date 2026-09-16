import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { generateSystemdUnit } from '../agent/service/linux.js';
import { generateLaunchdPlist } from '../agent/service/macos.js';
import { generateEcosystem } from '../agent/service/windows.js';

vi.mock('../agent/service/config.js', () => ({
  DEFAULT_INSTANCE_ID: 'default',
  getServiceName: name => `yeaft-agent@${name}`,
  getLaunchdLabel: name => `com.yeaft.agent.${name}`,
  getPm2AppName: name => `yeaft-agent-${name}`,
  getConfigDir: () => '/home/O\'Brien %data',
  getLogDir: () => '/home/O\'Brien %data/logs',
  getNodePath: () => '/home/O\'Brien %data/$node/bin/node',
  getCliPath: () => '/home/O\'Brien %data/cli.js',
  loadServiceConfig: () => null,
}));

const config = {
  instanceId: 'machine-1234',
  serverUrl: 'wss://server.example/path?first=1&second=2',
  agentName: 'machine-1234',
  agentSecret: '"quoted" & <value> %h $HOME \\ secret',
  workDir: '/home/O\'Brien %data/workspace',
  yeaftDir: '/home/O\'Brien %data/data',
};

describe('installer service configuration escaping', () => {
  it('escapes C strings, systemd specifiers and ExecStart dollar expansions', () => {
    const unit = generateSystemdUnit(config);
    expect(unit).toContain('ExecStart="/home/O\'Brien %%data/$$node/bin/node" "/home/O\'Brien %%data/cli.js"');
    expect(unit).toContain('WorkingDirectory=/home/O\'Brien %%data/workspace');
    expect(unit).toContain('Environment=' + JSON.stringify(`AGENT_SECRET=${config.agentSecret.replaceAll('%', '%%')}`));
    expect(unit).toContain('Environment="YEAFT_DIR=/home/O\'Brien %%data/data"');
    expect(unit).toContain('StandardOutput=append:/home/O\'Brien %%data/logs/out.log');
  });

  it('emits valid launchd XML preserving special characters exactly', () => {
    const plist = generateLaunchdPlist(config);
    expect(plist).toContain('first=1&amp;second=2');
    expect(plist).toContain('&quot;quoted&quot; &amp; &lt;value&gt;');
    // An independent parser catches invalid raw XML that string assertions miss.
    const parsed = spawnSync('python3', ['-c', 'import plistlib,json,sys; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))'], { input: plist, encoding: 'utf8' });
    expect(parsed.status, parsed.stderr).toBe(0);
    const values = JSON.parse(parsed.stdout);
    expect(values.EnvironmentVariables).toMatchObject({ SERVER_URL: config.serverUrl, AGENT_SECRET: config.agentSecret, YEAFT_DIR: config.yeaftDir });
    expect(values.WorkingDirectory).toBe(config.workDir);
  });

  it('emits valid PM2 JavaScript with apostrophes in the runtime path', () => {
    const module = { exports: {} };
    new Function('module', generateEcosystem(config))(module);
    const app = module.exports.apps[0];
    expect(app.script).toBe('/home/O\'Brien %data/cli.js');
    expect(app.interpreter).toContain("O'Brien");
    expect(app.env).toMatchObject({ AGENT_SECRET: config.agentSecret, SERVER_URL: config.serverUrl });
  });
});
