import jwt from 'jsonwebtoken';
import { CONFIG } from '../config.js';

// Store pending verifications (tempToken -> { username, code, expiresAt, sessionKey })
export const pendingVerifications = new Map();

// Store pending TOTP verifications (tempToken -> { username, sessionKey, expiresAt })
export const pendingTotpVerifications = new Map();

// Store pending TOTP setup (setupToken -> { username, secret, sessionKey, expiresAt })
export const pendingTotpSetup = new Map();

// Store active sessions (token -> { username, sessionKey })
export const activeSessions = new Map();

// Store revoked tokens
export const revokedTokens = new Set();
export const revokedSessions = new Map(); // sid -> expiry in milliseconds

const MAX_REVOKED_SESSIONS = 100_000;
let revokedThrough = -Infinity; // JWT iat in seconds, including that second

function pruneRevokedSessions(now) {
  for (const [sid, expiresAt] of revokedSessions) {
    if (expiresAt <= now) revokedSessions.delete(sid);
  }
}

export function recordSessionRevocation(sid, expiresAt, now) {
  if (revokedSessions.size >= MAX_REVOKED_SESSIONS) pruneRevokedSessions(now);
  if (!revokedSessions.has(sid) && revokedSessions.size >= MAX_REVOKED_SESSIONS) {
    // Fail closed under saturation: never evict a live revocation and thereby
    // restore a logged-out session. New logins in later seconds still work.
    revokedThrough = Math.max(revokedThrough, Math.floor(now / 1000));
    revokedSessions.clear();
    return;
  }
  revokedSessions.set(sid, Math.max(revokedSessions.get(sid) ?? 0, expiresAt));
}

export function isSessionRevoked(sid, issuedAt, now = Date.now()) {
  return issuedAt <= revokedThrough || (revokedSessions.get(sid) ?? 0) > now;
}

/**
 * Clean up expired pending verifications
 */
function cleanupPendingVerifications() {
  const now = Date.now();
  pruneRevokedSessions(now);
  for (const [token, data] of pendingVerifications.entries()) {
    if (data.expiresAt < now) {
      pendingVerifications.delete(token);
    }
  }
  for (const [token, data] of pendingTotpVerifications.entries()) {
    if (data.expiresAt < now) {
      pendingTotpVerifications.delete(token);
    }
  }
  for (const [token, data] of pendingTotpSetup.entries()) {
    if (data.expiresAt < now) {
      pendingTotpSetup.delete(token);
    }
  }
  // 清理过期的 activeSessions 和 revokedTokens（JWT 已过期的）
  for (const [token] of activeSessions.entries()) {
    try {
      jwt.verify(token, CONFIG.jwtSecret);
    } catch {
      activeSessions.delete(token);
    }
  }
  for (const token of revokedTokens) {
    try {
      jwt.verify(token, CONFIG.jwtSecret);
    } catch {
      revokedTokens.delete(token);
    }
  }
}

// Run cleanup every minute
setInterval(cleanupPendingVerifications, 60000);
