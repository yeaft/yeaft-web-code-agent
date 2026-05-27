#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const serverDir = join(repoRoot, 'server');
const dataDir = mkdtempSync(join(tmpdir(), 'yeaft-server-smoke-'));
const port = 43000 + Math.floor(Math.random() * 1000);
const timeoutMs = 15000;

const child = spawn(process.execPath, ['index.js'], {
  cwd: serverDir,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    SKIP_AUTH: 'true',
    PORT: String(port),
    TEST_DB_DIR: dataDir,
    TEST_DB_PATH: join(dataDir, 'webchat.db'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
let exited = false;
child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
child.on('exit', () => { exited = true; });

async function cleanup() {
  if (!exited) {
    child.kill('SIGTERM');
    await delay(250);
    if (!exited) child.kill('SIGKILL');
  }
  rmSync(dataDir, { recursive: true, force: true });
}

try {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`server exited before becoming healthy\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/version`);
      if (response.ok) {
        const body = await response.json();
        if (body && typeof body.version === 'string') {
          console.log(`Server startup smoke passed on port ${port}.`);
          await cleanup();
          process.exit(0);
        }
      }
      lastError = new Error(`unexpected health response ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms: ${lastError?.message || 'unknown error'}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
} catch (error) {
  console.error(error.message || error);
  await cleanup();
  process.exit(1);
}
