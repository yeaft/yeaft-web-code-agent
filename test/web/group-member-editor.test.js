/**
 * task-fix-group-member-editor — verifies the new in-place group
 * roster editor wiring.
 *
 * The previous flow shoved users into Settings → VP Library, which
 * has no "add to group" action — completely the wrong scope. Now:
 *  - Empty-group hero CTA, GroupInviteModal CTA, and the sidebar
 *    kebab "Manage members" all converge on a single
 *    `GroupMemberEditor` modal owned by UnifyPage.
 *  - The editor commits via existing `groupCrudRequest` ops
 *    (add_member / remove_member / set_default_vp).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const read = rel => readFileSync(join(repoRoot, rel), 'utf8');

describe('GroupMemberEditor wiring', () => {
  it('GroupMemberEditor commits each toggle via groupCrudRequest', () => {
    const src = read('web/components/GroupMemberEditor.js');
    expect(src).toMatch(/groupCrudRequest\(\s*op[\s\S]{0,200}groupId:\s*this\.groupId/);
    expect(src).toMatch(/op\s*=\s*checked\s*\?\s*['"]add_member['"]\s*:\s*['"]remove_member['"]/);
    expect(src).toMatch(/groupCrudRequest\(\s*['"]set_default_vp['"]/);
  });

  it('first added member auto-promotes to defaultVpId', () => {
    const src = read('web/components/GroupMemberEditor.js');
    // Saves the user a second click — the star is invisible until at
    // least one member exists, so the obvious choice should just happen.
    expect(src).toMatch(/!this\.defaultVpId[\s\S]{0,200}set_default_vp/);
  });

  it('derives roster + defaultVpId from groups store (not local state)', () => {
    const src = read('web/components/GroupMemberEditor.js');
    expect(src).toMatch(/roster\(\)\s*\{[\s\S]*g\.roster/);
    expect(src).toMatch(/defaultVpId\(\)\s*\{[\s\S]*g\.defaultVpId/);
  });

  it('UnifyPage owns memberEditorOpen + openMemberEditor and exposes them', () => {
    const src = read('web/components/UnifyPage.js');
    expect(src).toContain("import GroupMemberEditor from './GroupMemberEditor.js'");
    expect(src).toMatch(/<GroupMemberEditor[\s\S]{0,200}:group-id="memberEditorGroupId"/);
    expect(src).toMatch(/return\s*\{[\s\S]*openMemberEditor[\s\S]*\}/);
  });

  it('all three entry points converge on openMemberEditor', () => {
    const src = read('web/components/UnifyPage.js');
    // 1. Sidebar kebab → manage-members event
    expect(src).toMatch(/@manage-members="openMemberEditor"/);
    // 2. Invite modal CTA (legacy event name reused)
    expect(src).toMatch(/onInviteOpenLibrary[\s\S]{0,400}openMemberEditor/);
    // 3. Hero CTA reuses onInviteOpenLibrary (verified separately)
    expect(src).toMatch(/unify-empty-group-hero__cta[\s\S]{0,200}onInviteOpenLibrary/);
  });

  it('UnifySidebarV2 emits manage-members from the kebab menu', () => {
    const src = read('web/components/UnifySidebarV2.js');
    expect(src).toMatch(/emits:\s*\[[^\]]*'manage-members'/);
    expect(src).toMatch(/startManageMembers[\s\S]*\$emit\(\s*['"]manage-members['"]/);
    expect(src).toMatch(/@click="startManageMembers\(g\)"/);
  });

  it('VP library is back to its CRUD-only state (no add-to-group button)', () => {
    const src = read('web/components/VpCrudPanel.js');
    expect(src).not.toMatch(/addToTargetGroup/);
    expect(src).not.toMatch(/unify\.vp\.crud\.addToGroup/);
  });

  it('exposes Manage Members + editor i18n keys in both locales', () => {
    for (const file of ['web/i18n/en.js', 'web/i18n/zh-CN.js']) {
      const src = read(file);
      expect(src, file).toContain("'unify.group.manageMembers'");
      expect(src, file).toContain("'unify.group.members.title'");
      expect(src, file).toContain("'unify.group.members.actionFailed'");
    }
  });
});
