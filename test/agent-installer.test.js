import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({args:process.argv.slice(2), secret:process.env.AGENT_SECRET, node:process.execPath})+'\\n');
process.exit(Number(process.env.FIXTURE_CLI_EXIT || 0));`;
function nodeScript(compatible) {
  return `${compatible ? '' : 'if [ "${1:-}" = -e ]; then exit 1; fi\n'}exec ${q(process.execPath)} "$@"`;
}
function npmScript() {
  return `if [ "\${1:-}" = --version ]; then echo 11.0.0; exit 0; fi
printf '%s\\n' "$*" > "$FIXTURE_NPM_LOG"
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
function downloadFixture(f, { badChecksum = false, failDownload = false } = {}) {
  const staging = join(f.root, 'archive-source');
  mkdirSync(join(staging, 'node/bin'), { recursive: true });
  executable(join(staging, 'node/bin/node'), nodeScript(true));
  executable(join(staging, 'node/bin/npm'), npmScript());
  const archive = join(f.root, 'node.tar.gz');
  const packed = spawnSync('/usr/bin/tar', ['-czf', archive, '-C', staging, 'node']);
  expect(packed.status).toBe(0);
  const hash = badChecksum ? '0'.repeat(64) : createHash('sha256').update(readFileSync(archive)).digest('hex');
  const name = `node-v24.9.0-${f.platform === 'Darwin' ? 'darwin' : 'linux'}-${f.arch === 'x86_64' ? 'x64' : 'arm64'}.tar.gz`;
  const sums = join(f.root, 'sums');
  writeFileSync(sums, `${hash}  ${name}\n`);
  executable(join(f.bin, 'curl'), `out=
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then out=$2; shift 2; continue; fi
  url=$1; shift
done
printf '%s\\n' "$url" >> "$FIXTURE_DOWNLOAD_LOG"
${failDownload ? 'exit 22' : `case "$url" in
  */SHASUMS256.txt) cat ${q(sums)} > "$out" ;;
  */v24.9.0/${name}) cat ${q(archive)} > "$out" ;;
  *) exit 23 ;;
esac`}`);
}
function run(f, args = ['--server', 'wss://agent.example', '--secret', 'fixture-secret'], env = {}) {
  return spawnSync('/bin/sh', [installer, ...args], {
    encoding: 'utf8', timeout: 15000,
    env: { HOME: f.home, PATH: f.bin, FIXTURE_LOG: f.log, FIXTURE_NPM_LOG: f.npmLog, FIXTURE_DOWNLOAD_LOG: join(f.root, 'downloads'), ...env },
  });
}
function prefixes(f) { return readdirSync(join(f.home, '.yeaft/installations')).map(name => join(f.home, '.yeaft/installations', name)); }

describe('isolated POSIX Agent installer (no live services or downloads)', () => {
  it('supports help and rejects invalid arguments before writes without printing credentials', () => {
    const f = fixture();
    expect(run(f, ['--help']).status).toBe(0);
    for (const args of [[], ['--server', 'https://invalid', '--secret', 'never-display'], ['--server', 'ws://'], ['never-display'], ['--server', 'wss://valid', '--secret', 'never-display\rnext']]) {
      const r = run(f, args);
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).not.toContain('never-display');
      expect(existsSync(join(f.home, '.yeaft'))).toBe(false);
    }
  });
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
  it('passes the installed-package layout and instance roots into the real Linux service installer', () => {
    const f = fixture();
    const serviceModule = resolve(import.meta.dirname, '../agent/service/index.js');
    executable(join(f.bin, 'npm'), npmScript().replace(cliFixture, `import(${JSON.stringify(serviceModule)}).then(m => m.install(process.argv.slice(2))).catch(() => process.exit(1));`));
    const r = run(f);
    expect(r.status, r.stderr).toBe(0);
    const [prefix] = prefixes(f);
    const name = prefix.split('/').at(-1);
    const config = JSON.parse(readFileSync(join(f.home, '.config/yeaft-agent/instances', name, 'config.json'), 'utf8'));
    expect(config).toMatchObject({ instanceId: name, serverUrl: 'wss://agent.example', agentSecret: 'fixture-secret', yeaftDir: `${prefix}/data`, workDir: `${prefix}/workspace` });
    const unit = readFileSync(join(f.home, `.config/systemd/user/yeaft-agent@${name}.service`), 'utf8');
    expect(unit).toContain(`WorkingDirectory=${prefix}/workspace`);
    expect(unit).toContain(`ExecStart="${process.execPath}"`);
    expect(existsSync(join(prefix, 'data/config.json'))).toBe(true);
  });
  it.each([
    ['old', 'Linux', 'x86_64'], ['missing', 'Linux', 'aarch64'],
    ['missing-npm', 'Darwin', 'x86_64'], ['old', 'Darwin', 'arm64'],
  ])('downloads verified private Node for %s Node on %s/%s', (node, platform, arch) => {
    const f = fixture({ node, platform, arch }); downloadFixture(f);
    const r = run(f);
    expect(r.status, r.stderr).toBe(0);
    const [prefix] = prefixes(f);
    expect(existsSync(join(prefix, 'runtime/bin/node'))).toBe(true);
    expect(existsSync(join(prefix, '.download'))).toBe(false);
    expect(readFileSync(join(f.root, 'downloads'), 'utf8')).toContain('/v24.9.0/node-v24.9.0-');
    expect(existsSync(join(prefix, '.complete'))).toBe(true);
  });
  it.each([{ badChecksum: true }, { failDownload: true }])('cleans only owned incomplete state on download failure (%j)', options => {
    const f = fixture({ node: 'old' }); downloadFixture(f, options);
    const r = run(f);
    expect(r.status).toBe(1);
    expect(prefixes(f)).toEqual([]);
    expect(existsSync(f.npmLog)).toBe(false);
  });
  it.each(['.config/yeaft-agent/instances/test_host-0000', '.yeaft/instances/test_host-0000', '.yeaft/installations/test_host-0000', '.config/systemd/user/yeaft-agent@test_host-0000.service', 'Library/LaunchAgents/com.yeaft.agent.test_host-0000.plist'])('preserves existing identity at %s', path => {
    const f = fixture();
    const existing = join(f.home, path); mkdirSync(existing, { recursive: true }); writeFileSync(join(existing, 'marker'), 'owned');
    rmSync(join(f.bin, 'od')); executable(join(f.bin, 'od'), 'echo 0');
    const r = run(f);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not allocate a unique Agent name');
    expect(readFileSync(join(existing, 'marker'), 'utf8')).toBe('owned');
  });
  it('retains recovery files only after service install attempted and never marks failure complete', () => {
    const f = fixture();
    expect(run(f, undefined, { FIXTURE_NPM_FAIL: '1' }).status).toBe(1);
    expect(prefixes(f)).toEqual([]);
    const r = run(f, undefined, { FIXTURE_CLI_EXIT: '7' });
    expect(r.status).toBe(1);
    const [prefix] = prefixes(f);
    expect(existsSync(join(prefix, '.complete'))).toBe(false);
    expect(existsSync(join(prefix, 'service-install.log'))).toBe(true);
  });
  it.each(['Linux', 'Darwin'])('fails preflight for an unavailable %s user service manager', platform => {
    const f = fixture({ platform });
    expect(run(f, undefined, { FIXTURE_SERVICE_EXIT: '1' }).status).toBe(1);
    expect(existsSync(join(f.home, '.yeaft'))).toBe(false);
  });
});
