import { readFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { registerInstallerRoutes } from '../../server/routes/installer-routes.js';

const root = resolve(import.meta.dirname, '../..');
const staging = mkdtempSync(join(tmpdir(), 'yeaft-installer-routes-'));
afterAll(() => rmSync(staging, { recursive: true, force: true }));

function createApp(webDir) {
  const app = express();
  registerInstallerRoutes(app, webDir);
  // Exercise the same order as server/index.js: public scripts precede long-lived assets.
  app.use(express.static(webDir, { maxAge: '1y' }));
  return app;
}

describe('public Agent bootstrap downloads', () => {
  for (const file of ['install.sh', 'install.ps1']) {
    it(`serves exact ${file} bytes without authentication, templating or immutable caching`, async () => {
      const expected = readFileSync(join(root, 'web/installers', file), 'utf8');
      const res = await request(createApp(join(root, 'web')))
        .get(`/installers/${file}?secret=not-interpolated`)
        .set('Host', 'untrusted.example');
      expect(res.status).toBe(200);
      expect(res.text).toBe(expected);
      expect(res.text).not.toContain('not-interpolated');
      expect(res.text).not.toContain('untrusted.example');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it(`serves ${file} from an explicitly selected production/custom web root`, async () => {
      const customRoot = join(staging, file);
      mkdirSync(join(customRoot, 'installers'), { recursive: true });
      cpSync(join(root, 'web/installers', file), join(customRoot, 'installers', file));
      const res = await request(createApp(customRoot)).get(`/installers/${file}`);
      expect(res.status).toBe(200);
      expect(res.text).toBe(readFileSync(join(root, 'web/installers', file), 'utf8'));
      expect(res.headers['cache-control']).toBe('no-store');
    });
  }

  it('does not return a successful HTML page when an installer is missing', async () => {
    const res = await request(createApp(staging)).get('/installers/install.sh');
    expect(res.status).toBe(404);
  });

  it('includes both static scripts in frontend and Server image builds', () => {
    const build = readFileSync(join(root, 'web/build.js'), 'utf8');
    const docker = readFileSync(join(root, 'Dockerfile'), 'utf8');
    expect(build).toContain("for (const file of ['install.sh', 'install.ps1'])");
    expect(build).toContain("copyFileSync(join(__dirname, 'installers', file), join(installersDist, file))");
    expect(docker).toContain('COPY web/installers ./installers/');
  });
});
