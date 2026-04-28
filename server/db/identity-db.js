import { randomUUID } from 'crypto';
import { stmts } from './connection.js';

/**
 * CRUD operations for user_identities — multi-provider SSO bindings.
 *
 * One internal user can have many identities (one per provider). The
 * UNIQUE(provider, subject) constraint enforces that a single provider
 * account (e.g. one GitHub account) can only be bound to one user.
 */
export const identityDb = {
  /**
   * Create a new identity row binding (user_id ↔ provider/subject).
   * Returns the inserted row, or null if the (provider, subject) is already
   * taken by another user (UNIQUE conflict).
   */
  create({ userId, provider, subject, email = null, displayName = null }) {
    const id = `idn_${randomUUID()}`;
    const now = Date.now();
    try {
      stmts.insertIdentity.run(id, userId, provider, subject, email, displayName, now, now);
      return { id, user_id: userId, provider, subject, email, display_name: displayName, created_at: now, last_login_at: now };
    } catch (err) {
      if (err && /UNIQUE/i.test(err.message || '')) return null;
      throw err;
    }
  },

  /**
   * Find the identity row for (provider, subject), or null.
   */
  findBySubject(provider, subject) {
    if (!provider || !subject) return null;
    return stmts.getIdentityBySubject.get(provider, subject) || null;
  },

  /**
   * Find a user's identity row for a specific provider, or null.
   */
  findForUser(userId, provider) {
    return stmts.getIdentityForUser.get(userId, provider) || null;
  },

  /**
   * List all identities for a user.
   */
  listForUser(userId) {
    return stmts.getIdentitiesByUser.all(userId);
  },

  /**
   * Count how many identities a user has bound.
   */
  countForUser(userId) {
    const row = stmts.countIdentitiesByUser.get(userId);
    return Number(row?.count || 0);
  },

  /**
   * Update last_login_at for an identity row.
   */
  touchLogin(id) {
    stmts.updateIdentityLogin.run(Date.now(), id);
  },

  /**
   * Remove a user's binding to a provider. Returns true if a row was deleted.
   */
  removeForUser(userId, provider) {
    const res = stmts.deleteIdentityForUser.run(userId, provider);
    return Number(res?.changes || 0) > 0;
  },

  /**
   * Idempotent upsert keyed by (provider, subject):
   * - If a row already exists for that subject, return it (do not move it to a different user).
   * - Otherwise create a new row bound to userId.
   *
   * Returns { row, created } so callers can tell whether the binding was new.
   */
  upsert({ userId, provider, subject, email = null, displayName = null }) {
    const existing = this.findBySubject(provider, subject);
    if (existing) {
      stmts.updateIdentityLogin.run(Date.now(), existing.id);
      return { row: existing, created: false };
    }
    const row = this.create({ userId, provider, subject, email, displayName });
    return { row, created: !!row };
  }
};

export default identityDb;
