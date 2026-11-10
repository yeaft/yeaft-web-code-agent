import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Playwright CLI grep is intersected with config/project grep, not an override.
// List every logical browser case, including cases outside those execution filters.
const configFile = resolve(process.env.YEAFT_BUDGET_PLAYWRIGHT_CONFIG);
const { default: config } = await import(pathToFileURL(configFile).href);
if (config.shard) throw new Error('Browser budget collection must not be sharded');
const baseDir = dirname(configFile);
const unfiltered = { grep: /.*/, grepInvert: /(?!)/ };
export default {
  ...config,
  ...unfiltered,
  forbidOnly: true,
  testDir: resolve(baseDir, config.testDir || '.'),
  projects: config.projects?.map(project => ({
    ...project,
    ...unfiltered,
    ...(project.testDir ? { testDir: resolve(baseDir, project.testDir) } : {}),
  })),
};
