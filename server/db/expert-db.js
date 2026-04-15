import { randomUUID } from 'crypto';
import db from './connection.js';

// Prepared statements
const stmts = {
  // Roles
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

  // Actions
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

// Transaction wrappers
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

  // Get the row id to replace actions
  const row = stmts.getRoleByUserAndId.get(userId, roleId);
  if (!row) throw new Error(`Role not found: ${roleId}`);

  // Replace all actions
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

/**
 * Transform DB rows into the API response format.
 */
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

export const expertDb = {
  /**
   * Get all custom roles for a user, with nested actions.
   */
  getCustomRolesByUser(userId) {
    const rows = stmts.getRolesByUser.all(userId);
    return rows.map(row => {
      const actions = stmts.getActionsByRole.all(row.id);
      return transformRole(row, actions);
    });
  },

  /**
   * Create a custom role with actions (transactional).
   * @returns {{ rowId: string, roleId: string }}
   */
  createCustomRole(userId, roleData) {
    return insertRoleWithActions(userId, roleData);
  },

  /**
   * Update a custom role and replace its actions (transactional).
   */
  updateCustomRole(userId, roleId, roleData) {
    updateRoleWithActions(userId, roleId, roleData);
  },

  /**
   * Delete a custom role (CASCADE deletes actions).
   * @returns {boolean} true if deleted
   */
  deleteCustomRole(userId, roleId) {
    const result = stmts.deleteRole.run(userId, roleId);
    return result.changes > 0;
  },

  /**
   * Check if a role exists for a user.
   */
  exists(userId, roleId) {
    return !!stmts.getRoleByUserAndId.get(userId, roleId);
  }
};
