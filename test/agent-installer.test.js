import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const installer = resolve(import.meta.dirname, '../web/installers/install.sh');
const temporaryDirectories = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const q = value => `'${value.replaceAll("'", `'"'"'`)}'`;
function executable(path, source) {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${source}\n`);
  chmodSync(path, 0o755);
}
const cliFixture = `const fs = require('node:fs');
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({args:process.argv.slice(2), secret:process.env.AGENT_SECRET, node:process.execPath, cuda:process.env.ONNXRUNTIME_NODE_INSTALL_CUDA ?? null})+'\\n');
process.exit(Number(process.env.FIXTURE_CLI_EXIT || 0));`;
function nodeScript(compatible) {
  return `${compatible ? '' : 'if [ "${1:-}" = -e ]; then exit 1; fi\n'}exec ${q(process.execPath)} "$@"`;
}
function npmScript() {
  return `if [ "\${1:-}" = --version ]; then echo 11.0.0; exit 0; fi
printf '%s\\n' "$*" > "$FIXTURE_NPM_LOG"
printf '%s' "\${ONNXRUNTIME_NODE_INSTALL_CUDA:-}" > "$FIXTURE_NPM_LOG.cuda"
[ "\${FIXTURE_NPM_FAIL:-0}" = 0 ] || exit 2
[ "$1" = --prefix ] || exit 3
prefix=$2
mkdir -p "$prefix/lib/node_modules/@yeaft/webchat-agent"
cat > "$prefix/lib/node_modules/@yeaft/webchat-agent/cli.js" <<'JS'
${cliFixture}
JS`;
}
function fixture({ node = 'valid', platform = 'Linux', arch = 'x86_64', spaces = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-installer-'));
  temporaryDirectories.push(root);
  const home = join(root, spaces ? "O'Brien home $safe" : 'home');
  const bin = join(root, 'bin');
  mkdirSync(home); mkdirSync(bin);
  for (const command of ['dirname', 'sed', 'tr', 'cut', 'od', 'awk', 'mkdir', 'rm', 'cat', 'chmod', 'tar', 'gzip', 'sha256sum', 'id']) {
    const system = spawnSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(system, join(bin, command));
  }
  executable(join(bin, 'uname'), `if [ "\${1:-}" = -s ]; then echo ${platform}; else echo ${arch}; fi`);
  executable(join(bin, 'hostname'), 'echo Test_Host');
  executable(join(bin, 'systemctl'), '[ "${1:-}" = --user ] || exit 2; exit "${FIXTURE_SERVICE_EXIT:-0}"');
  executable(join(bin, 'launchctl'), '[ "${1:-}" = print ] || exit 2; exit "${FIXTURE_SERVICE_EXIT:-0}"');
  if (node !== 'missing') executable(join(bin, 'node'), nodeScript(node === 'valid'));
  if (node !== 'missing-npm') executable(join(bin, 'npm'), npmScript());
  return { root, home, bin, platform, arch, log: join(root, 'commands.jsonl'), npmLog: join(root, 'npm.log') };
}

function run(f, args = ['--server', 'wss://agent.example', '--secret', 'fixture-secret'], env = {}) {
  return spawnSync('/bin/sh', [installer, ...args], {
    encoding: 'utf8', timeout: 15000,
    env: { HOME: f.home, PATH: f.bin, FIXTURE_LOG: f.log, FIXTURE_NPM_LOG: f.npmLog, FIXTURE_DOWNLOAD_LOG: join(f.root, 'downloads'), ...env },
  });
}
function prefixes(f) { return readdirSync(join(f.home, '.yeaft/installations')).map(name => join(f.home, '.yeaft/installations', name)); }

describe('isolated POSIX Agent installer (no live services or downloads)', () => {
  it('reuses Node/npm, isolates prefix/config, keeps secret out of CLI arguments and prints a working wrapper', () => {
    const f = fixture({ spaces: true });
    const secret = `a'"$;&secret`;
    const r = run(f, ['--server', 'wss://agent.example', '--secret', secret], { WORK_DIR: '/unrelated', YEAFT_DIR: '/unrelated' });
    expect(r.status, r.stderr).toBe(0);
    const [prefix] = prefixes(f);
    expect(prefix).toMatch(/test_host-\d{4}$/);
    expect(statSync(prefix).mode & 0o777).toBe(0o700);
    expect(existsSync(join(prefix, '.complete'))).toBe(true);
    expect(readFileSync(f.npmLog, 'utf8')).toContain('--global install @yeaft/webchat-agent@latest --registry=https://pkg.yeaft.com/');
    const call = JSON.parse(readFileSync(f.log, 'utf8'));
    expect(call.secret).toBe(secret);
    expect(call.args).not.toContain(secret);
    expect(call.args).toEqual(['install', '--server', 'wss://agent.example', '--name', prefix.split('/').at(-1), '--yeaft-dir', `${prefix}/data`, '--work-dir', `${prefix}/workspace`]);
    const wrapper = readFileSync(join(prefix, 'management-command'), 'utf8').trim();
    const status = spawnSync(wrapper, ['status', '--name', 'test-instance'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', FIXTURE_LOG: f.log } });
    expect(status.status, status.stderr).toBe(0);
    const upgrade = spawnSync(wrapper, ['upgrade'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', FIXTURE_LOG: f.log } });
    expect(upgrade.status).toBe(1);
    expect(upgrade.stderr).toContain('Web UI');
    expect(r.stdout + r.stderr).not.toContain(secret);
  });

});
