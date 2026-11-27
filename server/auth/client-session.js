import { CONFIG } from '../config.js';
import { userDb } from '../database.js';
import { isTokenRevoked } from './token.js';

/** Recheck a registered browser session without re-verifying a JWT on every frame. */
export function isClientSessionValid(client, { skipAuth = CONFIG.skipAuth, isActive = id => userDb.isActive(id) } = {}) {
  if (!client?.authenticated) return false;
  if (skipAuth) return true;
  if (client.authToken && (isTokenRevoked(client.authToken, client.authSessionId, client.authIssuedAt) || client.authExpiresAt <= Date.now())) {
    client.authenticated = false;
    client.ws.close(1008, 'Session no longer valid');
    return false;
  }
  return Boolean(client.userId && isActive(client.userId));
}
