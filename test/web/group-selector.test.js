/**
 * task-338-F3 — GroupSelector component wiring tests (source-scan style).
 *
 * Confirms that:
 *   (1) GroupSelector.js defines a dropdown trigger + options + wizard mount.
 *   (2) UnifyPage.js imports GroupSelector and mounts it inside the
 *       unify-topbar, to the right of the sidebar toggle.
 *   (3) Component reads from useGroupsStore and calls groupCrudRequest for
 *       rename / archive round-trips, and `setActive()` on click.
 *   (4) All i18n keys used by the component exist in both en and zh-CN.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const selectorSrc = read('web/components/GroupSelector.js');
const unifyPage   = read('web/components/UnifyPage.js');
const enSrc       = read('web/i18n/en.js');
const zhSrc       = read('web/i18n/zh-CN.js');

describe('GroupSelector component', () => {
  it('declares a GroupSelector component with a compact topbar trigger', () => {
    expect(selectorSrc).toMatch(/name:\s*['"]GroupSelector['"]/);
    expect(selectorSrc).toContain('unify-topbar-group-trigger');
    expect(selectorSrc).toContain('unify-topbar-group-dropdown');
  });

  it('shows the active group name and member count', () => {
    expect(selectorSrc).toContain('activeGroupId');
    expect(selectorSrc).toContain('activeGroup');
    expect(selectorSrc).toMatch(/memberLabel\s*\(/);
  });

  it('wires click→setActive on each group row', () => {
    expect(selectorSrc).toMatch(/setActive\s*\(/);
    expect(selectorSrc).toContain('selectGroup');
  });

  it('mounts the GroupCreateWizard behind the "+ New group" entry', () => {
    expect(selectorSrc).toContain("import GroupCreateWizard from './GroupCreateWizard.js'");
    expect(selectorSrc).toContain('wizardOpen');
    expect(selectorSrc).toContain('unify.group.newButton');
  });

  it('calls chatStore.groupCrudRequest for rename and archive', () => {
    expect(selectorSrc).toMatch(/groupCrudRequest\(['"]rename['"]/);
    expect(selectorSrc).toMatch(/groupCrudRequest\(['"]archive['"]/);
  });

  it('uses window.Pinia guarded lookups for stores', () => {
    expect(selectorSrc).toContain('window.Pinia?.useGroupsStore');
    expect(selectorSrc).toContain('window.Pinia?.useChatStore');
  });

  it('closes the dropdown on outside click and Esc', () => {
    expect(selectorSrc).toContain('onDocClick');
    expect(selectorSrc).toContain('onEsc');
  });
});

describe('UnifyPage integration', () => {
  it("imports GroupSelector and registers it in components{}", () => {
    expect(unifyPage).toContain("import GroupSelector from './GroupSelector.js'");
    expect(unifyPage).toMatch(/components:\s*{[^}]*GroupSelector/);
  });

  it('mounts <GroupSelector /> inside the unify-topbar', () => {
    // Topbar contains the sidebar toggle + selector; check order.
    const idxTopbar = unifyPage.indexOf('class="unify-topbar"');
    const idxSelector = unifyPage.indexOf('<GroupSelector');
    const idxRight = unifyPage.indexOf('unify-topbar-right');
    expect(idxTopbar).toBeGreaterThan(-1);
    expect(idxSelector).toBeGreaterThan(idxTopbar);
    expect(idxSelector).toBeLessThan(idxRight);
  });
});

describe('GroupSelector i18n parity', () => {
  const keys = [
    'unify.group.defaultName',
    'unify.group.empty',
    'unify.group.newButton',
    'unify.group.newButtonAria',
    'unify.group.sidebarTitle',
    'unify.group.moreActions',
    'unify.group.rename',
    'unify.group.renamePrompt',
    'unify.group.archive',
    'unify.group.archiveConfirm',
    'unify.group.membersCount',
    'unify.group.oneMember',
    'unify.group.noMembers',
  ];
  for (const k of keys) {
    it(`en + zh-CN define "${k}"`, () => {
      expect(enSrc).toContain(`'${k}'`);
      expect(zhSrc).toContain(`'${k}'`);
    });
  }
});
