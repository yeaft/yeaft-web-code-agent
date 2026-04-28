import jwt from 'jsonwebtoken';
import { CONFIG, getUserByUsername } from '../config.js';
import { generateSessionKey } from '../encryption.js';
import { activeSessions, revokedTokens } from './session-store.js';

/**
 * Verify JWT token and get session data.
 *
 * Returns `exp` (seconds since epoch, from JWT spec) so callers can decide
 * whether to issue a sliding-renewal token.
 */
export function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, CONFIG.jwtSecret);

    if (revokedTokens.has(token)) {
      return { valid: false };
    }

    let session = activeSessions.get(token);

    // Token 有效但 session 不存在（如服务器重启后），重建 session
    if (!session) {
      const sessionKey = generateSessionKey();
      session = { username: decoded.username, sessionKey };
      activeSessions.set(token, session);
    }

    const user = getUserByUsername(decoded.username);

    return {
      valid: true,
      username: decoded.username,
      sessionKey: session.sessionKey,
      role: user?.role === 'admin' ? 'admin' : 'pro',
      exp: decoded.exp // seconds since epoch
    };
  } catch (err) {
    return { valid: false };
  }
}

/**
 * If `currentToken`'s remaining lifetime is below CONFIG.jwtRenewThresholdMs,
 * mint a fresh token for the same user, copy the session over, and revoke the
 * old one. Returns the new token, or `null` if the current one is still fresh
 * enough to keep using.
 *
 * Designed to be idempotent: if `expSeconds` is missing or far in the future,
 * the function is a no-op.
 */
export function maybeRenewToken(currentToken, expSeconds, username) {
  if (!expSeconds) return null;
  const remainingMs = expSeconds * 1000 - Date.now();
  if (remainingMs >= CONFIG.jwtRenewThresholdMs) return null;
  if (remainingMs <= 0) return null; // expired tokens shouldn't reach here

  const newToken = jwt.sign({ username }, CONFIG.jwtSecret, { expiresIn: CONFIG.jwtExpiresIn });
  const session = activeSessions.get(currentToken);
  if (session) {
    activeSessions.set(newToken, session);
    activeSessions.delete(currentToken);
  }
  // Revoke the old token so a leaked copy can't outlive the renewal.
  revokedTokens.add(currentToken);
  return newToken;
}

/**
 * Invalidate a session (logout)
 */
export function logout(token) {
  activeSessions.delete(token);
  revokedTokens.add(token);
}
