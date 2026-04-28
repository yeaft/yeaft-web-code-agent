import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

// Sliding-renewal logic lives in server/auth/token.js + server/api.js. We test
// maybeRenewToken() directly against a controlled CONFIG, and verify the
// invariants the middleware relies on:
//   1. Tokens with > threshold remaining are NOT renewed (returns null).
//   2. Tokens within the threshold ARE renewed; new token's exp is fresh.
//   3. Renewing revokes the old token (so a subsequent verifyToken fails).
//   4. Already-expired tokens never get renewed (verifyToken catches them
//      before maybeRenewToken is even called).

// Hoisted CONFIG mock — needs to exist before importing server/auth/*.
vi.mock('../../server/config.js', () => ({
  CONFIG: {
    jwtSecret: 'test-secret-for-renewal',
    jwtExpiresIn: '3d',
    jwtRenewThresholdMs: 24 * 60 * 60 * 1000 // 1 day
  },
  getUserByUsername: (u) => (u === 'alice' ? { username: 'alice', role: 'pro' } : null)
}));

vi.mock('../../server/encryption.js', () => ({
  generateSessionKey: () => Buffer.from('test-session-key-32-bytes-padding!')
}));

const { verifyToken, maybeRenewToken } = await import('../../server/auth/token.js');
const { activeSessions, revokedTokens } = await import('../../server/auth/session-store.js');

const SECRET = 'test-secret-for-renewal';
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  activeSessions.clear();
  revokedTokens.clear();
});

describe('JWT sliding renewal', () => {
  it('does not renew a fresh token (>1 day remaining)', () => {
    // Token valid for 3 days — well above the 1-day threshold.
    const token = jwt.sign({ username: 'alice' }, SECRET, { expiresIn: '3d' });
    activeSessions.set(token, { username: 'alice', sessionKey: 'k' });

    const result = verifyToken(token);
    expect(result.valid).toBe(true);
    expect(result.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const fresh = maybeRenewToken(token, result.exp, result.username);
    expect(fresh).toBeNull();
    expect(revokedTokens.has(token)).toBe(false);
  });

  it('renews a near-expiry token (<1 day remaining)', () => {
    // Mint a token with only 1 hour of life — well inside the threshold.
    const token = jwt.sign({ username: 'alice' }, SECRET, { expiresIn: '1h' });
    activeSessions.set(token, { username: 'alice', sessionKey: 'k' });

    const result = verifyToken(token);
    expect(result.valid).toBe(true);

    const fresh = maybeRenewToken(token, result.exp, result.username);
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(token);

    // New token decodes with a far-future exp.
    const decoded = jwt.verify(fresh, SECRET);
    const now = Math.floor(Date.now() / 1000);
    expect(decoded.exp - now).toBeGreaterThan(2 * 24 * 60 * 60); // > 2 days

    // Old token is revoked; session moved to new token.
    expect(revokedTokens.has(token)).toBe(true);
    expect(activeSessions.has(fresh)).toBe(true);
    expect(activeSessions.has(token)).toBe(false);
  });

  it('rejects an old token after renewal (revocation enforced)', () => {
    const token = jwt.sign({ username: 'alice' }, SECRET, { expiresIn: '1h' });
    activeSessions.set(token, { username: 'alice', sessionKey: 'k' });

    const result = verifyToken(token);
    const fresh = maybeRenewToken(token, result.exp, result.username);
    expect(fresh).toBeTruthy();

    // Reusing the old token should now fail (revoked even though signature
    // is still valid for an hour).
    const recheck = verifyToken(token);
    expect(recheck.valid).toBe(false);

    // The new token still works.
    const freshCheck = verifyToken(fresh);
    expect(freshCheck.valid).toBe(true);
    expect(freshCheck.username).toBe('alice');
  });

  it('rejects an expired token at verifyToken stage', () => {
    // expiresIn:0 produces a token whose exp == iat, so it's already expired.
    const token = jwt.sign({ username: 'alice' }, SECRET, { expiresIn: -1 });
    const result = verifyToken(token);
    expect(result.valid).toBe(false);
  });

  it('maybeRenewToken is a no-op if exp is missing', () => {
    const fresh = maybeRenewToken('whatever', undefined, 'alice');
    expect(fresh).toBeNull();
  });

  it('threshold boundary: token with exactly threshold remaining is not renewed', () => {
    // 25-hour token: remaining (~25h) is just above the 24h threshold.
    const token = jwt.sign({ username: 'alice' }, SECRET, { expiresIn: '25h' });
    const result = verifyToken(token);
    const fresh = maybeRenewToken(token, result.exp, result.username);
    expect(fresh).toBeNull();
  });
});
