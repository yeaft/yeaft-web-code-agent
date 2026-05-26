import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const DREAM_PROMPTS = [
  'unify/dream-v2/prompts/triage-pass1.md',
  'unify/dream-v2/prompts/triage-pass2.md',
  'unify/dream-v2/prompts/update.md',
  'unify/dream-v2/prompts/create.md',
  'unify/dream-v2/prompts/extract-user.md',
  'unify/dream-v2/prompts/extract-vp.md',
  'unify/dream-v2/prompts/extract-group.md',
  'unify/dream-v2/prompts/extract-topic.md',
  'unify/dream-v2/prompts/summarize-scope.md',
];

describe('agent package files', () => {
  it('includes dream-v2 markdown prompts in the npm package', async () => {
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
