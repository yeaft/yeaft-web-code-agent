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
      exp: decoded.exp, // seconds since epoch
      type: decoded.type // undefined for full session tokens; 'temp'/'totp'/'totp-setup' otherwise
    };
  } catch (err) {
    return { valid: false };
  }
}

/**
 * If `currentToken`'s remaining lifetime is below CONFIG.jwtRenewThresholdMs,
 * mint a fresh token for the same user, copy the session over, and return it.
 * Returns `null` if the current token is still fresh enough to keep using.
 *
 * The old token is intentionally NOT revoked — browsers fire parallel
 * requests with the same Authorization header, and revoking would 401 every
 * sibling request that races the renewal. The old token expires naturally on
 * its original timeline (< jwtRenewThresholdMs from now), so the replay
 * window is bounded by the threshold.
 *
 * Designed to be idempotent: missing exp or far-future exp is a no-op.
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
    // Keep the old session entry intact so concurrent in-flight requests
    // bearing the old token continue to find their session. It will be
    // garbage-collected when the old token's natural exp passes.
  }
  return newToken;
}

/**
 * Invalidate a session (logout)
 */
export function logout(token) {
  activeSessions.delete(token);
  revokedTokens.add(token);
}
