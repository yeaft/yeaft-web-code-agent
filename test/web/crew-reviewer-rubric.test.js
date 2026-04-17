/**
 * Reviewer bar 10/10 — templates must enforce the explicit rubric.
 *
 * After raising the reviewer bar, both Chinese and English dev crew
 * templates (`reviewer` and `product-reviewer` roles) must contain:
 *  - the 10-dimension rubric table
 *  - the 10/10 pass threshold wording
 *  - a mandatory rework/返工 list when any dimension is below 10
 *  - forbidden-patterns section listing "LGTM"/"looks OK" style rejections
 *
 * The same content must be mirrored into .crew/roles/rev-N/CLAUDE.md and
 * prev-N/CLAUDE.md so the bar takes effect in the current repo immediately.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// --- Template files ---------------------------------------------------------

const zhTemplate = read('web/crew-templates/dev-zh.js');
const enTemplate = read('web/crew-templates/dev-en.js');

function sliceRole(source, roleName) {
  const re = new RegExp(`name:\\s*'${roleName}'[\\s\\S]*?claudeMd:\\s*\`([\\s\\S]*?)\`\\s*\\}`);
  const m = source.match(re);
  if (!m) throw new Error(`role ${roleName} not found`);
  return m[1];
}

describe('Reviewer bar 10/10 — zh template', () => {
  const reviewer = sliceRole(zhTemplate, 'reviewer');
  const productReviewer = sliceRole(zhTemplate, 'product-reviewer');

  it('reviewer uses 10-dimension rubric with 10/10 pass bar', () => {
    expect(reviewer).toMatch(/rubric/i);
    expect(reviewer).toContain('10/10');
    expect(reviewer).toContain('100/100');
    expect(reviewer).toContain('返工清单');
    // Every dimension must be named
    for (const dim of [
      'Correctness', 'Test coverage', 'No regression', 'Code quality',
      'Production verification', 'Documentation', 'Scope discipline',
      'Security', 'API', 'Reviewer evidence'
    ]) {
      expect(reviewer).toContain(dim);
    }
  });

  it('reviewer forbids vague approvals', () => {
    expect(reviewer).toContain('禁止条款');
    expect(reviewer).toContain('LGTM');
  });

  it('product-reviewer uses 10-dimension rubric with 10/10 pass bar', () => {
    expect(productReviewer).toMatch(/rubric/i);
    expect(productReviewer).toContain('10/10');
    expect(productReviewer).toContain('100/100');
    expect(productReviewer).toContain('返工清单');
    for (const dim of [
      'User pain resolution', 'Actual execution', 'Edge cases',
      'Visual / UX consistency', 'i18n coverage', 'Mobile / responsive',
      'Accessibility basics', 'Requirements coverage', 'Evidence'
    ]) {
      expect(productReviewer).toContain(dim);
    }
  });

  it('product-reviewer forbids code-only review', () => {
    expect(productReviewer).toContain('禁止条款');
    expect(productReviewer).toMatch(/只看代码不跑 UI/);
  });
});

describe('Reviewer bar 10/10 — en template', () => {
  const reviewer = sliceRole(enTemplate, 'reviewer');
  const productReviewer = sliceRole(enTemplate, 'product-reviewer');

  it('reviewer uses 10-dimension rubric with 10/10 pass bar', () => {
    expect(reviewer).toMatch(/Rubric/);
    expect(reviewer).toContain('10/10');
    expect(reviewer).toContain('100/100');
    expect(reviewer).toContain('Rework List');
    for (const dim of [
      'Correctness', 'Test coverage', 'No regression', 'Code quality',
      'Production verification', 'Documentation', 'Scope discipline',
      'Security', 'API', 'Reviewer evidence'
    ]) {
      expect(reviewer).toContain(dim);
    }
  });

  it('reviewer forbids vague approvals (en)', () => {
    expect(reviewer).toMatch(/Forbidden patterns/);
    expect(reviewer).toContain('LGTM');
  });

  it('product-reviewer uses 10-dimension rubric with 10/10 pass bar', () => {
    expect(productReviewer).toMatch(/Rubric/);
    expect(productReviewer).toContain('10/10');
    expect(productReviewer).toContain('100/100');
    expect(productReviewer).toContain('Rework List');
    for (const dim of [
      'User pain resolution', 'Actual execution', 'Edge cases',
      'Visual / UX consistency', 'i18n coverage', 'Mobile / responsive',
      'Accessibility basics', 'Requirements coverage', 'Evidence'
    ]) {
      expect(productReviewer).toContain(dim);
    }
  });

  it('product-reviewer forbids code-only review (en)', () => {
    expect(productReviewer).toMatch(/Forbidden patterns/);
    expect(productReviewer).toMatch(/Reading code only without running/);
  });
});

describe('Reviewer bar 10/10 — .crew/roles on disk in sync', () => {
  // The running repo at project root has .crew/roles/; the worktree does not.
  // Test uses absolute path outside the worktree to verify disk sync happened.
  const repoRoot = '/home/azureuser/projects/claude-web-chat';
  const rolesDir = join(repoRoot, '.crew/roles');

  // Only run if roles dir exists (skip in CI clones without it).
  const hasRoles = existsSync(rolesDir);

  (hasRoles ? describe : describe.skip)('live roles', () => {
    for (let i = 1; i <= 4; i++) {
      it(`rev-${i}/CLAUDE.md contains 10/10 rubric`, () => {
        const md = readFileSync(join(rolesDir, `rev-${i}/CLAUDE.md`), 'utf8');
        expect(md).toContain('10/10');
        expect(md).toContain('100/100');
        expect(md).toMatch(/rubric/i);
        expect(md).toContain('返工清单');
      });

      it(`prev-${i}/CLAUDE.md contains 10/10 rubric`, () => {
        const md = readFileSync(join(rolesDir, `prev-${i}/CLAUDE.md`), 'utf8');
        expect(md).toContain('10/10');
        expect(md).toContain('100/100');
        expect(md).toMatch(/rubric/i);
        expect(md).toContain('返工清单');
      });
    }
  });
});
