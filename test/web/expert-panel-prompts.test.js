import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Tests for task-265: Expert Panel Role Prompts — view role prompt definitions.
 *
 * Data flow:
 *   Agent (expert-roles.js) getExpertRolesDefinition()
 *     → message-router.js sends expert_roles_list
 *       → server (client-misc.js) get_expert_roles → forwards to agent
 *       → server (agent-sync.js) expert_roles_list → broadcasts to web clients
 *         → messageHandler.js stores in expertRoleDefinitions
 *           → ExpertPanel.js renders detail view with prompt content
 */

const rootDir = join(import.meta.dirname, '..', '..');
const expertPanelJs = readFileSync(join(rootDir, 'web/components/ExpertPanel.js'), 'utf8');
const expertPanelCss = readFileSync(join(rootDir, 'web/styles/expert-panel.css'), 'utf8');
const enI18n = readFileSync(join(rootDir, 'web/i18n/en.js'), 'utf8');
const zhI18n = readFileSync(join(rootDir, 'web/i18n/zh-CN.js'), 'utf8');
const chatStore = readFileSync(join(rootDir, 'web/stores/chat.js'), 'utf8');
const messageHandler = readFileSync(join(rootDir, 'web/stores/helpers/messageHandler.js'), 'utf8');
const agentExpertRoles = readFileSync(join(rootDir, 'agent/expert-roles.js'), 'utf8');
const messageRouter = readFileSync(join(rootDir, 'agent/connection/message-router.js'), 'utf8');
const clientMisc = readFileSync(join(rootDir, 'server/handlers/client-misc.js'), 'utf8');
const agentSync = readFileSync(join(rootDir, 'server/handlers/agent-sync.js'), 'utf8');

// =====================================================================
// 1. Agent — getExpertRolesDefinition() function
// =====================================================================
describe('Agent expert-roles.js — getExpertRolesDefinition', () => {
  it('exports getExpertRolesDefinition function', () => {
    expect(agentExpertRoles).toContain('export function getExpertRolesDefinition()');
  });

  it('returns result with messagePrefix per role', () => {
    expect(agentExpertRoles).toMatch(/result\[roleId\]\s*=\s*\{[\s\S]*messagePrefix/);
  });

  it('returns result with messagePrefixEn per role', () => {
    expect(agentExpertRoles).toMatch(/result\[roleId\]\s*=\s*\{[\s\S]*messagePrefixEn/);
  });

  it('returns actions with messageTemplate per action', () => {
    expect(agentExpertRoles).toMatch(/actions\[actionId\]\s*=\s*\{[\s\S]*messageTemplate:/);
  });

  it('returns actions with messageTemplateEn per action', () => {
    expect(agentExpertRoles).toMatch(/actions\[actionId\]\s*=\s*\{[\s\S]*messageTemplateEn/);
  });

  it('returns actions with defaultMessage per action', () => {
    expect(agentExpertRoles).toMatch(/actions\[actionId\]\s*=\s*\{[\s\S]*defaultMessage:/);
  });

  it('returns actions with defaultMessageEn per action', () => {
    expect(agentExpertRoles).toMatch(/actions\[actionId\]\s*=\s*\{[\s\S]*defaultMessageEn/);
  });
});

// =====================================================================
// 2. Agent message-router — handles get_expert_roles
// =====================================================================
describe('Agent message-router — get_expert_roles handler', () => {
  it('has case for get_expert_roles', () => {
    expect(messageRouter).toContain("case 'get_expert_roles'");
  });

  it('imports getExpertRolesDefinition dynamically', () => {
    expect(messageRouter).toContain('getExpertRolesDefinition');
  });

  it('sends expert_roles_list type to server', () => {
    expect(messageRouter).toContain("type: 'expert_roles_list'");
  });
});

// =====================================================================
// 3. Server — client-misc.js forwards get_expert_roles to agent
// =====================================================================
describe('Server client-misc.js — get_expert_roles handler', () => {
  it('has case for get_expert_roles', () => {
    expect(clientMisc).toContain("case 'get_expert_roles'");
  });

  it('forwards to agent with type get_expert_roles', () => {
    expect(clientMisc).toMatch(/forwardToAgent\([\s\S]*?type:\s*'get_expert_roles'/);
  });

  it('checks agent access before forwarding', () => {
    // After get_expert_roles case, there should be a checkAgentAccess call before the next case
    const idx = clientMisc.indexOf("case 'get_expert_roles'");
    expect(idx).toBeGreaterThan(-1);
    const nextCaseIdx = clientMisc.indexOf("case '", idx + 1);
    const block = nextCaseIdx > idx ? clientMisc.slice(idx, nextCaseIdx) : clientMisc.slice(idx);
    expect(block).toContain('checkAgentAccess');
  });
});

// =====================================================================
// 4. Server — agent-sync.js broadcasts expert_roles_list
// =====================================================================
describe('Server agent-sync.js — expert_roles_list handler', () => {
  it('has case for expert_roles_list', () => {
    expect(agentSync).toContain("case 'expert_roles_list'");
  });

  it('sends expert_roles_list type to web clients', () => {
    const caseBlock = agentSync.slice(
      agentSync.indexOf("case 'expert_roles_list'"),
      agentSync.indexOf('break;', agentSync.indexOf("case 'expert_roles_list'")) + 6
    );
    expect(caseBlock).toContain("type: 'expert_roles_list'");
  });

  it('forwards msg.roles to web clients', () => {
    const caseBlock = agentSync.slice(
      agentSync.indexOf("case 'expert_roles_list'"),
      agentSync.indexOf('break;', agentSync.indexOf("case 'expert_roles_list'")) + 6
    );
    expect(caseBlock).toContain('roles: msg.roles');
  });
});

// =====================================================================
// 5. Frontend store — expertRoleDefinitions state + handler
// =====================================================================
describe('Store chat.js — expertRoleDefinitions', () => {
  it('has expertRoleDefinitions state', () => {
    expect(chatStore).toContain('expertRoleDefinitions');
  });

  it('initializes expertRoleDefinitions as null', () => {
    expect(chatStore).toMatch(/expertRoleDefinitions:\s*null/);
  });

  it('has fetchExpertRoleDefinitions action', () => {
    expect(chatStore).toContain('fetchExpertRoleDefinitions');
  });

  it('fetchExpertRoleDefinitions sends get_expert_roles message', () => {
    expect(chatStore).toMatch(/type:\s*'get_expert_roles'/);
  });
});

describe('Store messageHandler — expert_roles_list handler', () => {
  it('handles expert_roles_list message type', () => {
    expect(messageHandler).toContain("case 'expert_roles_list'");
  });

  it('stores msg.roles into expertRoleDefinitions', () => {
    expect(messageHandler).toContain('store.expertRoleDefinitions');
  });
});

// =====================================================================
// 6. ExpertPanel.js — role detail view UI
// =====================================================================
describe('ExpertPanel.js — role detail view template', () => {
  it('has viewingRoleId ref', () => {
    expect(expertPanelJs).toContain('viewingRoleId');
  });

  it('has viewingRoleMeta computed', () => {
    expect(expertPanelJs).toContain('viewingRoleMeta');
  });

  it('has viewingRoleDef computed', () => {
    expect(expertPanelJs).toContain('viewingRoleDef');
  });

  it('has viewRole function', () => {
    expect(expertPanelJs).toContain('viewRole');
  });

  it('has role detail container element', () => {
    expect(expertPanelJs).toContain('expert-role-detail');
  });

  it('has back button in detail view', () => {
    expect(expertPanelJs).toContain('expert-role-detail-back');
  });

  it('has role name in detail header', () => {
    expect(expertPanelJs).toContain('expert-role-detail-name');
  });

  it('has detail body with prompt sections', () => {
    expect(expertPanelJs).toContain('expert-role-detail-body');
    expect(expertPanelJs).toContain('expert-prompt-section');
  });

  it('shows persona prompt (messagePrefix)', () => {
    expect(expertPanelJs).toContain('viewingRoleDef.messagePrefix');
    expect(expertPanelJs).toContain('viewingRoleDef.messagePrefixEn');
  });

  it('shows action messageTemplate', () => {
    expect(expertPanelJs).toContain('actionDef.messageTemplate');
    expect(expertPanelJs).toContain('actionDef.messageTemplateEn');
  });

  it('shows action defaultMessage', () => {
    expect(expertPanelJs).toContain('actionDef.defaultMessage');
    expect(expertPanelJs).toContain('actionDef.defaultMessageEn');
  });

  it('has pre tags for prompt content', () => {
    expect(expertPanelJs).toContain('expert-prompt-content');
  });

  it('has loading state when definitions not yet loaded', () => {
    expect(expertPanelJs).toContain('expert-prompt-loading');
  });

  it('has eye icon button to view role prompts', () => {
    expect(expertPanelJs).toContain('role-view-btn');
  });

  it('hides role list when viewing detail', () => {
    expect(expertPanelJs).toContain('v-show="!viewingRoleId"');
  });

  it('conditionally shows detail view based on viewingRoleId', () => {
    expect(expertPanelJs).toContain('v-if="viewingRoleId"');
  });

  it('uses isZh for bilingual prompt display', () => {
    expect(expertPanelJs).toContain('isZh');
    expect(expertPanelJs).toMatch(/isZh\s*\?/);
  });
});

describe('ExpertPanel.js — auto-fetch definitions on panel open', () => {
  it('watches props.visible', () => {
    expect(expertPanelJs).toMatch(/Vue\.watch\(\(\)\s*=>\s*props\.visible/);
  });

  it('calls fetchExpertRoleDefinitions when panel opens', () => {
    expect(expertPanelJs).toContain('fetchExpertRoleDefinitions');
  });

  it('reads expertRoleDefinitions from store', () => {
    expect(expertPanelJs).toContain('store.expertRoleDefinitions');
  });
});

// =====================================================================
// 7. CSS — expert panel detail view styles
// =====================================================================
describe('CSS — expert panel detail view classes', () => {
  it('has .expert-role-detail class', () => {
    expect(expertPanelCss).toContain('.expert-role-detail');
  });

  it('has .expert-role-detail-header class', () => {
    expect(expertPanelCss).toContain('.expert-role-detail-header');
  });

  it('has .expert-role-detail-back class', () => {
    expect(expertPanelCss).toContain('.expert-role-detail-back');
  });

  it('has .expert-role-detail-name class', () => {
    expect(expertPanelCss).toContain('.expert-role-detail-name');
  });

  it('has .expert-role-detail-body class', () => {
    expect(expertPanelCss).toContain('.expert-role-detail-body');
  });

  it('has .expert-prompt-section class', () => {
    expect(expertPanelCss).toContain('.expert-prompt-section');
  });

  it('has .expert-prompt-label class', () => {
    expect(expertPanelCss).toContain('.expert-prompt-label');
  });

  it('has .expert-prompt-sublabel class', () => {
    expect(expertPanelCss).toContain('.expert-prompt-sublabel');
  });

  it('has .expert-prompt-content class', () => {
    expect(expertPanelCss).toContain('.expert-prompt-content');
  });

  it('has .expert-prompt-loading class', () => {
    expect(expertPanelCss).toContain('.expert-prompt-loading');
  });

  it('has .role-view-btn class', () => {
    expect(expertPanelCss).toContain('.role-view-btn');
  });

  it('role-view-btn shows on card hover', () => {
    expect(expertPanelCss).toContain('.expert-role-card:hover .role-view-btn');
  });

  it('has dark theme override for prompt content', () => {
    expect(expertPanelCss).toMatch(/\[data-theme="dark"\]\s+\.expert-prompt-content/);
  });
});

// =====================================================================
// 8. i18n — expert panel prompt-related keys
// =====================================================================
describe('i18n — expert panel prompt keys (en)', () => {
  it('has expertPanel.persona key', () => {
    expect(enI18n).toContain("'expertPanel.persona'");
  });

  it('has expertPanel.template key', () => {
    expect(enI18n).toContain("'expertPanel.template'");
  });

  it('has expertPanel.defaultMsg key', () => {
    expect(enI18n).toContain("'expertPanel.defaultMsg'");
  });

  it('has expertPanel.loading key', () => {
    expect(enI18n).toContain("'expertPanel.loading'");
  });

  it('has expertPanel.viewPrompt key', () => {
    expect(enI18n).toContain("'expertPanel.viewPrompt'");
  });
});

describe('i18n — expert panel prompt keys (zh-CN)', () => {
  it('has expertPanel.persona key', () => {
    expect(zhI18n).toContain("'expertPanel.persona'");
  });

  it('has expertPanel.template key', () => {
    expect(zhI18n).toContain("'expertPanel.template'");
  });

  it('has expertPanel.defaultMsg key', () => {
    expect(zhI18n).toContain("'expertPanel.defaultMsg'");
  });

  it('has expertPanel.loading key', () => {
    expect(zhI18n).toContain("'expertPanel.loading'");
  });

  it('has expertPanel.viewPrompt key', () => {
    expect(zhI18n).toContain("'expertPanel.viewPrompt'");
  });
});
