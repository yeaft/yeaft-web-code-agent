import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const DREAM_PROMPTS = [
  'yeaft/dream/prompts/triage-pass1.md',
  'yeaft/dream/prompts/triage-pass2.md',
  'yeaft/dream/prompts/update.md',
  'yeaft/dream/prompts/create.md',
  'yeaft/dream/prompts/extract-user.md',
  'yeaft/dream/prompts/extract-vp.md',
  'yeaft/dream/prompts/extract-session.md',
  'yeaft/dream/prompts/extract-topic.md',
  'yeaft/dream/prompts/summarize-scope.md',
];

describe('agent package files', () => {
  it('includes dream markdown prompts in the npm package', async () => {
    const { stdout } = await execFileAsync('npm', [
      'pack',
      '--workspace=agent',
      '--dry-run',
      '--json',
    ], {
      cwd: new URL('../..', import.meta.url),
      maxBuffer: 1024 * 1024 * 10,
    });

    const [pack] = JSON.parse(stdout);
    const paths = new Set(pack.files.map((file) => file.path));

    for (const prompt of DREAM_PROMPTS) {
      expect(paths.has(prompt), `${prompt} should be packed`).toBe(true);
    }
  });
});
