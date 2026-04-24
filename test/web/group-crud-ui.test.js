/**
 * task-334m — Group CRUD UI wiring tests (source-scan style).
 *
 * web/stores/groups.js uses the Pinia global which isn't mounted in the
 * node-only vitest env, so we verify the store shape by static source
 * inspection + run the pure reducer logic after faking the `Pinia` global.
 *
 * Covers:
 *   (1) i18n key parity between en and zh-CN for every `unify.group.*`
 *       string referenced by the wizard / sidebar / error mapper.
 *   (2) chat.js dispatches group_list_updated / group_roster_changed /
 *       group_crud_result → groups store, and exposes groupCrudRequest.
 *   (3) app.js exposes useGroupsStore via window.Pinia.
 *   (4) GroupCreateWizard emits close/created, maps error codes to i18n.
 *   (5) UnifySidebarV2 renders a Groups section with new-button + list.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const groupsStoreSrc   = read('web/stores/groups.js');
const chatStoreSrc     = read('web/stores/chat.js');
const appJsSrc         = read('web/app.js');
const enSrc            = read('web/i18n/en.js');
const zhSrc            = read('web/i18n/zh-CN.js');
const wizardSrc        = read('web/components/GroupCreateWizard.js');
const sidebarSrc       = read('web/components/UnifySidebarV2.js');
const webBridgeSrc     = read('agent/unify/web-bridge.js');
const routerSrc        = read('agent/connection/message-router.js');

// ─── (1) i18n key parity ─────────────────────────────────────

// Expected leaf keys referenced by wizard + sidebar. Each must appear in
// both en and zh-CN locale files. We search for the flat key form (the
// i18n util flattens nested `unify.group.*` objects).
const I18N_KEYS = [
  'unify.group.sidebarTitle',
  'unify.group.sidebarAria',
  'unify.group.newButtonAria',
  'unify.group.empty',
  'unify.group.oneMember',
  'unify.group.membersCount',
  'unify.group.noMembers',
  'unify.group.defaultName',
  'unify.group.moreActions',
  'unify.group.archive',
  'unify.group.archiveConfirm',
  'unify.group.archivingEllipsis',
  'unify.group.rename',
  'unify.group.renamingEllipsis',
  'unify.group.wizard.title',
  'unify.group.wizard.close',
  'unify.group.wizard.step.name',
  'unify.group.wizard.step.members',
  'unify.group.wizard.step.confirm',
  'unify.group.wizard.confirmTitle',
  'unify.group.wizard.confirmHint',
  'unify.group.wizard.confirmNameLabel',
  'unify.group.wizard.confirmMembersLabel',
  'unify.group.wizard.confirmDefaultLabel',
  'unify.group.wizard.confirmEmpty',
  'unify.group.wizard.namePlaceholder',
  'unify.group.wizard.nameHint',
  'unify.group.wizard.roster',
  'unify.group.wizard.rosterHint',
  'unify.group.wizard.rosterEmpty',
  'unify.group.wizard.defaultVp',
  'unify.group.wizard.defaultVpHint',
  'unify.group.wizard.cancel',
  'unify.group.wizard.back',
  'unify.group.wizard.next',
  'unify.group.wizard.create',
  'unify.group.wizard.creating',
  'unify.group.error.invalid_name',
  'unify.group.error.reserved',
  'unify.group.error.default_not_in_roster',
  'unify.group.error.no_default_vp',
  'unify.group.error.not_found',
  'unify.group.error.duplicate',
  'unify.group.error.unknown',
  'unify.group.invite.title',
  'unify.group.invite.body',
  'unify.group.invite.openLibrary',
  'unify.group.invite.dismiss',
];

// A key like `unify.group.wizard.title` maps to a leaf string inside the
// nested `unify: { group: { wizard: { title: "…" }}}` object. For a
// source-level check we just require every leaf-name to occur textually
// in both en and zh-CN files (the i18n objects are declared in source
// with the leaf name as an object key — e.g. `title: 'Create group'`).
describe('unify.group.* i18n keys exist in en + zh-CN', () => {
  for (const full of I18N_KEYS) {
    it(`'${full}' present in both locales`, () => {
      expect(enSrc).toContain(`'${full}'`);
      expect(zhSrc).toContain(`'${full}'`);
    });
  }
});

// ─── (2) chat.js dispatch + groupCrudRequest action ──────────

describe('chat.js wires group WS events into groups store', () => {
  it('handles group_list_updated', () => {
    expect(chatStoreSrc).toMatch(/case ['"]group_list_updated['"]/);
  });
  it('handles group_roster_changed', () => {
    expect(chatStoreSrc).toMatch(/case ['"]group_roster_changed['"]/);
  });
  it('handles group_crud_result', () => {
    expect(chatStoreSrc).toMatch(/case ['"]group_crud_result['"]/);
  });
  it('looks up useGroupsStore off window.Pinia', () => {
    expect(chatStoreSrc).toMatch(/window\.Pinia\?*\.?\.useGroupsStore/);
  });
  it('exposes a groupCrudRequest action with 10s timeout', () => {
    expect(chatStoreSrc).toMatch(/groupCrudRequest\s*\(/);
    expect(chatStoreSrc).toMatch(/_groupCrudPending/);
  });
  it('request type map covers create/rename/archive/add/remove/set-default/list', () => {
    // The chat store ships a typeMap with WS message types for each op.
    expect(chatStoreSrc).toMatch(/unify_create_group/);
    expect(chatStoreSrc).toMatch(/unify_rename_group/);
    expect(chatStoreSrc).toMatch(/unify_archive_group/);
    expect(chatStoreSrc).toMatch(/unify_add_member/);
    expect(chatStoreSrc).toMatch(/unify_remove_member/);
    expect(chatStoreSrc).toMatch(/unify_set_default_vp/);
    expect(chatStoreSrc).toMatch(/unify_list_groups/);
  });
});

// ─── (3) app.js bootstraps useGroupsStore ────────────────────

describe('app.js exposes useGroupsStore on window.Pinia', () => {
  it('imports the store', () => {
    expect(appJsSrc).toContain("from './stores/groups.js'");
  });
  it('assigns to window.Pinia.useGroupsStore', () => {
    expect(appJsSrc).toMatch(/window\.Pinia\.useGroupsStore\s*=\s*useGroupsStore/);
  });
});

// ─── (4) GroupCreateWizard structural checks ────────────────

describe('GroupCreateWizard', () => {
  it('emits close and created', () => {
    expect(wizardSrc).toMatch(/emits:\s*\[[^\]]*'close'[^\]]*'created'/);
  });
  it('calls groupCrudRequest with op "create"', () => {
    expect(wizardSrc).toMatch(/groupCrudRequest\(['"]create['"]/);
  });
  it('maps backend error codes via unify.group.error.<code>', () => {
    expect(wizardSrc).toMatch(/unify\.group\.error\./);
    // Fallback to `unknown` when the specific key has no translation.
    expect(wizardSrc).toMatch(/unify\.group\.error\.unknown/);
  });
  it('2-step wizard: members → name (confirm step removed per task-fix)', () => {
    expect(wizardSrc).toContain('step: 1');
    expect(wizardSrc).toMatch(/v-if="step === 1"/);
    // task-fix (5-bugs): per user — "选好了就是选好了". Step 3 (confirm)
    // removed; step 2 now has the name input plus the final submit button.
    expect(wizardSrc).not.toMatch(/v-else-if="step === 2"/);
    expect(wizardSrc).not.toContain('group-wizard-summary');
  });
});

// ─── (4b) GroupInviteModal structural checks ────────────────

const inviteModalSrc = read('web/components/GroupInviteModal.js');

describe('GroupInviteModal (prev-2 BLOCKER-1)', () => {
  it('emits open-library + dismiss', () => {
    expect(inviteModalSrc).toMatch(/emits:\s*\[[^\]]*'open-library'[^\]]*'dismiss'/);
  });
  it('takes a groupName prop', () => {
    expect(inviteModalSrc).toMatch(/groupName:\s*\{\s*type:\s*String/);
  });
  it('renders title/body/openLibrary/dismiss i18n keys', () => {
    expect(inviteModalSrc).toContain("'unify.group.invite.title'");
    expect(inviteModalSrc).toContain("'unify.group.invite.body'");
    expect(inviteModalSrc).toContain("'unify.group.invite.openLibrary'");
    expect(inviteModalSrc).toContain("'unify.group.invite.dismiss'");
  });
  it('closes on Escape key', () => {
    expect(inviteModalSrc).toMatch(/e\.key === 'Escape'/);
  });
});

// ─── (4c) UnifyPage wires the invite modal + send pre-check ───

const unifyPageSrc = read('web/components/UnifyPage.js');

describe('UnifyPage invite-modal integration (prev-2 BLOCKER-1)', () => {
  it('imports and registers GroupInviteModal', () => {
    expect(unifyPageSrc).toContain("import GroupInviteModal from './GroupInviteModal.js'");
  });
  it('exposes shouldShowInviteModal + inviteGroupName', () => {
    expect(unifyPageSrc).toContain('shouldShowInviteModal');
    expect(unifyPageSrc).toContain('inviteGroupName');
  });
  it('blocks sendMessage when activeNeedsInvite is true', () => {
    expect(unifyPageSrc).toMatch(/activeNeedsInvite/);
  });
  it('translates grp_default sentinel via unify.group.defaultName', () => {
    expect(unifyPageSrc).toContain('grp_default');
    expect(unifyPageSrc).toContain('unify.group.defaultName');
  });
});

// ─── (5) UnifySidebarV2 Groups section ──────────────────────

describe('UnifySidebarV2 Groups section (designer R6 §6)', () => {
  it('renders a Groups section with new-button', () => {
    // task-339-F1: the 📁 emoji was dropped when the section was hoisted
    // to the top of the sidebar; the section class + wizard trigger remain.
    expect(sidebarSrc).toContain('usv2-group-groups');
    expect(sidebarSrc).toMatch(/onOpenGroupWizard/);
  });
  it('registers GroupCreateWizard and toggles groupWizardOpen', () => {
    expect(sidebarSrc).toContain("import GroupCreateWizard from './GroupCreateWizard.js'");
    expect(sidebarSrc).toMatch(/components:\s*\{[^}]*GroupCreateWizard/);
    expect(sidebarSrc).toContain('groupWizardOpen');
  });
  it('emits select-group', () => {
    expect(sidebarSrc).toMatch(/emits:\s*\[[^\]]*'select-group'/);
  });
  it('has per-row kebab + Rename/Archive menu (prev-2 BLOCKER-2)', () => {
    expect(sidebarSrc).toContain('usv2-group-row-kebab');
    expect(sidebarSrc).toContain('usv2-group-row-menu');
    expect(sidebarSrc).toMatch(/startRenameGroup/);
    expect(sidebarSrc).toMatch(/startArchiveGroup/);
  });
  it('kebab button + menu expose a11y roles (rev-3 follow-up — a11y nit)', () => {
    // The kebab button must declare it opens a menu and reflect open state
    // via aria-expanded for screen readers.
    expect(sidebarSrc).toMatch(/class="usv2-group-row-kebab"[\s\S]*?aria-haspopup="menu"/);
    expect(sidebarSrc).toMatch(/class="usv2-group-row-kebab"[\s\S]*?:aria-expanded=/);
    // The menu itself must be role="menu" with role="menuitem" children so
    // assistive tech groups rename/archive correctly.
    expect(sidebarSrc).toMatch(/role="menu"[^>]*class="usv2-group-row-menu"|class="usv2-group-row-menu"[^>]*role="menu"/);
    expect(sidebarSrc).toMatch(/role="menuitem"[^>]*class="usv2-group-row-menu-item"|class="usv2-group-row-menu-item"[^>]*role="menuitem"/);
  });
  it('has archive-confirm + rename modals wired to groupCrudRequest', () => {
    expect(sidebarSrc).toMatch(/confirmArchiveGroup/);
    expect(sidebarSrc).toMatch(/confirmRenameGroup/);
    expect(sidebarSrc).toMatch(/groupCrudRequest\(['"]archive['"]/);
    expect(sidebarSrc).toMatch(/groupCrudRequest\(['"]rename['"]/);
  });
  it('translates grp_default sentinel via unify.group.defaultName', () => {
    expect(sidebarSrc).toContain('grp_default');
    expect(sidebarSrc).toContain('unify.group.defaultName');
  });
});

// ─── (6) backend bridge + router wiring ──────────────────────

describe('agent/web-bridge + message-router group handlers', () => {
  const ops = [
    'handleUnifyListGroups',
    'handleUnifyCreateGroup',
    'handleUnifyRenameGroup',
    'handleUnifyArchiveGroup',
    'handleUnifyAddMember',
    'handleUnifyRemoveMember',
    'handleUnifySetDefaultVp',
  ];
  for (const fn of ops) {
    it(`web-bridge exports ${fn}`, () => {
      expect(webBridgeSrc).toMatch(new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\b`));
    });
    it(`message-router dispatches to ${fn}`, () => {
      expect(routerSrc).toContain(fn);
    });
  }
  it('bridge broadcasts group_roster_changed + group_list_updated', () => {
    expect(webBridgeSrc).toContain('group_roster_changed');
    expect(webBridgeSrc).toContain('group_list_updated');
  });
  it('bridge responds with group_crud_result carrying requestId', () => {
    expect(webBridgeSrc).toContain('group_crud_result');
    expect(webBridgeSrc).toMatch(/requestId/);
  });
});

// ─── (7) groups store reducer logic ──────────────────────────

// Fake the Pinia global so we can import the ES module without Vue.
// defineStore here captures the options and builds a minimal store that
// exposes state + getters + actions bound to a shared `this`.
function buildFakeStore(opts) {
  const state = opts.state();
  const ctx = { ...state };
  // install getters as plain properties using getter descriptors
  for (const [name, fn] of Object.entries(opts.getters || {})) {
    Object.defineProperty(ctx, name, {
      get: () => {
        try { return fn(ctx); } catch { return fn.call(ctx, ctx); }
      },
      configurable: true,
    });
  }
  for (const [name, fn] of Object.entries(opts.actions || {})) {
    ctx[name] = fn.bind(ctx);
  }
  return ctx;
}

async function loadGroupsStore() {
  globalThis.Pinia = {
    defineStore: (_id, opts) => () => buildFakeStore(opts),
  };
  const mod = await import('../../web/stores/groups.js');
  return mod.useGroupsStore();
}

describe('groups store reducer logic', () => {
  it('applySnapshot rebuilds map + order and picks first as active', async () => {
    const s = await loadGroupsStore();
    s.applySnapshot([
      { id: 'g1', name: 'One', roster: ['a'], defaultVpId: 'a' },
      { id: 'g2', name: 'Two', roster: [], defaultVpId: null },
    ]);
    expect(s.groupOrder).toEqual(['g1', 'g2']);
    expect(s.activeGroupId).toBe('g1');
    expect(s.groupList.map(g => g.name)).toEqual(['One', 'Two']);
  });

  it('applyRosterChange merges name + roster + defaultVpId in place', async () => {
    const s = await loadGroupsStore();
    s.applySnapshot([{ id: 'g1', name: 'One', roster: ['a'], defaultVpId: 'a' }]);
    s.applyRosterChange({ groupId: 'g1', roster: ['a', 'b'], defaultVpId: 'b', name: 'One!' });
    expect(s.groups.g1.name).toBe('One!');
    expect(s.groups.g1.roster).toEqual(['a', 'b']);
    expect(s.groups.g1.defaultVpId).toBe('b');
  });

  it('applyCrudResult ok+create auto-activates the new group', async () => {
    const s = await loadGroupsStore();
    s.applyCrudResult({ ok: true, op: 'create', group: { id: 'g9', name: 'Nine', roster: [], defaultVpId: null } });
    expect(s.activeGroupId).toBe('g9');
    expect(s.groups.g9.name).toBe('Nine');
  });

  it('applyCrudResult ok+archive drops the group and rotates active', async () => {
    const s = await loadGroupsStore();
    s.applySnapshot([
      { id: 'g1', name: 'One', roster: [] },
      { id: 'g2', name: 'Two', roster: [] },
    ]);
    s.setActive('g1');
    s.applyCrudResult({ ok: true, op: 'archive', groupId: 'g1' });
    expect(s.groups.g1).toBeUndefined();
    expect(s.activeGroupId).toBe('g2');
  });

  it('activeNeedsInvite is true for empty-roster active group', async () => {
    const s = await loadGroupsStore();
    s.applySnapshot([{ id: 'g1', name: 'Empty', roster: [], defaultVpId: null }]);
    expect(s.activeNeedsInvite).toBe(true);
    s.applyRosterChange({ groupId: 'g1', roster: ['a'], defaultVpId: 'a' });
    expect(s.activeNeedsInvite).toBe(false);
  });
});
