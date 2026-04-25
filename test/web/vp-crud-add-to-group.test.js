/**
 * task-fix-vp-add: VpCrudPanel exposes an "Add to <group>" CTA on each
 * VP card so users can recruit a VP into the active group without
 * leaving the library tab. Verifies wiring end-to-end:
 *  - Component template surfaces the button gated on `targetGroup`
 *  - `addToTargetGroup` dispatches via `groupCrudRequest('add_member', …)`
 *  - `isInTargetGroup` correctly detects existing roster membership
 *  - i18n keys present in both locales
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
function read(rel) { return readFileSync(join(repoRoot, rel), 'utf8'); }

describe('VpCrudPanel add-to-group action', () => {
  it('renders gated CTA button using targetGroup', () => {
    const src = read('web/components/VpCrudPanel.js');
    expect(src).toMatch(/v-if="targetGroup"/);
    expect(src).toMatch(/@click="addToTargetGroup\(vp\)"/);
    expect(src).toMatch(/:disabled="busy \|\| isInTargetGroup\(vp\)"/);
    expect(src).toMatch(/unify\.vp\.crud\.addToGroup/);
    expect(src).toMatch(/unify\.vp\.crud\.alreadyInGroup/);
  });

  it('dispatches add_member through groupCrudRequest', () => {
    const src = read('web/components/VpCrudPanel.js');
    expect(src).toMatch(/groupCrudRequest\(\s*['"]add_member['"]/);
    expect(src).toMatch(/groupId:\s*g\.id/);
    expect(src).toMatch(/vpId:\s*vp\.vpId/);
  });

  it('isInTargetGroup checks roster array', () => {
    const src = read('web/components/VpCrudPanel.js');
    expect(src).toMatch(/isInTargetGroup\(vp\)\s*\{[\s\S]*roster\.includes\(vp\.vpId\)/);
  });

  it('targetGroup resolves from groups store activeGroup', () => {
    const src = read('web/components/VpCrudPanel.js');
    expect(src).toMatch(/useGroupsStore[\s\S]*activeGroup/);
  });

  it('translates raw "Default" sentinel to localized name in CTA', () => {
    const src = read('web/components/VpCrudPanel.js');
    expect(src).toMatch(/grp_default[\s\S]*unify\.group\.defaultName/);
  });

  it('declares the i18n keys in both locales', () => {
    for (const file of ['web/i18n/en.js', 'web/i18n/zh-CN.js']) {
      const src = read(file);
      expect(src, file).toContain("'unify.vp.crud.addToGroup'");
      expect(src, file).toContain("'unify.vp.crud.alreadyInGroup'");
      expect(src, file).toContain("'unify.vp.crud.addToGroupFailed'");
    }
  });

  it('styles is-primary variant of vp-crud-link-btn', () => {
    const css = read('web/styles/unify-vp.css');
    expect(css).toMatch(/\.vp-crud-link-btn\.is-primary/);
  });
});
