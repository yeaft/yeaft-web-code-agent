/**
 * Shared OAuth start/callback flow used by all providers.
 *
 * Responsibilities:
 *   - Generate a CSRF-safe `state` token, remember `intent` (login | bind) and
 *     the binding user (if intent='bind') for the callback to consume.
 *   - On callback, exchange code → identity, then either log the user in or
 *     attach a new user_identities row, enforcing the conflict policy.
 *
 * The state store is in-memory and short-lived (10 minute TTL). It does not
 * survive a server restart — that's fine: a stale OAuth attempt would just
 * fail validation and the user would retry.
 */
import { randomBytes } from 'crypto';
import { CONFIG } from '../config.js';
import { userDb, identityDb } from '../database.js';
import { generateSessionKey } from '../encryption.js';
import { completeLogin } from './login.js';
import { getProvider } from './providers/types.js';

const STATE_TTL_MS = 10 * 60 * 1000;
const _stateStore = new Map(); // state → { provider, intent, userId, createdAt, mode }

// QR-mode pending-result store. When a QR-flow callback completes, we don't
// redirect the (mobile) browser into the SPA — instead we park the result
// here keyed by `state`, and the PC frontend polls /api/auth/sso/poll/:state
// to retrieve it. Entries are auto-GC'd after the same TTL.
const _pendingResults = new Map(); // state → { kind, ...result, createdAt }

function _gcStates() {
  const now = Date.now();
  for (const [k, v] of _stateStore.entries()) {
    if (now - v.createdAt > STATE_TTL_MS) _stateStore.delete(k);
  }
  for (const [k, v] of _pendingResults.entries()) {
    if (now - v.createdAt > STATE_TTL_MS) _pendingResults.delete(k);
  }
}

/**
 * Allocate a state token. `intent` is either 'login' (logged-out user) or
 * 'bind' (logged-in user attaching another identity). For 'bind', `userId`
 * MUST be supplied so the callback knows which internal account to attach to.
 *
 * `mode` defaults to 'redirect' (the user's browser is the one going to the
 * provider). Set it to 'qr' for the QR-scan flow where the callback fires on
 * a different device (the user's phone) and the original PC frontend polls
 * for completion.
 */
export function createState({ provider, intent = 'login', userId = null, mode = 'redirect' }) {
  _gcStates();
  const state = randomBytes(24).toString('hex');
  _stateStore.set(state, { provider, intent, userId, mode, createdAt: Date.now() });
  return state;
}

/**
 * Consume a state token, returning the stored metadata or null if invalid.
 * One-shot: a valid state is removed once consumed.
 */
export function consumeState(state, expectedProvider) {
  if (!state) return null;
  const entry = _stateStore.get(state);
  if (!entry) return null;
  _stateStore.delete(state);
  if (Date.now() - entry.createdAt > STATE_TTL_MS) return null;
  if (entry.provider !== expectedProvider) return null;
  return entry;
}

/**
 * Build the provider's authorize redirect URL.
 * Throws if the provider is unknown or disabled.
 */
export function buildAuthorizeUrl({ provider, intent = 'login', userId = null, mode = 'redirect' }) {
  const impl = getProvider(provider);
  if (!impl) throw new Error(`Unknown provider: ${provider}`);
  if (!impl.isEnabled()) throw new Error(`Provider not enabled: ${provider}`);
  const state = createState({ provider, intent, userId, mode });
  const url = impl.getAuthorizeUrl(state, intent);
  return { url, state };
}

/**
 * Park a completed QR-flow result so the PC frontend can poll for it.
 */
export function storePendingResult(state, result) {
  _pendingResults.set(state, { ...result, createdAt: Date.now() });
}

/**
 * Read (and delete on success) a parked QR-flow result.
 * Returns null if not found / expired.
 */
export function consumePendingResult(state) {
  _gcStates();
  const r = _pendingResults.get(state);
  if (!r) return null;
  // Only one-shot for terminal kinds; pending shouldn't reach here.
  _pendingResults.delete(state);
  return r;
}

/**
 * Inspect whether a state was issued in QR mode without consuming it.
 * Used by the callback handler to decide whether to redirect or park-and-stop.
 */
export function peekStateMode(state) {
  const e = _stateStore.get(state);
  return e ? e.mode : null;
}

/**
 * Sanitize an arbitrary string into a username candidate.
 */
function sanitizeUsername(raw) {
  return String(raw || 'sso_user').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32) || 'sso_user';
}

/**
 * Pick a unique username close to `base`, appending _1, _2, ... if needed.
 */
function uniqueUsername(base) {
  let candidate = base;
  let suffix = 1;
  while (userDb.getByUsername(candidate)) {
    candidate = `${base}_${suffix++}`;
    if (suffix > 1000) throw new Error('Could not allocate username');
  }
  return candidate;
}

/**
 * Pick the per-provider config for autoCreateUser/defaultRole. Microsoft
 * reuses CONFIG.aad; the rest live under CONFIG.sso[provider].
 */
function providerPolicy(provider) {
  if (provider === 'microsoft') {
    return {
      autoCreateUser: CONFIG.aad?.autoCreateUser !== false,
      defaultRole: CONFIG.aad?.defaultRole || 'pro'
    };
  }
  const c = CONFIG.sso?.[provider] || {};
  return {
    autoCreateUser: c.autoCreateUser !== false,
    defaultRole: c.defaultRole || 'pro'
  };
}

/**
 * Process a callback: validate state, exchange code, then either log in or
 * bind. Returns one of:
 *
 *   { kind: 'login',  token, sessionKey, role }      — issue session JWT
 *   { kind: 'bind',   provider }                     — binding succeeded for current user
 *   { kind: 'error',  status, error }                — surface to the user
 */
export async function handleCallback({ provider, code, state }) {
  const impl = getProvider(provider);
  if (!impl) return { kind: 'error', status: 400, error: 'Unknown provider' };
  if (!impl.isEnabled()) return { kind: 'error', status: 400, error: 'Provider not enabled' };

  const stateEntry = consumeState(state, provider);
  if (!stateEntry) return { kind: 'error', status: 400, error: 'Invalid or expired state' };

  let identity;
  try {
    identity = await impl.exchangeCode(code, state);
  } catch (err) {
    console.error(`[SSO ${provider}] exchangeCode failed:`, err.message);
    return { kind: 'error', status: 400, error: 'Failed to verify provider response' };
  }
  if (!identity || !identity.subject) {
    return { kind: 'error', status: 400, error: 'Provider response missing subject' };
  }

  const existing = identityDb.findBySubject(provider, identity.subject);

  if (stateEntry.intent === 'bind') {
    // Logged-in user binding a new identity.
    if (!stateEntry.userId) {
      return { kind: 'error', status: 401, error: 'Bind requires authenticated user' };
    }
    if (existing && existing.user_id !== stateEntry.userId) {
      // Already linked to someone else → reject (per agreed conflict policy).
      return { kind: 'error', status: 409, error: 'This account is already linked to another user' };
    }
    if (!existing) {
      const created = identityDb.create({
        userId: stateEntry.userId,
        provider,
        subject: identity.subject,
        email: identity.email,
        displayName: identity.displayName
      });
      if (!created) {
        return { kind: 'error', status: 409, error: 'This account is already linked to another user' };
      }
    } else {
      identityDb.touchLogin(existing.id);
    }
    return { kind: 'bind', provider };
  }

  // intent='login' (or anything else — default to login).
  if (existing) {
    const user = userDb.get(existing.user_id);
    if (!user) {
      return { kind: 'error', status: 500, error: 'Bound user no longer exists' };
    }
    identityDb.touchLogin(existing.id);
    if (user.id) userDb.updateLogin(user.id);
    const sessionKey = generateSessionKey();
    const role = user.role === 'admin' ? 'admin' : 'pro';
    const result = completeLogin(user.username, sessionKey, role);
    return { kind: 'login', ...result };
  }

  // No identity row yet — auto-create user (if policy allows) and link.
  const policy = providerPolicy(provider);
  if (!policy.autoCreateUser) {
    return { kind: 'error', status: 403, error: 'No matching account. Contact your admin.' };
  }

  const base = sanitizeUsername(
    identity.email ? identity.email.split('@')[0] : (identity.displayName || provider + '_user')
  );
  const username = uniqueUsername(base);
  const newUser = userDb.createFromAad(username, identity.email, /* aadOid */ null, policy.defaultRole);

  // Link the identity. createFromAad reuses null aad_oid for non-microsoft, and
  // we always insert into user_identities for the unified model.
  identityDb.create({
    userId: newUser.id,
    provider,
    subject: identity.subject,
    email: identity.email,
    displayName: identity.displayName
  });

  if (provider === 'microsoft' && identity.subject) {
    // Keep legacy users.aad_oid in sync for backwards compat.
    userDb.updateAadOid(newUser.id, identity.subject);
  }

  userDb.updateLogin(newUser.id);
  const sessionKey = generateSessionKey();
  const role = newUser.role === 'admin' ? 'admin' : 'pro';
  const result = completeLogin(newUser.username, sessionKey, role);
  return { kind: 'login', ...result };
}

// Test-only: clear the in-memory state store between cases.
export function _resetStateStore() {
  _stateStore.clear();
}
