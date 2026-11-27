import { createHash, randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { CONFIG, getUserByUsername } from '../config.js';
import { generateSessionKey } from '../encryption.js';
import { activeSessions, isSessionRevoked, recordSessionRevocation, revokedTokens } from './session-store.js';

export function issueSessionToken(username) {
  return signSessionToken(username, randomUUID());
}

function signSessionToken(username, sid) {
  return jwt.sign({ username, sid, jti: randomUUID() }, CONFIG.jwtSecret, { expiresIn: CONFIG.jwtExpiresIn });
}

function sessionId(token, decoded) {
  // Pre-upgrade JWTs can still renew and log out across versions. The fallback
  // is deterministic for that JWT, not shared by unrelated logins.
  if (decoded.type) return undefined;
  return decoded.sid ?? createHash('sha256').update(token).digest('hex');
}

// Claims here are either from verifyToken or previously authenticated at WS
// registration. Untrusted tokens must still be checked with verifyToken.
export function isTokenRevoked(token, sid, issuedAt) {
  if (revokedTokens.has(token)) return true;
  if (!sid && issuedAt === undefined) {
    const decoded = jwt.decode(token);
    if (!decoded) return false;
    sid = sessionId(token, decoded);
    issuedAt = decoded.iat;
  }
  return Boolean(sid && isSessionRevoked(sid, issuedAt));
}

/** Verify a JWT and return authenticated session claims (exp/iat in seconds). */
export function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, CONFIG.jwtSecret);

    const sid = sessionId(token, decoded);
    if (isTokenRevoked(token, sid, decoded.iat)) {
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
    if (!user) {
      activeSessions.delete(token);
      return { valid: false };
    }

    return {
      valid: true,
      username: decoded.username,
      sessionKey: session.sessionKey,
      role: user?.role === 'admin' ? 'admin' : 'pro',
      sid,
      iat: decoded.iat,
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

  let decoded;
  try {
    decoded = jwt.verify(currentToken, CONFIG.jwtSecret);
  } catch {
    return null;
  }
  const sid = sessionId(currentToken, decoded);
  if (!sid || decoded.username !== username || isTokenRevoked(currentToken, sid, decoded.iat)) return null;
  const newToken = signSessionToken(username, sid);
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
export function revokeToken(token) {
  let decoded;
  try {
    decoded = jwt.verify(token, CONFIG.jwtSecret);
  } catch {
    return;
  }
  activeSessions.delete(token);
  revokedTokens.add(token);
  const sid = sessionId(token, decoded);
  if (sid) {
    const now = Date.now();
    // A sibling may have been renewed even after the JWT used to log out
    // was minted. Retain the revocation through a full lifetime from now.
    const latestExpiry = jwt.decode(signSessionToken(decoded.username, sid)).exp;
    recordSessionRevocation(sid, Math.max(decoded.exp, latestExpiry) * 1000, now);
  }
}

export const logout = revokeToken;
