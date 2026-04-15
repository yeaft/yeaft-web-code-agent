/**
 * Tests for custom expert roles (task-266):
 * - Server DB CRUD (expert-db.js)
 * - REST API routes (expert-routes.js)
 * - Frontend buildClientExpertMessage
 * - Agent expertMessage handling
 * - Server message forwarding
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// ===========================================================
// 1. Database layer: expertDb equivalent on test DB
// ===========================================================
let db;

function createExpertDbOperations(db) {
  const stmts = {
    insertRole: db.prepare(`
      INSERT INTO custom_expert_roles (id, user_id, role_id, name, full_name, title, title_en, group_id, icon, message_prefix, message_prefix_en, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateRole: db.prepare(`
      UPDATE custom_expert_roles
      SET name = ?, full_name = ?, title = ?, title_en = ?, group_id = ?, icon = ?,
          message_prefix = ?, message_prefix_en = ?, updated_at = ?
      WHERE user_id = ? AND role_id = ?
    `),
    deleteRole: db.prepare(`
      DELETE FROM custom_expert_roles WHERE user_id = ? AND role_id = ?
    `),
    getRolesByUser: db.prepare(`
      SELECT * FROM custom_expert_roles WHERE user_id = ? ORDER BY created_at ASC
    `),
    getRoleByUserAndId: db.prepare(`
      SELECT * FROM custom_expert_roles WHERE user_id = ? AND role_id = ?
    `),
    insertAction: db.prepare(`
      INSERT INTO custom_expert_actions (id, role_row_id, action_id, name, name_en, message_template, message_template_en, default_message, default_message_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    deleteActionsByRole: db.prepare(`
      DELETE FROM custom_expert_actions WHERE role_row_id = ?
    `),
    getActionsByRole: db.prepare(`
      SELECT * FROM custom_expert_actions WHERE role_row_id = ? ORDER BY rowid ASC
    `)
  };

  const insertRoleWithActions = db.transaction((userId, roleData) => {
    const now = Date.now();
    const rowId = `cer_${randomUUID()}`;
    const roleId = roleData.roleId || `custom-${randomUUID().substring(0, 8)}`;

    stmts.insertRole.run(
      rowId, userId, roleId,
      roleData.name, roleData.fullName || null,
      roleData.title, roleData.titleEn || null,
      roleData.groupId || 'custom', roleData.icon || null,
      roleData.messagePrefix || null, roleData.messagePrefixEn || null,
      now, now
    );

    if (roleData.actions && roleData.actions.length > 0) {
      for (const action of roleData.actions) {
        stmts.insertAction.run(
          `cea_${randomUUID()}`, rowId,
          action.actionId || action.id,
          action.name, action.nameEn || null,
          action.messageTemplate || null, action.messageTemplateEn || null,
          action.defaultMessage || null, action.defaultMessageEn || null
        );
      }
    }

    return { rowId, roleId };
  });

  const updateRoleWithActions = db.transaction((userId, roleId, roleData) => {
    const now = Date.now();

    stmts.updateRole.run(
      roleData.name, roleData.fullName || null,
      roleData.title, roleData.titleEn || null,
      roleData.groupId || 'custom', roleData.icon || null,
      roleData.messagePrefix || null, roleData.messagePrefixEn || null,
      now, userId, roleId
    );

    const row = stmts.getRoleByUserAndId.get(userId, roleId);
    if (!row) throw new Error(`Role not found: ${roleId}`);

    stmts.deleteActionsByRole.run(row.id);
    if (roleData.actions && roleData.actions.length > 0) {
      for (const action of roleData.actions) {
        stmts.insertAction.run(
          `cea_${randomUUID()}`, row.id,
          action.actionId || action.id,
          action.name, action.nameEn || null,
          action.messageTemplate || null, action.messageTemplateEn || null,
          action.defaultMessage || null, action.defaultMessageEn || null
        );
      }
    }
  });

  function transformRole(roleRow, actionRows) {
    return {
      id: roleRow.role_id,
      name: roleRow.name,
      fullName: roleRow.full_name,
      title: roleRow.title,
      titleEn: roleRow.title_en,
      groupId: roleRow.group_id,
      icon: roleRow.icon,
      messagePrefix: roleRow.message_prefix,
      messagePrefixEn: roleRow.message_prefix_en,
      createdAt: roleRow.created_at,
      updatedAt: roleRow.updated_at,
      actions: actionRows.map(a => ({
        id: a.action_id,
        name: a.name,
        nameEn: a.name_en,
        messageTemplate: a.message_template,
        messageTemplateEn: a.message_template_en,
        defaultMessage: a.default_message,
        defaultMessageEn: a.default_message_en
      }))
    };
  }

  return {
    getCustomRolesByUser(userId) {
      const rows = stmts.getRolesByUser.all(userId);
      return rows.map(row => {
        const actions = stmts.getActionsByRole.all(row.id);
        return transformRole(row, actions);
      });
    },
    createCustomRole(userId, roleData) {
      return insertRoleWithActions(userId, roleData);
    },
    updateCustomRole(userId, roleId, roleData) {
      updateRoleWithActions(userId, roleId, roleData);
    },
    deleteCustomRole(userId, roleId) {
      const result = stmts.deleteRole.run(userId, roleId);
      return result.changes > 0;
    },
    exists(userId, roleId) {
      return !!stmts.getRoleByUserAndId.get(userId, roleId);
    }
  };
}

// Add expert tables to the test DB
function addExpertTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_expert_roles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      role_id TEXT NOT NULL,
      name TEXT NOT NULL,
      full_name TEXT,
      title TEXT NOT NULL,
      title_en TEXT,
      group_id TEXT NOT NULL DEFAULT 'custom',
      icon TEXT,
      message_prefix TEXT,
      message_prefix_en TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS custom_expert_actions (
      id TEXT PRIMARY KEY,
      role_row_id TEXT NOT NULL REFERENCES custom_expert_roles(id) ON DELETE CASCADE,
      action_id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_en TEXT,
      message_template TEXT,
      message_template_en TEXT,
      default_message TEXT,
      default_message_en TEXT,
      UNIQUE(role_row_id, action_id)
    );
    CREATE INDEX IF NOT EXISTS idx_custom_expert_roles_user ON custom_expert_roles(user_id);
    CREATE INDEX IF NOT EXISTS idx_custom_expert_actions_role ON custom_expert_actions(role_row_id);
  `);
}

let expertDb;

beforeEach(() => {
  if (db) { try { db.close(); } catch (e) {} }
  const result = createTestDb();
  db = result.db;
  addExpertTables(db);
  expertDb = createExpertDbOperations(db);
});

afterAll(() => { cleanupTestDb(); });

// ===========================================================
// Test: Database CRUD
// ===========================================================
describe('expertDb CRUD', () => {
  const userId = 'user_test_123';

  it('should create a custom role with actions', () => {
    const { rowId, roleId } = expertDb.createCustomRole(userId, {
      name: '测试专家',
      title: '测试工程师',
      titleEn: 'Test Engineer',
      icon: '🧪',
      messagePrefix: '请以测试专家身份：',
      messagePrefixEn: 'As a test expert: ',
      actions: [
        {
          actionId: 'unit-test',
          name: '单元测试',
          nameEn: 'Unit Test',
          messageTemplate: '请帮我写单元测试：',
          messageTemplateEn: 'Please write unit tests: ',
          defaultMessage: '请审查当前代码的测试覆盖率',
          defaultMessageEn: 'Please review test coverage for the current code'
        }
      ]
    });

    expect(rowId).toMatch(/^cer_/);
    expect(roleId).toMatch(/^custom-/);

    const roles = expertDb.getCustomRolesByUser(userId);
    expect(roles).toHaveLength(1);
    expect(roles[0].id).toBe(roleId);
    expect(roles[0].name).toBe('测试专家');
    expect(roles[0].title).toBe('测试工程师');
    expect(roles[0].icon).toBe('🧪');
    expect(roles[0].actions).toHaveLength(1);
    expect(roles[0].actions[0].id).toBe('unit-test');
    expect(roles[0].actions[0].name).toBe('单元测试');
    expect(roles[0].actions[0].messageTemplate).toBe('请帮我写单元测试：');
  });

  it('should create a role without actions', () => {
    const { roleId } = expertDb.createCustomRole(userId, {
      name: '空角色',
      title: '无动作角色'
    });

    const roles = expertDb.getCustomRolesByUser(userId);
    expect(roles).toHaveLength(1);
    expect(roles[0].actions).toHaveLength(0);
    expect(roles[0].groupId).toBe('custom'); // default
  });

  it('should create a role with custom roleId', () => {
    const { roleId } = expertDb.createCustomRole(userId, {
      roleId: 'my-custom-id',
      name: 'Named Role',
      title: 'Title'
    });

    expect(roleId).toBe('my-custom-id');
    expect(expertDb.exists(userId, 'my-custom-id')).toBe(true);
  });

  it('should return empty array for user with no roles', () => {
    const roles = expertDb.getCustomRolesByUser('nonexistent-user');
    expect(roles).toEqual([]);
  });

  it('should isolate roles by user', () => {
    expertDb.createCustomRole('user-a', { name: 'Role A', title: 'Title A' });
    expertDb.createCustomRole('user-b', { name: 'Role B', title: 'Title B' });

    expect(expertDb.getCustomRolesByUser('user-a')).toHaveLength(1);
    expect(expertDb.getCustomRolesByUser('user-b')).toHaveLength(1);
    expect(expertDb.getCustomRolesByUser('user-a')[0].name).toBe('Role A');
    expect(expertDb.getCustomRolesByUser('user-b')[0].name).toBe('Role B');
  });

  it('should enforce unique (user_id, role_id) constraint', () => {
    expertDb.createCustomRole(userId, { roleId: 'dup', name: 'First', title: 'T' });
    expect(() => {
      expertDb.createCustomRole(userId, { roleId: 'dup', name: 'Second', title: 'T' });
    }).toThrow(/UNIQUE constraint/);
  });

  it('should update a role and replace actions', () => {
    const { roleId } = expertDb.createCustomRole(userId, {
      name: 'Original',
      title: 'Original Title',
      actions: [
        { actionId: 'act-1', name: 'Action 1' }
      ]
    });

    expertDb.updateCustomRole(userId, roleId, {
      name: 'Updated',
      title: 'Updated Title',
      fullName: 'Updated Full Name',
      actions: [
        { actionId: 'act-2', name: 'Action 2' },
        { actionId: 'act-3', name: 'Action 3' }
      ]
    });

    const roles = expertDb.getCustomRolesByUser(userId);
    expect(roles).toHaveLength(1);
    expect(roles[0].name).toBe('Updated');
    expect(roles[0].title).toBe('Updated Title');
    expect(roles[0].fullName).toBe('Updated Full Name');
    expect(roles[0].actions).toHaveLength(2);
    expect(roles[0].actions[0].id).toBe('act-2');
    expect(roles[0].actions[1].id).toBe('act-3');
  });

  it('should throw when updating non-existent role', () => {
    expect(() => {
      expertDb.updateCustomRole(userId, 'nonexistent', { name: 'X', title: 'Y' });
    }).toThrow();
  });

  it('should delete a role', () => {
    const { roleId } = expertDb.createCustomRole(userId, { name: 'ToDelete', title: 'T' });
    expect(expertDb.exists(userId, roleId)).toBe(true);

    const deleted = expertDb.deleteCustomRole(userId, roleId);
    expect(deleted).toBe(true);
    expect(expertDb.exists(userId, roleId)).toBe(false);
    expect(expertDb.getCustomRolesByUser(userId)).toHaveLength(0);
  });

  it('should return false when deleting non-existent role', () => {
    const deleted = expertDb.deleteCustomRole(userId, 'no-such-role');
    expect(deleted).toBe(false);
  });

  it('should cascade-delete actions when role is deleted', () => {
    // Enable foreign keys for cascade to work
    db.pragma('foreign_keys = ON');

    // Create a user first (needed with FK ON)
    const ops = createDbOperations(db);
    const user = ops.userDb.getOrCreate('cascade-tester');

    const { roleId } = expertDb.createCustomRole(user.id, {
      name: 'WithActions',
      title: 'T',
      actions: [
        { actionId: 'a1', name: 'A1' },
        { actionId: 'a2', name: 'A2' }
      ]
    });

    // Verify actions exist
    let roles = expertDb.getCustomRolesByUser(user.id);
    expect(roles[0].actions).toHaveLength(2);

    // Delete role — actions should cascade
    expertDb.deleteCustomRole(user.id, roleId);

    // Verify no orphaned actions
    const orphanedActions = db.prepare('SELECT COUNT(*) as cnt FROM custom_expert_actions').get();
    expect(orphanedActions.cnt).toBe(0);
  });

  it('should check existence correctly', () => {
    expect(expertDb.exists(userId, 'nope')).toBe(false);

    const { roleId } = expertDb.createCustomRole(userId, { name: 'E', title: 'T' });
    expect(expertDb.exists(userId, roleId)).toBe(true);
    expect(expertDb.exists('other-user', roleId)).toBe(false);
  });

  it('should handle multiple actions with all fields', () => {
    const { roleId } = expertDb.createCustomRole(userId, {
      name: '多动作',
      title: '测试',
      actions: [
        {
          actionId: 'full',
          name: '完整动作',
          nameEn: 'Full Action',
          messageTemplate: '模板：',
          messageTemplateEn: 'Template: ',
          defaultMessage: '默认消息',
          defaultMessageEn: 'Default message'
        }
      ]
    });

    const roles = expertDb.getCustomRolesByUser(userId);
    const action = roles[0].actions[0];
    expect(action.id).toBe('full');
    expect(action.name).toBe('完整动作');
    expect(action.nameEn).toBe('Full Action');
    expect(action.messageTemplate).toBe('模板：');
    expect(action.messageTemplateEn).toBe('Template: ');
    expect(action.defaultMessage).toBe('默认消息');
    expect(action.defaultMessageEn).toBe('Default message');
  });
});

// ===========================================================
// Test: buildClientExpertMessage (frontend)
// ===========================================================
describe('buildClientExpertMessage', () => {
  // Import the function (it's a pure utility, no Vue deps)
  let buildClientExpertMessage, EXPERT_ROLES;

  beforeEach(async () => {
    const mod = await import(join(ROOT, 'web/utils/expert-roles.js'));
    buildClientExpertMessage = mod.buildClientExpertMessage;
    EXPERT_ROLES = mod.EXPERT_ROLES;
  });

  const customRoles = [
    {
      id: 'custom-abc',
      name: '自定义专家',
      title: '测试',
      messagePrefix: '作为自定义专家：',
      messagePrefixEn: 'As custom expert: ',
      actions: [
        {
          id: 'act-1',
          name: '动作一',
          messageTemplate: '请执行动作一：',
          messageTemplateEn: 'Execute action 1: ',
          defaultMessage: '请执行默认动作一',
          defaultMessageEn: 'Execute default action 1'
        }
      ]
    }
  ];

  it('should return null for empty selections', () => {
    expect(buildClientExpertMessage([], customRoles, 'test')).toBeNull();
    expect(buildClientExpertMessage(null, customRoles, 'test')).toBeNull();
  });

  it('should return null for empty customRoles', () => {
    expect(buildClientExpertMessage([{ role: 'custom-abc' }], [], 'test')).toBeNull();
    expect(buildClientExpertMessage([{ role: 'custom-abc' }], null, 'test')).toBeNull();
  });

  it('should return null for built-in role selections', () => {
    // Pick any built-in role id
    const builtinId = Object.keys(EXPERT_ROLES)[0];
    const result = buildClientExpertMessage([{ role: builtinId }], customRoles, 'test');
    expect(result).toBeNull();
  });

  it('should build prompt for custom role + user text (zh-CN)', () => {
    const result = buildClientExpertMessage(
      [{ role: 'custom-abc' }],
      customRoles,
      '帮我看看代码',
      'zh-CN'
    );
    expect(result).not.toBeNull();
    expect(result.effectivePrompt).toBe('作为自定义专家：帮我看看代码');
  });

  it('should build prompt for custom role + user text (en)', () => {
    const result = buildClientExpertMessage(
      [{ role: 'custom-abc' }],
      customRoles,
      'review my code',
      'en'
    );
    expect(result).not.toBeNull();
    expect(result.effectivePrompt).toBe('As custom expert: review my code');
  });

  it('should build prompt for custom role + action + user text', () => {
    const result = buildClientExpertMessage(
      [{ role: 'custom-abc', action: 'act-1' }],
      customRoles,
      '这段代码',
      'zh-CN'
    );
    expect(result).not.toBeNull();
    expect(result.effectivePrompt).toBe('请执行动作一：这段代码');
  });

  it('should use default message when action has no user text', () => {
    const result = buildClientExpertMessage(
      [{ role: 'custom-abc', action: 'act-1' }],
      customRoles,
      '', // empty user text
      'zh-CN'
    );
    expect(result).not.toBeNull();
    expect(result.effectivePrompt).toBe('请执行默认动作一');
  });

  it('should fall back to role prefix for unknown action', () => {
    const result = buildClientExpertMessage(
      [{ role: 'custom-abc', action: 'nonexistent-action' }],
      customRoles,
      '问题',
      'zh-CN'
    );
    expect(result).not.toBeNull();
    expect(result.effectivePrompt).toBe('作为自定义专家：问题');
  });

  it('should return null for unrecognized role', () => {
    const result = buildClientExpertMessage(
      [{ role: 'unknown-role' }],
      customRoles,
      'test'
    );
    expect(result).toBeNull();
  });
});

// ===========================================================
// Test: Code structure verification (agent + server forwarding)
// ===========================================================
describe('Code structure: agent expertMessage handling', () => {
  it('agent/conversation.js should check msg.expertMessage before buildExpertMessage', () => {
    const code = readFileSync(join(ROOT, 'agent/conversation.js'), 'utf8');

    // Must contain the expertMessage check
    expect(code).toContain('msg.expertMessage');

    // The expertMessage branch should come BEFORE the buildExpertMessage branch
    const expertMessageIdx = code.indexOf('msg.expertMessage');
    const buildExpertIdx = code.indexOf('buildExpertMessage');
    expect(expertMessageIdx).toBeGreaterThan(0);
    expect(buildExpertIdx).toBeGreaterThan(0);
    expect(expertMessageIdx).toBeLessThan(buildExpertIdx);
  });

  it('agent/conversation.js should assign effectivePrompt from expertMessage', () => {
    const code = readFileSync(join(ROOT, 'agent/conversation.js'), 'utf8');
    // Must have the pattern: effectivePrompt = msg.expertMessage
    expect(code).toMatch(/effectivePrompt\s*=\s*msg\.expertMessage/);
  });
});

describe('Code structure: server message forwarding', () => {
  it('server/handlers/client-conversation.js should forward expertMessage field', () => {
    const code = readFileSync(join(ROOT, 'server/handlers/client-conversation.js'), 'utf8');
    expect(code).toContain('expertMessage');
    // Should pass it as part of the forwarded message
    expect(code).toMatch(/expertMessage:\s*msg\.expertMessage/);
  });
});

describe('Code structure: frontend conversation helpers', () => {
  it('web/stores/helpers/conversation.js should import buildClientExpertMessage', () => {
    const code = readFileSync(join(ROOT, 'web/stores/helpers/conversation.js'), 'utf8');
    expect(code).toContain('buildClientExpertMessage');
  });

  it('web/stores/helpers/conversation.js should set wsMsg.expertMessage from buildClientExpertMessage result', () => {
    const code = readFileSync(join(ROOT, 'web/stores/helpers/conversation.js'), 'utf8');
    expect(code).toContain('wsMsg.expertMessage');
    expect(code).toContain('customResult.effectivePrompt');
  });
});

describe('Code structure: REST API registration', () => {
  it('server/api.js should import and register expert routes', () => {
    const code = readFileSync(join(ROOT, 'server/api.js'), 'utf8');
    expect(code).toContain('registerExpertRoutes');
    expect(code).toContain('expert-routes');
  });

  it('server/routes/expert-routes.js should export registerExpertRoutes', () => {
    const code = readFileSync(join(ROOT, 'server/routes/expert-routes.js'), 'utf8');
    expect(code).toContain('export function registerExpertRoutes');
  });

  it('server/database.js should re-export expertDb', () => {
    const code = readFileSync(join(ROOT, 'server/database.js'), 'utf8');
    expect(code).toContain('expertDb');
    expect(code).toContain('expert-db');
  });
});

describe('Code structure: DB migration', () => {
  it('server/db/connection.js should create custom_expert_roles and custom_expert_actions tables', () => {
    const code = readFileSync(join(ROOT, 'server/db/connection.js'), 'utf8');
    expect(code).toContain('CREATE TABLE IF NOT EXISTS custom_expert_roles');
    expect(code).toContain('CREATE TABLE IF NOT EXISTS custom_expert_actions');
    expect(code).toContain('idx_custom_expert_roles_user');
    expect(code).toContain('idx_custom_expert_actions_role');
  });
});

describe('Code structure: store CRUD methods', () => {
  it('web/stores/chat.js should have customExpertRoles state', () => {
    const code = readFileSync(join(ROOT, 'web/stores/chat.js'), 'utf8');
    expect(code).toContain('customExpertRoles');
  });

  it('web/stores/chat.js should have fetchCustomExpertRoles action', () => {
    const code = readFileSync(join(ROOT, 'web/stores/chat.js'), 'utf8');
    expect(code).toContain('async fetchCustomExpertRoles');
    expect(code).toContain('/api/expert-roles/custom');
  });

  it('web/stores/chat.js should have createCustomExpertRole action', () => {
    const code = readFileSync(join(ROOT, 'web/stores/chat.js'), 'utf8');
    expect(code).toContain('async createCustomExpertRole');
    expect(code).toMatch(/method:\s*['"]POST['"]/);
  });

  it('web/stores/chat.js should have updateCustomExpertRole action', () => {
    const code = readFileSync(join(ROOT, 'web/stores/chat.js'), 'utf8');
    expect(code).toContain('async updateCustomExpertRole');
    expect(code).toMatch(/method:\s*['"]PUT['"]/);
  });

  it('web/stores/chat.js should have deleteCustomExpertRole action', () => {
    const code = readFileSync(join(ROOT, 'web/stores/chat.js'), 'utf8');
    expect(code).toContain('async deleteCustomExpertRole');
    expect(code).toMatch(/method:\s*['"]DELETE['"]/);
  });
});
