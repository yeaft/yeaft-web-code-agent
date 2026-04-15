import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Tests for Phase 3: Expert Panel Custom Role UI.
 *
 * Covers:
 * - ExpertRoleEditor component structure
 * - ExpertPanel custom team tab integration
 * - Updated getSelectionLabel with custom role support
 * - Updated buildAutocompleteItems with custom role support
 * - i18n keys for editor and custom panel
 * - CSS classes for editor and custom role UI
 */

const rootDir = join(import.meta.dirname, '..', '..');

// ===========================================================
// 1. ExpertRoleEditor component
// ===========================================================
describe('ExpertRoleEditor component', () => {
  let code;
  beforeAll(() => {
    code = readFileSync(join(rootDir, 'web/components/ExpertRoleEditor.js'), 'utf8');
  });

  it('exports a default component with name ExpertRoleEditor', () => {
    expect(code).toContain("name: 'ExpertRoleEditor'");
  });

  it('has form fields for name, title, fullName, titleEn', () => {
    expect(code).toContain('v-model="form.name"');
    expect(code).toContain('v-model="form.title"');
    expect(code).toContain('v-model="form.fullName"');
    expect(code).toContain('v-model="form.titleEn"');
  });

  it('has textarea fields for messagePrefix and messagePrefixEn', () => {
    expect(code).toContain('v-model="form.messagePrefix"');
    expect(code).toContain('v-model="form.messagePrefixEn"');
  });

  it('has action fields for name, messageTemplate, defaultMessage', () => {
    expect(code).toContain('v-model="action.name"');
    expect(code).toContain('v-model="action.messageTemplate"');
    expect(code).toContain('v-model="action.defaultMessage"');
  });

  it('has addAction and removeAction methods', () => {
    expect(code).toContain('addAction');
    expect(code).toContain('removeAction');
  });

  it('has save method that calls createCustomExpertRole or updateCustomExpertRole', () => {
    expect(code).toContain('createCustomExpertRole');
    expect(code).toContain('updateCustomExpertRole');
  });

  it('has isEdit computed based on props.role', () => {
    expect(code).toContain('isEdit');
    expect(code).toContain('props.role');
  });

  it('has canSave validation', () => {
    expect(code).toContain('canSave');
    expect(code).toContain('form.name.trim()');
    expect(code).toContain('form.title.trim()');
  });

  it('emits close and saved events', () => {
    expect(code).toContain("emit('close')");
    expect(code).toContain("emit('saved')");
  });

  it('has disabled state for save button', () => {
    expect(code).toContain(':disabled="!canSave || saving"');
  });

  it('has overlay with click-outside-to-close', () => {
    expect(code).toContain('expert-editor-overlay');
    expect(code).toContain('@click.self="$emit(\'close\')"');
  });

  it('initializes form from existing role in edit mode', () => {
    expect(code).toContain('props.role.name');
    expect(code).toContain('props.role.title');
    expect(code).toContain('props.role.actions');
  });
});

// ===========================================================
// 2. ExpertPanel custom team tab
// ===========================================================
describe('ExpertPanel — custom team tab', () => {
  let code;
  beforeAll(() => {
    code = readFileSync(join(rootDir, 'web/components/ExpertPanel.js'), 'utf8');
  });

  it('imports ExpertRoleEditor', () => {
    expect(code).toContain("import ExpertRoleEditor from './ExpertRoleEditor.js'");
  });

  it('registers ExpertRoleEditor as child component', () => {
    expect(code).toContain('components: { ExpertRoleEditor }');
  });

  it('has allTeamTabs computed that includes custom tab', () => {
    expect(code).toContain('allTeamTabs');
    expect(code).toContain("id: 'custom'");
  });

  it('uses allTeamTabs in template for team tabs', () => {
    expect(code).toContain('v-for="team in allTeamTabs"');
  });

  it('has isCustomTabActive computed', () => {
    expect(code).toContain('isCustomTabActive');
    expect(code).toContain("enabledTeams.value.has('custom')");
  });

  it('shows custom roles section when custom tab is active', () => {
    expect(code).toContain('v-if="isCustomTabActive"');
  });

  it('has add role button in custom section', () => {
    expect(code).toContain('expert-add-role-btn');
    expect(code).toContain('openEditor(null)');
  });

  it('renders custom role cards from store.customExpertRoles', () => {
    expect(code).toContain('store.customExpertRoles');
    expect(code).toContain("'custom-' + role.id");
  });

  it('has edit and delete buttons for custom roles', () => {
    expect(code).toContain('role-edit-btn');
    expect(code).toContain('role-delete-btn');
    expect(code).toContain('openEditor(role)');
    expect(code).toContain('confirmDeleteRole(role)');
  });

  it('has empty state for no custom roles', () => {
    expect(code).toContain('expert-custom-empty');
    expect(code).toContain("$t('expertPanel.noCustomRoles')");
    expect(code).toContain("$t('expertPanel.createFirst')");
  });

  it('has ExpertRoleEditor modal in template', () => {
    expect(code).toContain('v-if="editorOpen"');
    expect(code).toContain(':role="editingRole"');
    expect(code).toContain('@saved="onEditorSaved"');
  });

  it('has delete confirmation dialog', () => {
    expect(code).toContain('v-if="deletingRole"');
    expect(code).toContain('expert-delete-confirm');
    expect(code).toContain('executeDelete');
  });

  it('fetches custom roles on panel open', () => {
    expect(code).toContain('fetchCustomExpertRoles');
  });

  it('has viewingCustomRole computed for custom role detail', () => {
    expect(code).toContain('viewingCustomRole');
  });

  it('shows custom role prompts in detail view', () => {
    expect(code).toContain('v-else-if="viewingCustomRole"');
    expect(code).toContain('viewingCustomRole.messagePrefix');
  });

  it('has getSelectionLabelFull that handles both builtin and custom roles', () => {
    expect(code).toContain('getSelectionLabelFull');
    expect(code).toContain('store.customExpertRoles.find');
  });
});

// ===========================================================
// 3. Updated getSelectionLabel with custom role support
// ===========================================================
describe('getSelectionLabel — custom role support', () => {
  let getSelectionLabel;
  beforeAll(async () => {
    const mod = await import(join(rootDir, 'web/utils/expert-roles.js'));
    getSelectionLabel = mod.getSelectionLabel;
  });

  it('returns role name for built-in role', () => {
    const label = getSelectionLabel({ role: 'jobs' });
    expect(label).toBe('Jobs');
  });

  it('returns role·action for built-in role with action', () => {
    const label = getSelectionLabel({ role: 'jobs', action: 'product-analysis' });
    expect(label).toContain('Jobs');
    expect(label).toContain('\u00B7');
  });

  it('returns role id for unknown role without custom roles', () => {
    const label = getSelectionLabel({ role: 'unknown-custom' });
    expect(label).toBe('unknown-custom');
  });

  it('returns custom role name when custom roles provided', () => {
    const custom = [{ id: 'my-role', name: 'My Role', actions: [] }];
    const label = getSelectionLabel({ role: 'my-role' }, custom);
    expect(label).toBe('My Role');
  });

  it('returns custom role·action when action matches', () => {
    const custom = [{ id: 'my-role', name: 'My Role', actions: [{ id: 'act1', name: 'Act 1' }] }];
    const label = getSelectionLabel({ role: 'my-role', action: 'act1' }, custom);
    expect(label).toBe('My Role\u00B7Act 1');
  });

  it('returns custom role name when action not found', () => {
    const custom = [{ id: 'my-role', name: 'My Role', actions: [{ id: 'act1', name: 'Act 1' }] }];
    const label = getSelectionLabel({ role: 'my-role', action: 'unknown' }, custom);
    expect(label).toBe('My Role');
  });
});

// ===========================================================
// 4. Updated buildAutocompleteItems with custom role support
// ===========================================================
describe('buildAutocompleteItems — custom role support', () => {
  let buildAutocompleteItems;
  beforeAll(async () => {
    const mod = await import(join(rootDir, 'web/utils/expert-roles.js'));
    buildAutocompleteItems = mod.buildAutocompleteItems;
  });

  it('returns items without custom roles', () => {
    const items = buildAutocompleteItems();
    expect(items.length).toBeGreaterThan(0);
    expect(items.every(i => i.group !== 'custom')).toBe(true);
  });

  it('includes custom roles when provided', () => {
    const custom = [{ id: 'cr1', name: 'Custom1', title: 'T', actions: [{ id: 'a1', name: 'A1' }] }];
    const items = buildAutocompleteItems(custom);
    const customItems = items.filter(i => i.group === 'custom');
    expect(customItems.length).toBe(2); // role + action
    expect(customItems[0].roleId).toBe('cr1');
    expect(customItems[1].actionId).toBe('a1');
  });

  it('handles empty custom roles array', () => {
    const items = buildAutocompleteItems([]);
    const customItems = items.filter(i => i.group === 'custom');
    expect(customItems.length).toBe(0);
  });

  it('custom role items have correct searchText', () => {
    const custom = [{ id: 'cr1', name: 'DataBot', fullName: 'Data Bot', title: '分析', titleEn: 'Analyst', actions: [] }];
    const items = buildAutocompleteItems(custom);
    const customItem = items.find(i => i.roleId === 'cr1');
    expect(customItem.searchText).toContain('databot');
    expect(customItem.searchText).toContain('data bot');
    expect(customItem.searchText).toContain('analyst');
  });
});

// ===========================================================
// 5. i18n keys
// ===========================================================
describe('i18n — expert editor keys (en)', () => {
  let enI18n;
  beforeAll(() => {
    enI18n = readFileSync(join(rootDir, 'web/i18n/en.js'), 'utf8');
  });

  it('has expertEditor.createTitle', () => {
    expect(enI18n).toContain("'expertEditor.createTitle'");
  });
  it('has expertEditor.editTitle', () => {
    expect(enI18n).toContain("'expertEditor.editTitle'");
  });
  it('has expertEditor.roleName', () => {
    expect(enI18n).toContain("'expertEditor.roleName'");
  });
  it('has expertEditor.roleTitle', () => {
    expect(enI18n).toContain("'expertEditor.roleTitle'");
  });
  it('has expertEditor.actions', () => {
    expect(enI18n).toContain("'expertEditor.actions'");
  });
  it('has expertEditor.save', () => {
    expect(enI18n).toContain("'expertEditor.save'");
  });
  it('has expertPanel.customRoles', () => {
    expect(enI18n).toContain("'expertPanel.customRoles'");
  });
  it('has expertPanel.addRole', () => {
    expect(enI18n).toContain("'expertPanel.addRole'");
  });
  it('has expertPanel.deleteConfirm', () => {
    expect(enI18n).toContain("'expertPanel.deleteConfirm'");
  });
});

describe('i18n — expert editor keys (zh-CN)', () => {
  let zhI18n;
  beforeAll(() => {
    zhI18n = readFileSync(join(rootDir, 'web/i18n/zh-CN.js'), 'utf8');
  });

  it('has expertEditor.createTitle', () => {
    expect(zhI18n).toContain("'expertEditor.createTitle'");
  });
  it('has expertEditor.editTitle', () => {
    expect(zhI18n).toContain("'expertEditor.editTitle'");
  });
  it('has expertEditor.roleName', () => {
    expect(zhI18n).toContain("'expertEditor.roleName'");
  });
  it('has expertEditor.save', () => {
    expect(zhI18n).toContain("'expertEditor.save'");
  });
  it('has expertPanel.customRoles', () => {
    expect(zhI18n).toContain("'expertPanel.customRoles'");
  });
  it('has expertPanel.addRole', () => {
    expect(zhI18n).toContain("'expertPanel.addRole'");
  });
  it('has expertPanel.deleteConfirm', () => {
    expect(zhI18n).toContain("'expertPanel.deleteConfirm'");
  });
});

// ===========================================================
// 6. CSS classes
// ===========================================================
describe('CSS — expert editor and custom role classes', () => {
  let css;
  beforeAll(() => {
    css = readFileSync(join(rootDir, 'web/styles/expert-panel.css'), 'utf8');
  });

  it('has .expert-editor-overlay', () => {
    expect(css).toContain('.expert-editor-overlay');
  });
  it('has .expert-editor-modal', () => {
    expect(css).toContain('.expert-editor-modal');
  });
  it('has .expert-editor-header', () => {
    expect(css).toContain('.expert-editor-header');
  });
  it('has .expert-editor-body', () => {
    expect(css).toContain('.expert-editor-body');
  });
  it('has .expert-editor-field', () => {
    expect(css).toContain('.expert-editor-field');
  });
  it('has .expert-editor-action-card', () => {
    expect(css).toContain('.expert-editor-action-card');
  });
  it('has .expert-editor-footer', () => {
    expect(css).toContain('.expert-editor-footer');
  });
  it('has .expert-editor-save', () => {
    expect(css).toContain('.expert-editor-save');
  });
  it('has .expert-add-role-btn', () => {
    expect(css).toContain('.expert-add-role-btn');
  });
  it('has .expert-custom-empty', () => {
    expect(css).toContain('.expert-custom-empty');
  });
  it('has .role-edit-btn', () => {
    expect(css).toContain('.role-edit-btn');
  });
  it('has .role-delete-btn', () => {
    expect(css).toContain('.role-delete-btn');
  });
  it('has .expert-delete-confirm', () => {
    expect(css).toContain('.expert-delete-confirm');
  });
  it('has dark theme overrides for editor', () => {
    expect(css).toMatch(/\[data-theme="dark"\]\s+\.expert-editor-modal/);
  });
  it('edit/delete buttons show on card hover', () => {
    expect(css).toContain('.expert-role-card:hover .role-edit-btn');
    expect(css).toContain('.expert-role-card:hover .role-delete-btn');
  });
});

// ===========================================================
// 7. ChatInput integration
// ===========================================================
describe('ChatInput — custom role integration', () => {
  let code;
  beforeAll(() => {
    code = readFileSync(join(rootDir, 'web/components/ChatInput.js'), 'utf8');
  });

  it('passes customExpertRoles to getSelectionLabel', () => {
    expect(code).toContain('store.customExpertRoles');
    expect(code).toContain('getSelectionLabel(sel, store.customExpertRoles)');
  });

  it('passes customExpertRoles to buildExpertAutocomplete', () => {
    expect(code).toContain('buildExpertAutocomplete(store.customExpertRoles)');
  });

  it('uses allExpertItems.value (computed)', () => {
    expect(code).toContain('allExpertItems.value');
  });
});

// ===========================================================
// 8. MessageItem integration
// ===========================================================
describe('MessageItem — custom role label', () => {
  let code;
  beforeAll(() => {
    code = readFileSync(join(rootDir, 'web/components/MessageItem.js'), 'utf8');
  });

  it('passes customExpertRoles to getSelectionLabel', () => {
    expect(code).toContain('store.customExpertRoles');
  });

  it('uses Pinia.useChatStore()', () => {
    expect(code).toContain('Pinia.useChatStore()');
  });
});
