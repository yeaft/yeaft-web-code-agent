import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  escapePosixArgument,
  escapePowerShellArgument,
  getAgentContainerCommand,
  getAgentInstallerCommand,
  getAgentName,
  getAgentServiceCommand,
} from '../../web/utils/agentSetup.js';

describe('agent setup commands', () => {
  const profile = { username: 'alice', displayName: 'Alice' };
  const locationLike = { protocol: 'https:', host: 'control.example:8443', origin: 'https://control.example:8443' };

  it('builds a POSIX command that downloads completely before execution and safely quotes arguments', () => {
    const command = getAgentInstallerCommand({
      platform: 'posix',
      agentSecret: "secret' $(touch nope)",
      serverWsUrl: "wss://relay.example/a'b",
      locationLike,
    });

    expect(command).toContain("tmp=$(mktemp) && trap 'rm -f \"$tmp\"' EXIT");
    expect(command).toContain("curl -fSL --proto '=https' --proto-redir '=https' --tlsv1.2 'https://control.example:8443/installers/install.sh' -o \"$tmp\" && sh \"$tmp\"");
    expect(command).toContain(`--server ${escapePosixArgument("wss://relay.example/a'b")}`);
    expect(command).toContain(`--secret ${escapePosixArgument("secret' $(touch nope)")}`);
    expect(command.indexOf('curl -fSL')).toBeLessThan(command.indexOf('sh \"$tmp\"'));
    expect(command).not.toContain('?secret=');
    expect(command.split(' -o ')[0]).not.toContain("secret' $(touch nope)");
  });

  it('executes POSIX arguments literally, cleans the download and never runs a partial failed download', () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-one-line-'));
    try {
      const bin = join(root, 'bin'); mkdirSync(bin);
      writeFileSync(join(bin, 'curl'), `#!/bin/sh
printf '%s\\n' "$*" > "$DOWNLOAD_ARGS"
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then out=$2; shift 2; else shift; fi
done
printf '%s' "$out" > "$DOWNLOAD_PATH"
cat > "$out" <<'SCRIPT'
printf '%s\\n' "$@" > "$INSTALL_ARGS"
SCRIPT
exit "\${DOWNLOAD_EXIT:-0}"
`, { mode: 0o755 });
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOWNLOAD_ARGS: join(root, 'download-args'), DOWNLOAD_PATH: join(root, 'download-path'), INSTALL_ARGS: join(root, 'install-args') };
      const secret = `a' $(touch ${root}/injected); \\" token`;
      const command = getAgentInstallerCommand({ agentSecret: secret, locationLike });
      const success = spawnSync('/bin/sh', ['-c', command], { env, encoding: 'utf8' });
      expect(success.status, success.stderr).toBe(0);
      expect(readFileSync(env.INSTALL_ARGS, 'utf8')).toBe(`--server\nwss://control.example:8443\n--secret\n${secret}\n`);
      expect(readFileSync(env.DOWNLOAD_ARGS, 'utf8')).not.toContain(secret);
      expect(existsSync(join(root, 'injected'))).toBe(false);
      expect(existsSync(readFileSync(env.DOWNLOAD_PATH, 'utf8'))).toBe(false);
      rmSync(env.INSTALL_ARGS);
      const failure = spawnSync('/bin/sh', ['-c', command], { env: { ...env, DOWNLOAD_EXIT: '22' }, encoding: 'utf8' });
      expect(failure.status).toBe(22);
      expect(existsSync(env.INSTALL_ARGS)).toBe(false);
      expect(existsSync(readFileSync(env.DOWNLOAD_PATH, 'utf8'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('builds a PowerShell 5.1-compatible full-download command with TLS 1.2 and escaped quotes', () => {
    const command = getAgentInstallerCommand({
      platform: 'powershell',
      agentSecret: "secret'; Write-Host nope",
      serverWsUrl: "wss://relay.example/a'b",
      locationLike,
    });

    expect(command).toContain('[Net.ServicePointManager]::SecurityProtocol = $tls -bor [Net.SecurityProtocolType]::Tls12');
    expect(command).toContain('finally { [Net.ServicePointManager]::SecurityProtocol = $tls }');
    expect(command).toContain("[scriptblock]::Create((Invoke-WebRequest -UseBasicParsing 'https://control.example:8443/installers/install.ps1' -MaximumRedirection 0 -ErrorAction Stop).Content)");
    expect(command).toContain(`-Server ${escapePowerShellArgument("wss://relay.example/a'b")}`);
    expect(command).toContain(`-Secret ${escapePowerShellArgument("secret'; Write-Host nope")}`);
    expect(command.split(').Content')[0]).not.toContain("secret'; Write-Host nope");
  });

  it('uses the browser origin and websocket protocol and returns no command without a secret', () => {
    const command = getAgentInstallerCommand({ agentSecret: 'value', locationLike });
    expect(command).toContain("'https://control.example:8443/installers/install.sh'");
    expect(command).toContain("--server 'wss://control.example:8443'");
    expect(getAgentInstallerCommand({ agentSecret: '', locationLike })).toBe('');
  });

  it('renders a container install command with the secret passed as an argument', () => {
    const command = getAgentContainerCommand({
      profile,
      agentSecret: 'secret-abc',
      serverWsUrl: 'wss://example.test',
    });
    expect(command).toBe(
      `yeaft-agent container install --server wss://example.test --secret secret-abc --name ${getAgentName(profile)}`,
    );
    expect(command).not.toContain('--secret-file');
  });

  it('derives the same agent name as the service command', () => {
    const service = getAgentServiceCommand({ profile, agentSecret: 'secret-abc', serverWsUrl: 'wss://example.test' });
    const container = getAgentContainerCommand({ profile, agentSecret: 'secret-abc', serverWsUrl: 'wss://example.test' });
    expect(service.split('--name ')[1]).toBe(container.split('--name ')[1]);
  });

  it('returns an empty command until a secret exists', () => {
    expect(getAgentContainerCommand({ profile, agentSecret: '', serverWsUrl: 'wss://example.test' })).toBe('');
  });
});
