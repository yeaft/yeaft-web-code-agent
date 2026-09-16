import { join } from 'node:path';

/**
 * Public, static bootstraps for a machine that has no Agent or browser session yet.
 * No user, Host header or query data is interpolated; credentials stay in CLI arguments.
 * webDir is the same trusted source/dist root used by the Server's static middleware.
 */
export function registerInstallerRoutes(app, webDir) {
  for (const file of ['install.sh', 'install.ps1']) {
    app.get(`/installers/${file}`, (_req, res) => {
      res.set({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.sendFile(join(webDir, 'installers', file), { cacheControl: false });
    });
  }
}
