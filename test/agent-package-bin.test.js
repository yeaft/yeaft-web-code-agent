import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateAgentPackageBins } from '../scripts/check-agent-package-bin.mjs';

const tempDirs = [];

async function createAgentPackage({ target = 'cli.js', contents = '#!/usr/bin/env node\n', mode = 0o755, createTarget = true } = {}) {
  const agentDir = await mkdtemp(join(tmpdir(), 'yeaft-agent-package-'));
  tempDirs.push(agentDir);
  writeFileSync(join(agentDir, 'package.json'), JSON.stringify({ bin: { yeaft: target } }));
  if (createTarget) {
    const targetPath = join(agentDir, target);
    mkdirSync(join(targetPath, '..'), { recursive: true });
    writeFileSync(targetPath, contents);
    chmodSync(targetPath, mode);
  }
  return agentDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Agent package bin validation', () => {
  it('accepts the repository manifest', async () => {
    expect(await validateAgentPackageBins(join(import.meta.dirname, '..', 'agent'))).toEqual([]);
  });

  it('rejects targets without a Node shebang or executable mode', async () => {
    const agentDir = await createAgentPackage({ contents: 'console.log("no shebang");\n', mode: 0o644 });
    await expect(validateAgentPackageBins(agentDir, { platform: 'linux' })).resolves.toEqual([
      'bin["yeaft"] target "cli.js" is not executable',
      'bin["yeaft"] target "cli.js" must start with #!/usr/bin/env node',
    ]);
  });
});
