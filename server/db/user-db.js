import { stmts, generateUserId, generateAgentSecret } from './connection.js';

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
    const existing = stmts.getUserByUsername.get(username);
    if (existing) {
      if (existing.password_hash) {
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

  getUserByAgentSecret(secret) {
    if (!secret) return null;
    return stmts.getUserByAgentSecret.get(secret) || null;
  },

  getAll() {
    return stmts.getAllUsers.all();
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
    return stmts.getUserByAadOid.get(aadOid) || null;
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
  }
};
