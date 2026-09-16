import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLocalRuntime } from '../../agent/scripts/prepare-local-runtime.js';

describe('packaged local runtime', () => {
  it('copies Server cross-boundary Agent dependencies into the runtime tree', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'yeaft-local-runtime-package-'));
    const agentDir = join(rootDir, 'agent');
    const runtimeDir = join(agentDir, 'local-runtime');
    try {
      mkdirSync(join(rootDir, 'server'), { recursive: true });
      mkdirSync(join(rootDir, 'web', 'dist', 'installers'), { recursive: true });
      for (const file of ['install.sh', 'install.ps1']) {
        writeFileSync(join(rootDir, 'web', 'dist', 'installers', file), `bootstrap ${file}\n`);
      }
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(rootDir, 'server', 'index.js'), "import '../agent/container-manager.js';\n");
      writeFileSync(join(rootDir, 'web', 'dist', 'index.html'), '<main>Yeaft</main>');
      writeFileSync(join(agentDir, 'container-manager.js'), 'export const bundled = true;\n');
      writeFileSync(join(agentDir, 'package.json'), JSON.stringify({ version: '1.2.3' }));

      expect(prepareLocalRuntime({ agentDir, rootDir, runtimeDir })).toBe(runtimeDir);
      expect(readFileSync(join(runtimeDir, 'agent', 'container-manager.js'), 'utf8'))
        .toBe('export const bundled = true;\n');
      expect(readFileSync(join(runtimeDir, 'version.json'), 'utf8'))
        .toBe('{"version":"1.2.3"}\n');
      expect(existsSync(join(runtimeDir, 'server', 'index.js'))).toBe(true);
      expect(existsSync(join(runtimeDir, 'web', 'index.html'))).toBe(true);
      for (const file of ['install.sh', 'install.ps1']) {
        expect(readFileSync(join(runtimeDir, 'web', 'installers', file), 'utf8')).toBe(`bootstrap ${file}\n`);
      }
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
