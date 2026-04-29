/**
 * Password reset module tests.
 *
 * Mocks server/config.js, server/database.js, and server/email.js so we can
 * exercise the full request → email → verify flow in isolation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const _users = new Map();
const _sentEmails = [];
let _emailEnabled = true;

vi.mock('../../server/config.js', () => ({
  CONFIG: {},
  isEmailConfigured: () => _emailEnabled,
}));

vi.mock('../../server/database.js', () => ({
  userDb: {
    getAll: () => Array.from(_users.values()),
    get: (id) => _users.get(id) || null,
    updatePassword: (id, hash) => {
      const u = _users.get(id);
      if (u) u.password_hash = hash;
    },
  },
}));

vi.mock('../../server/email.js', () => ({
  sendVerificationCode: vi.fn(async (email, code, username) => {
    _sentEmails.push({ email, code, username });
  }),
}));

let requestPasswordReset, verifyPasswordReset, _resetPasswordResetStore;

beforeEach(async () => {
  _users.clear();
  _sentEmails.length = 0;
  _emailEnabled = true;
  ({ requestPasswordReset, verifyPasswordReset, _resetPasswordResetStore } =
    await import('../../server/auth/password-reset.js'));
  _resetPasswordResetStore();
});

describe('requestPasswordReset', () => {
  it('returns success+real token and sends email when account exists', async () => {
    _users.set('u1', { id: 'u1', username: 'alice', email: 'alice@example.com', password_hash: 'old' });
    const r = await requestPasswordReset('alice@example.com');
    expect(r.success).toBe(true);
    expect(r.resetToken).toMatch(/^rst_/);
    expect(_sentEmails).toHaveLength(1);
    expect(_sentEmails[0].email).toBe('alice@example.com');
  });

  it('returns success+fake token (no email sent) for unknown account', async () => {
    const r = await requestPasswordReset('nobody@example.com');
    expect(r.success).toBe(true);
    expect(r.resetToken).toMatch(/^fake_/);
    expect(_sentEmails).toHaveLength(0);
  });

  it('matches email case-insensitively', async () => {
    _users.set('u1', { id: 'u1', username: 'bob', email: 'Bob@Example.COM', password_hash: 'old' });
    const r = await requestPasswordReset('bob@example.com');
    expect(r.resetToken).toMatch(/^rst_/);
  });

  it('returns failure when email is not configured', async () => {
    _emailEnabled = false;
    const r = await requestPasswordReset('alice@example.com');
    expect(r.success).toBe(false);
  });

  it('rejects empty email', async () => {
    const r = await requestPasswordReset('');
    expect(r.success).toBe(false);
  });
});

describe('verifyPasswordReset', () => {
  it('replaces password on correct code', async () => {
    _users.set('u1', { id: 'u1', username: 'alice', email: 'a@x.com', password_hash: 'old' });
    const { resetToken } = await requestPasswordReset('a@x.com');
    const code = _sentEmails[0].code;
    const r = await verifyPasswordReset(resetToken, code, 'newPass123');
    expect(r.success).toBe(true);
    expect(_users.get('u1').password_hash).not.toBe('old');
  });

  it('rejects wrong code', async () => {
    _users.set('u1', { id: 'u1', username: 'alice', email: 'a@x.com', password_hash: 'old' });
    const { resetToken } = await requestPasswordReset('a@x.com');
    const r = await verifyPasswordReset(resetToken, '000000', 'newPass123');
    expect(r.success).toBe(false);
    expect(_users.get('u1').password_hash).toBe('old');
  });

  it('rejects unknown reset token', async () => {
    const r = await verifyPasswordReset('rst_unknown', '123456', 'newPass123');
    expect(r.success).toBe(false);
  });

  it('rejects fake (anti-enumeration) token', async () => {
    const { resetToken } = await requestPasswordReset('nobody@example.com');
    const r = await verifyPasswordReset(resetToken, '123456', 'newPass123');
    expect(r.success).toBe(false);
  });

  it('rejects short new password', async () => {
    _users.set('u1', { id: 'u1', username: 'alice', email: 'a@x.com', password_hash: 'old' });
    const { resetToken } = await requestPasswordReset('a@x.com');
    const code = _sentEmails[0].code;
    const r = await verifyPasswordReset(resetToken, code, 'abc');
    expect(r.success).toBe(false);
  });

  it('one-time-use: token cannot be reused after success', async () => {
    _users.set('u1', { id: 'u1', username: 'alice', email: 'a@x.com', password_hash: 'old' });
    const { resetToken } = await requestPasswordReset('a@x.com');
    const code = _sentEmails[0].code;
    const r1 = await verifyPasswordReset(resetToken, code, 'newPass123');
    expect(r1.success).toBe(true);
    const r2 = await verifyPasswordReset(resetToken, code, 'anotherPass456');
    expect(r2.success).toBe(false);
  });

  it('caps brute-force attempts and invalidates token after 5 wrong codes', async () => {
    _users.set('u1', { id: 'u1', username: 'alice', email: 'a@x.com', password_hash: 'old' });
    const { resetToken } = await requestPasswordReset('a@x.com');
    const realCode = _sentEmails[0].code;
    for (let i = 0; i < 5; i++) {
      const r = await verifyPasswordReset(resetToken, '000000', 'newPass123');
      expect(r.success).toBe(false);
    }
    // After 5 wrong attempts, even the right code should be rejected.
    const r6 = await verifyPasswordReset(resetToken, realCode, 'newPass123');
    expect(r6.success).toBe(false);
    expect(_users.get('u1').password_hash).toBe('old');
  });
});
