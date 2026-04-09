import jwt from 'jsonwebtoken';
import { CONFIG, isAadEnabled, getUserByUsername } from '../config.js';
import { generateSessionKey, encodeKey } from '../encryption.js';
import { userDb } from '../database.js';
import { completeLogin } from './login.js';

/**
 * Microsoft OIDC public keys cache
 * Keys are fetched from Microsoft's JWKS endpoint and cached.
 */
let _jwksCache = null;
let _jwksCacheExpiry = 0;
const JWKS_CACHE_TTL = 3600000; // 1 hour

/**
 * Fetch Microsoft's OIDC public signing keys (JWKS)
 * @returns {Promise<Array>} Array of JWK key objects
 */
async function getSigningKeys() {
  const now = Date.now();
  if (_jwksCache && now < _jwksCacheExpiry) {
    return _jwksCache;
  }

  const tenantId = CONFIG.aad.tenantId;
  const jwksUrl = `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;

  const response = await fetch(jwksUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: ${response.status}`);
  }

  const data = await response.json();
  _jwksCache = data.keys;
  _jwksCacheExpiry = now + JWKS_CACHE_TTL;
  return _jwksCache;
}

/**
 * Convert a JWK RSA key to PEM format for jwt.verify()
 * @param {Object} jwk - JWK key object with n (modulus) and e (exponent)
 * @returns {string} PEM-formatted public key
 */
function jwkToPem(jwk) {
  // Base64url decode
  const base64UrlToBuffer = (str) => {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) base64 += '=';
    return Buffer.from(base64, 'base64');
  };

  const n = base64UrlToBuffer(jwk.n);
  const e = base64UrlToBuffer(jwk.e);

  // DER encode RSA public key
  const encodeDerLength = (length) => {
    if (length < 0x80) return Buffer.from([length]);
    if (length < 0x100) return Buffer.from([0x81, length]);
    return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
  };

  const encodeDerInteger = (buf) => {
    // Prepend 0x00 if high bit set (to ensure positive integer)
    const needsPad = buf[0] & 0x80;
    const content = needsPad ? Buffer.concat([Buffer.from([0x00]), buf]) : buf;
    return Buffer.concat([Buffer.from([0x02]), encodeDerLength(content.length), content]);
  };

  const nDer = encodeDerInteger(n);
  const eDer = encodeDerInteger(e);

  // SEQUENCE { n INTEGER, e INTEGER }
  const rsaKeyBody = Buffer.concat([nDer, eDer]);
  const rsaKeySeq = Buffer.concat([Buffer.from([0x30]), encodeDerLength(rsaKeyBody.length), rsaKeyBody]);

  // BIT STRING wrapper
  const bitString = Buffer.concat([Buffer.from([0x03]), encodeDerLength(rsaKeySeq.length + 1), Buffer.from([0x00]), rsaKeySeq]);

  // AlgorithmIdentifier: OID 1.2.840.113549.1.1.1 (rsaEncryption) + NULL
  const algorithmId = Buffer.from([
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00
  ]);

  // SubjectPublicKeyInfo SEQUENCE
  const spkiBody = Buffer.concat([algorithmId, bitString]);
  const spki = Buffer.concat([Buffer.from([0x30]), encodeDerLength(spkiBody.length), spkiBody]);

  // PEM encode
  const base64 = spki.toString('base64');
  const lines = base64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}

/**
 * Verify a Microsoft id_token
 * @param {string} idToken - The id_token from MSAL.js
 * @returns {Promise<Object>} Decoded token payload with user info
 */
async function verifyIdToken(idToken) {
  // Decode header to get kid (key ID)
  const headerB64 = idToken.split('.')[0];
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());

  if (!header.kid) {
    throw new Error('Token missing kid header');
  }

  // Find matching signing key
  const keys = await getSigningKeys();
  const signingKey = keys.find(k => k.kid === header.kid);
  if (!signingKey) {
    // Invalidate cache and retry once
    _jwksCache = null;
    const freshKeys = await getSigningKeys();
    const freshKey = freshKeys.find(k => k.kid === header.kid);
    if (!freshKey) {
      throw new Error('No matching signing key found');
    }
    return verifyWithKey(idToken, freshKey);
  }

  return verifyWithKey(idToken, signingKey);
}

/**
 * Verify token with a specific JWK key
 */
function verifyWithKey(idToken, jwk) {
  const pem = jwkToPem(jwk);
  const tenantId = CONFIG.aad.tenantId;

  const decoded = jwt.verify(idToken, pem, {
    algorithms: ['RS256'],
    audience: CONFIG.aad.clientId,
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`
  });

  return decoded;
}

/**
 * Handle AAD login: verify id_token, find or create user, return JWT
 * @param {string} idToken - Microsoft id_token from frontend MSAL.js
 * @returns {Promise<Object>} Login result with token, sessionKey, role
 */
export async function loginWithAad(idToken) {
  if (!isAadEnabled()) {
    return { success: false, error: 'Azure AD login is not enabled' };
  }

  if (!idToken) {
    return { success: false, error: 'id_token is required' };
  }

  let decoded;
  try {
    decoded = await verifyIdToken(idToken);
  } catch (err) {
    console.error('[AAD] Token verification failed:', err.message);
    return { success: false, error: 'Invalid Microsoft token' };
  }

  // Extract user info from id_token
  const aadOid = decoded.oid || decoded.sub; // Object ID (unique per user per tenant)
  const email = decoded.preferred_username || decoded.email || decoded.upn;
  const name = decoded.name || email?.split('@')[0] || 'aad-user';

  if (!aadOid) {
    return { success: false, error: 'Token missing user identifier (oid)' };
  }

  // 1. Try to find existing user by AAD OID
  let user = userDb.getByAadOid(aadOid);

  // 2. If not found by OID, try to match by email/username (link existing account)
  if (!user && email) {
    const existingByEmail = userDb.getByUsername(email.split('@')[0]);
    if (existingByEmail && existingByEmail.email === email) {
      // Link existing user to AAD
      userDb.updateAadOid(existingByEmail.id, aadOid);
      user = existingByEmail;
      console.log(`[AAD] Linked existing user '${existingByEmail.username}' to AAD OID ${aadOid}`);
    }
  }

  // 3. Auto-create user if configured
  if (!user) {
    if (!CONFIG.aad.autoCreateUser) {
      return { success: false, error: 'No matching local account found. Contact your admin.' };
    }

    // Generate unique username from email or name
    let username = email ? email.split('@')[0] : name;
    // Sanitize username: only allow letters, numbers, hyphens, underscores
    username = username.replace(/[^a-zA-Z0-9_-]/g, '_');

    // Ensure uniqueness
    let candidate = username;
    let suffix = 1;
    while (userDb.getByUsername(candidate)) {
      candidate = `${username}_${suffix++}`;
    }

    const role = CONFIG.aad.defaultRole || 'pro';
    user = userDb.createFromAad(candidate, email, aadOid, role);
    console.log(`[AAD] Auto-created user '${candidate}' (email: ${email}, role: ${role})`);
  }

  // 4. Complete login (same as password login)
  const sessionKey = generateSessionKey();
  const role = user.role === 'admin' ? 'admin' : 'pro';

  // Update last login
  if (user.id) {
    userDb.updateLogin(user.id);
  }

  return completeLogin(user.username, sessionKey, role);
}
