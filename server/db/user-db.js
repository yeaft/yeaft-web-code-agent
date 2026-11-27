import { randomUUID } from 'crypto';
import db, { stmts, generateUserId, generateAgentSecret, transaction } from './connection.js';
import { purgeUserCosmicWebData } from './cosmic-web-db.js';


export const userDb = {
  getOrCreate(username, displayName = null) {
    let user = stmts.getUserByUsername.get(username);
    if (!user) {
      const id = generateUserId();
      const now = Date.now();
      stmts.insertUser.run(id, username, displayName || username, now);
      user = { id, username, display_name: displayName || username, created_at: now };
    }
    return user;
  },

  createFull(username, passwordHash, email = null, role = 'user') {
    const id = generateUserId();
    const now = Date.now();
    const agentSecret = generateAgentSecret();
    stmts.insertUserFull.run(id, username, username, passwordHash, email, agentSecret, role, now);
    return { id, username, display_name: username, password_hash: passwordHash, email, agent_secret: agentSecret, role, created_at: now };
  },

  migrateUser(username, passwordHash, email, role = 'admin') {
    if (this.isDeletionTombstoned(username)) return null;
    const existing = stmts.getUserByUsername.get(username);
    if (existing) {
      if ((existing.deletion_state && existing.deletion_state !== 'active') || existing.password_hash) {
        return existing;
      }
      const newSecret = generateAgentSecret();
      stmts.updateUserMigrate.run(passwordHash, email, role, newSecret, existing.id);
      return { ...existing, password_hash: passwordHash, email, role, agent_secret: existing.agent_secret || newSecret };
    }
    return this.createFull(username, passwordHash, email, role);
  },

  get(id) {
    return stmts.getUserById.get(id);
  },

  getByUsername(username) {
    return stmts.getUserByUsername.get(username);
  },

  isDeletionTombstoned(username) {
    return stmts.getUserDeletionTombstone.get(username) !== undefined;
  },

  getUserByAgentSecret(secret) {
    if (!secret) return null;
    return stmts.getUserByAgentSecret.get(secret) || null;
  },

  getAll() {
    return stmts.getAllUsers.all();
  },

  isActive(userId) {
    return db.prepare("SELECT 1 FROM users WHERE id = ? AND deletion_state = 'active'").get(userId) !== undefined;
  },

  beginDeletion(userId, now = Date.now()) {
    const pending = transaction(() => {
      const user = stmts.getUserById.get(userId);
      if (!user) return null;
      const deletionId = user.deletion_id || `deletion_${randomUUID()}`;
      if (user.deletion_state !== 'pending') {
        const changed = db.prepare(`
          UPDATE users SET deletion_state = 'pending', deletion_requested_at = ?, deletion_id = ?,
            password_hash = NULL, agent_secret = NULL, totp_secret = NULL, totp_enabled = 0
          WHERE id = ? AND deletion_state = 'active'
        `).run(now, deletionId, userId);
        if (changed.changes !== 1) throw new Error('ACCOUNT_DELETION_STATE_CONFLICT');
      }
      return { deletionId, status: 'pending', operationId: null };
    })();
    // Commit deactivation first: if the companion DB is unavailable, reconciliation retries the purge.
    if (pending) purgeUserCosmicWebData(userId);
    return pending;
  },

  reconcilePendingDeletions() {
    const pending = db.prepare("SELECT id FROM users WHERE deletion_state = 'pending'").all();
    let finalized = 0;
    for (const user of pending) {
      if (this.deleteUser(user.id, { requirePending: true })) finalized++;
    }
    return finalized;
  },

  updateLogin(id) {
    stmts.updateUserLogin.run(Date.now(), id);
  },

  updatePassword(userId, passwordHash) {
    stmts.updateUserPassword.run(passwordHash, userId);
  },

  updateEmail(userId, email) {
    stmts.updateUserEmail.run(email, userId);
  },

  updateDisplayName(userId, displayName) {
    if (!displayName) return;
    stmts.updateUserDisplayName.run(displayName, userId);
  },

  getAgentSecret(userId) {
    const user = stmts.getUserById.get(userId);
    return user?.agent_secret || null;
  },

  resetAgentSecret(userId) {
    const newSecret = generateAgentSecret();
    stmts.updateUserAgentSecret.run(newSecret, userId);
    return newSecret;
  },

  updateRole(userId, role) {
    stmts.updateUserRole.run(role, userId);
  },

  getTotp(username) {
    const result = stmts.getUserTotp.get(username);
    if (result) {
      return {
        totpSecret: result.totp_secret,
        totpEnabled: !!result.totp_enabled
      };
    }
    return null;
  },

  updateTotp(username, totpSecret, totpEnabled) {
    let user = stmts.getUserByUsername.get(username);
    if (!user) {
      const id = generateUserId();
      const now = Date.now();
      stmts.insertUser.run(id, username, username, now);
    }
    stmts.updateUserTotp.run(totpSecret, totpEnabled ? 1 : 0, username);
    return true;
  },

  getByAadOid(aadOid) {
    if (!aadOid) return null;
    const user = stmts.getUserByAadOid.get(aadOid) || null;
    return user?.deletion_state === 'active' ? user : null;
  },

  updateAadOid(userId, aadOid) {
    stmts.updateUserAadOid.run(aadOid, userId);
  },

  /**
   * Create a user from AAD profile (no password, linked by aad_oid).
   * `displayName` is used as a friendlier label (e.g. the Alipay nickname);
   * falls back to the username when not provided.
   */
  createFromAad(username, email, aadOid, role = 'pro', displayName = null) {
    const id = generateUserId();
    const now = Date.now();
    const agentSecret = generateAgentSecret();
    const display = displayName || username;
    stmts.insertUserFull.run(id, username, display, null, email, agentSecret, role, now);
    stmts.updateUserAadOid.run(aadOid, id);
    return { id, username, display_name: display, email, aad_oid: aadOid, agent_secret: agentSecret, role, created_at: now };
  },

  /**
   * Permanently delete a user and ALL data scoped to that user.
   *
   * Tables touched (all inside one transaction):
   *   - user_identities         hard delete (also covered by FK CASCADE, belt-and-braces)
   *   - sessions                hard delete (messages cascade via FK)
   *   - user_stats              hard delete
   *   - daily_stats             hard delete
   *   - agent_metric_watermarks cascade delete
   *   - custom_expert_roles     hard delete (custom_expert_actions cascade via FK)
   *   - invitations.created_by  rows deleted (codes the user issued)
   *   - invitations.used_by     set NULL (preserve history of *who consumed what* — but we lose the link)
   *   - users                   row deleted last
   *
   * Caller is responsible for revoking JWT sessions (we don't import the
   * session store from here to keep this layer pure).
   */
  deleteUser(userId, { requirePending = false } = {}) {
    const run = transaction((id) => {
      const user = stmts.getUserById.get(id);
      if (!user || (requirePending && user.deletion_state !== 'pending')) return false;

      stmts.deleteIdentitiesForUser.run(id);
      stmts.deleteUserSessionsByUser.run(id);
      stmts.deleteYeaftSessionsByUserCascade.run(id);
      stmts.deleteUserStats.run(id);
      stmts.deleteDailyStatsForUser.run(id);
      stmts.deleteCustomExpertRolesForUser.run(id);
      stmts.deleteLegacySandboxesForUser.run(id);
      stmts.deleteInvitationsCreatedBy.run(id);
      stmts.clearInvitationUsedBy.run(id);
      if (requirePending) {
        stmts.insertUserDeletionTombstone.run(user.username, user.deletion_id, Date.now());
      }
      purgeUserCosmicWebData(id);
      const result = stmts.deleteUserById.run(id);
      return result.changes > 0;
    });
    return run(userId);
  }
};
