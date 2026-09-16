import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getAgentInstallerCommand } from '../web/utils/agentSetup.js';

const installer = resolve('web/installers/install.ps1');
const fixture = resolve('test/fixtures/install-powershell-sandbox.ps1');
const pwsh = process.env.PWSH || 'pwsh';
const powerShellAvailable = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
  encoding: 'utf8',
}).status === 0;
const sandboxes = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function runPowerShell(args) {
  return execFileSync(pwsh, ['-NoLogo', '-NoProfile', ...args], { encoding: 'utf8' });
}

function sandbox() {
  const path = mkdtempSync(join(tmpdir(), 'yeaft-ps-installer-'));
  sandboxes.push(path);
  return path;
}

describe.skipIf(!powerShellAvailable)('Windows bootstrap installer', () => {
  it('parses as PowerShell and exposes help without requiring Windows state', () => {
    const parse = runPowerShell(['-Command',
      `$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${installer.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|% Message;exit 1}`,
    ]);
    expect(parse).toBe('');
    const help = runPowerShell(['-File', installer, '-Help']);
    expect(help).toContain('Usage: install.ps1');
    expect(help).toContain('Node >=22.5.0');
  });

  it.each([
    ['', 'secret', 'valid ws:// or wss:// URL'],
    ['https://example.test', 'secret', 'valid ws:// or wss:// URL'],
    ['ws:///missing-host', 'secret', 'valid ws:// or wss:// URL'],
    ['wss://example.test', '', 'Secret must not be empty'],
    ['wss://example.test', 'bad\nsecret', 'line breaks'],
  ])('rejects invalid input without echoing credentials: %s', (server, secret, message) => {
    const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-File', installer, '-Server', server, '-Secret', secret], {
      encoding: 'utf8',
      env: { ...process.env, APPDATA: join(sandbox(), 'appdata') },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    if (secret) expect(result.stderr).not.toContain(secret);
  });

  it('executes the install flow in a mocked sandbox and preserves sensitive values exactly', () => {
    const secret = 'p&ss%word!$()[]{};`"\' value';
    const server = 'wss://agent.example.test/socket?x=one%20two&y=3';
    const nodePath = process.execPath;
    const output = runPowerShell(['-File', fixture, '-Installer', installer, '-Sandbox', sandbox(), '-Server', server, '-Secret', secret, '-NodePath', nodePath]);
    const result = JSON.parse(output.trim().split(/\r?\n/).at(-1));
    expect(result).toMatchObject({
      aclCalled: true,
      downloaded: false,
      complete: true,
      manager: true,
      secretMatched: true,
      secretInArgs: false,
      serverMatched: true,
      explicitWorkDir: true,
      explicitYeaftDir: true,
      startupAbsoluteNode: true,
      startupAbsolutePm2: true,
      startupTrayPreserved: true,
      pathRestored: true,
      pm2Restored: true,
      startupPrivatePm2: true,
      managerPrivatePath: true,
      upgradeResolvesPm2: true,
      workDirRestored: true,
      yeaftDirRestored: true,
      serverRestored: true,
      secretRestored: true,
    });
  });

  it('executes the generated download command without interpreting credentials and restores TLS', () => {
    const secret = `p&ss' $(); \\" secret`;
    const command = getAgentInstallerCommand({ platform: 'powershell', agentSecret: secret, locationLike: { origin: 'https://control.example', host: 'control.example', protocol: 'https:' } });
    const output = runPowerShell(['-Command', `
$oldTls = [Net.ServicePointManager]::SecurityProtocol
function Invoke-WebRequest { param($Uri, [switch]$UseBasicParsing, $MaximumRedirection, $ErrorAction)
  $global:downloadUri = $Uri
  return @{ Content = 'param($Server, $Secret) $global:captured = @{server=$Server; secret=$Secret}' }
}
${command}
@{ captured = $global:captured; downloadUri = $global:downloadUri; tlsRestored = ([Net.ServicePointManager]::SecurityProtocol -eq $oldTls) } | ConvertTo-Json -Compress
`]);
    const result = JSON.parse(output.trim());
    expect(result).toEqual({ captured: { server: 'wss://control.example', secret }, downloadUri: 'https://control.example/installers/install.ps1', tlsRestored: true });
  });

  it('uses a verified downloaded runtime when Node is absent and cleans checksum failures', () => {
    const output = runPowerShell(['-File', fixture, '-Installer', installer, '-Sandbox', sandbox(), '-Server', 'wss://test.example', '-Secret', 'fake-key', '-NodePath', process.execPath, '-Mode', 'download']);
    expect(JSON.parse(output.trim().split(/\r?\n/).at(-1))).toMatchObject({ complete: true, secretMatched: true, pathRestored: true, pm2Restored: true });
    const root = sandbox();
    const failed = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-File', fixture, '-Installer', installer, '-Sandbox', root, '-Server', 'wss://test.example', '-Secret', 'fake-key', '-NodePath', process.execPath, '-Mode', 'bad-checksum'], { encoding: 'utf8' });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('checksum verification failed');
    expect(readdirSync(join(root, 'home/.yeaft/installations'))).toEqual([]);
    expect(failed.stderr).not.toContain('fake-key');
  });

  it('ignores a foreign npm shim and downloads a paired runtime when the selected Node has no npm CLI', () => {
    const output = runPowerShell(['-File', fixture, '-Installer', installer, '-Sandbox', sandbox(), '-Server', 'wss://test.example', '-Secret', 'fake-key', '-NodePath', process.execPath, '-Mode', 'mismatched-npm']);
    expect(JSON.parse(output.trim().split(/\r?\n/).at(-1))).toMatchObject({ complete: true, downloaded: true, secretMatched: true, pathRestored: true });
  });

  it('uses the published package root and does not pass credentials on the CLI', () => {
    const source = readFileSync(installer, 'utf8');
    expect(source).toContain("node_modules\\@yeaft\\webchat-agent\\cli.js");
    expect(source).not.toMatch(/&\s+\$Node\s+\$Cli\s+install[^\r\n]*(--secret|--server)/);
    expect(source).toContain('& $Node $Cli install --name $Name --yeaft-dir $YeaftDir --work-dir $WorkDir');
  });
});
