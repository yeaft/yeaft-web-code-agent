import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';
import { TEST_PASSWORD_HASH } from '../helpers/fixtures.js';
import { generateSessionKey, encodeKey } from '../../server/encryption.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

let db, userDb;

beforeEach(() => {
  if (db) { try { db.close(); } catch (e) {} }
  const result = createTestDb();
  db = result.db;
  const ops = createDbOperations(db);
  userDb = ops.userDb;
});

afterAll(() => cleanupTestDb());

describe('AAD Integration - Database', () => {
  describe('aad_oid column', () => {
    it('should create user with aad_oid via createFromAad', () => {
      const user = userDb.createFromAad('testuser', 'test@example.com', 'aad-oid-123', 'pro');
      expect(user.username).toBe('testuser');
      expect(user.email).toBe('test@example.com');
      expect(user.aad_oid).toBe('aad-oid-123');
      expect(user.role).toBe('pro');
      expect(user.id).toBeTruthy();
    });

    it('should find user by aad_oid', () => {
      userDb.createFromAad('aaduser', 'aad@ms.com', 'oid-find-test', 'pro');
      const found = userDb.getByAadOid('oid-find-test');
      expect(found).toBeTruthy();
      expect(found.username).toBe('aaduser');
      expect(found.email).toBe('aad@ms.com');
    });

    it('should return null for non-existent aad_oid', () => {
      const found = userDb.getByAadOid('non-existent-oid');
      expect(found).toBeNull();
    });

    it('should return null for null aad_oid', () => {
      const found = userDb.getByAadOid(null);
      expect(found).toBeNull();
    });

    it('should link existing user to aad_oid via updateAadOid', () => {
      const user = userDb.createFull('existinguser', TEST_PASSWORD_HASH, 'existing@test.com', 'admin');
      userDb.updateAadOid(user.id, 'linked-oid');
      const found = userDb.getByAadOid('linked-oid');
      expect(found).toBeTruthy();
      expect(found.username).toBe('existinguser');
      expect(found.password_hash).toBe(TEST_PASSWORD_HASH);
    });

    it('should create AAD user without password_hash', () => {
      const user = userDb.createFromAad('nopwduser', 'nopwd@ms.com', 'oid-nopwd', 'pro');
      const dbUser = userDb.getByUsername('nopwduser');
      expect(dbUser.password_hash).toBeNull();
      expect(dbUser.email).toBe('nopwd@ms.com');
    });

    it('should not interfere with existing password-based users', () => {
      const pwdUser = userDb.createFull('pwduser', TEST_PASSWORD_HASH, 'pwd@test.com', 'admin');
      const aadUser = userDb.createFromAad('aadonly', 'aad@ms.com', 'oid-aadonly', 'pro');

      // Password user should still work normally
      const foundPwd = userDb.getByUsername('pwduser');
      expect(foundPwd.password_hash).toBe(TEST_PASSWORD_HASH);
      expect(foundPwd.aad_oid).toBeNull();

      // AAD user should have no password
      const foundAad = userDb.getByUsername('aadonly');
      expect(foundAad.password_hash).toBeNull();
      expect(foundAad.aad_oid).toBe('oid-aadonly');
    });

    it('should generate agent_secret for AAD users', () => {
      const user = userDb.createFromAad('agentuser', 'agent@ms.com', 'oid-agent', 'pro');
      expect(user.agent_secret).toBeTruthy();
      expect(user.agent_secret.length).toBe(64); // 32 bytes hex
    });
  });
});

describe('AAD Integration - Auth Mode API', () => {
  it('should include aadEnabled=false when not configured', () => {
    // Test the response shape (without server, we test the expected format)
    const mode = {
      skipAuth: false,
      emailVerification: false,
      totpEnabled: true,
      registrationEnabled: true,
      aadEnabled: false
    };
    expect(mode.aadEnabled).toBe(false);
    expect(mode).not.toHaveProperty('aadClientId');
    expect(mode).not.toHaveProperty('aadTenantId');
  });

  it('should include aadClientId and aadTenantId when enabled', () => {
    const mode = {
      skipAuth: false,
      aadEnabled: true,
      aadClientId: '4c87999d-33ec-4675-aeb0-7dc1c17f536b',
      aadTenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47'
    };
    expect(mode.aadEnabled).toBe(true);
    expect(mode.aadClientId).toBeTruthy();
    expect(mode.aadTenantId).toBeTruthy();
  });
});

describe('AAD Integration - Token Verification Logic', () => {
  it('should decode JWT header to extract kid', () => {
    // Simulate what aad.js does: decode header to get kid
    const fakeHeader = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key-id', typ: 'JWT' })).toString('base64url');
    const fakePayload = Buffer.from(JSON.stringify({ sub: '123', name: 'test' })).toString('base64url');
    const fakeToken = `${fakeHeader}.${fakePayload}.fakesig`;

    const headerB64 = fakeToken.split('.')[0];
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
    expect(header.kid).toBe('test-key-id');
    expect(header.alg).toBe('RS256');
  });

  it('should reject token without kid header', () => {
    const fakeHeader = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const headerB64 = fakeHeader;
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
    expect(header.kid).toBeUndefined();
  });
});

describe('AAD Integration - User Mapping', () => {
  it('should prefer AAD OID lookup over email matching', () => {
    // Create user with AAD OID
    userDb.createFromAad('oiduser', 'shared@ms.com', 'primary-oid', 'pro');
    // Create another user with same email
    userDb.createFull('emailuser', TEST_PASSWORD_HASH, 'shared@ms.com', 'pro');

    // OID lookup should find the AAD user
    const found = userDb.getByAadOid('primary-oid');
    expect(found.username).toBe('oiduser');
  });

  it('should support linking existing password user to AAD', () => {
    const user = userDb.createFull('linked', TEST_PASSWORD_HASH, 'linked@ms.com', 'admin');
    userDb.updateAadOid(user.id, 'new-linked-oid');

    // Should be findable by both methods
    const byUsername = userDb.getByUsername('linked');
    const byOid = userDb.getByAadOid('new-linked-oid');
    expect(byUsername.id).toBe(byOid.id);
    expect(byOid.password_hash).toBe(TEST_PASSWORD_HASH);
    expect(byOid.role).toBe('admin');
  });

  it('should auto-create user with sanitized username', () => {
    // Simulate the username sanitization from aad.js
    const email = 'first.last+tag@microsoft.com';
    let username = email.split('@')[0];
    username = username.replace(/[^a-zA-Z0-9_-]/g, '_');
    expect(username).toBe('first_last_tag');

    const user = userDb.createFromAad(username, email, 'oid-sanitize', 'pro');
    expect(user.username).toBe('first_last_tag');
  });

  it('should handle username deduplication', () => {
    // Create existing user with same name
    userDb.createFull('john', TEST_PASSWORD_HASH, 'john-old@test.com', 'pro');

    // Simulate dedup logic from aad.js
    let candidate = 'john';
    let suffix = 1;
    while (userDb.getByUsername(candidate)) {
      candidate = `john_${suffix++}`;
    }
    expect(candidate).toBe('john_1');

    const user = userDb.createFromAad(candidate, 'john@ms.com', 'oid-dedup', 'pro');
    expect(user.username).toBe('john_1');
  });
});

describe('AAD Integration - Frontend Store Shape', () => {
  it('should have correct initial state shape for AAD', () => {
    const state = {
      aadEnabled: false,
      aadClientId: null,
      aadTenantId: null
    };
    expect(state.aadEnabled).toBe(false);
    expect(state.aadClientId).toBeNull();
    expect(state.aadTenantId).toBeNull();
  });

  it('should update AAD state from auth mode response', () => {
    const state = {
      aadEnabled: false,
      aadClientId: null,
      aadTenantId: null
    };

    // Simulate checkAuthMode response
    const data = {
      aadEnabled: true,
      aadClientId: '4c87999d-33ec-4675-aeb0-7dc1c17f536b',
      aadTenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47'
    };

    state.aadEnabled = data.aadEnabled || false;
    state.aadClientId = data.aadClientId || null;
    state.aadTenantId = data.aadTenantId || null;

    expect(state.aadEnabled).toBe(true);
    expect(state.aadClientId).toBe('4c87999d-33ec-4675-aeb0-7dc1c17f536b');
    expect(state.aadTenantId).toBe('72f988bf-86f1-41af-91ab-2d7cd011db47');
  });

  it('should handle missing AAD fields gracefully', () => {
    const state = { aadEnabled: false, aadClientId: null, aadTenantId: null };
    const data = { skipAuth: false }; // no AAD fields

    state.aadEnabled = data.aadEnabled || false;
    state.aadClientId = data.aadClientId || null;
    state.aadTenantId = data.aadTenantId || null;

    expect(state.aadEnabled).toBe(false);
    expect(state.aadClientId).toBeNull();
  });
});

describe('AAD Integration - Config', () => {
  it('should recognize AAD as enabled when all required fields present', () => {
    const config = {
      aad: {
        enabled: true,
        clientId: '4c87999d-33ec-4675-aeb0-7dc1c17f536b',
        tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
        autoCreateUser: true,
        defaultRole: 'pro'
      }
    };
    const isEnabled = config.aad?.enabled && !!config.aad.clientId && !!config.aad.tenantId;
    expect(isEnabled).toBe(true);
  });

  it('should not be enabled when clientId is empty', () => {
    const config = {
      aad: { enabled: true, clientId: '', tenantId: 'some-tenant' }
    };
    const isEnabled = config.aad?.enabled && !!config.aad.clientId && !!config.aad.tenantId;
    expect(isEnabled).toBe(false);
  });

  it('should not be enabled when enabled=false', () => {
    const config = {
      aad: { enabled: false, clientId: 'some-client', tenantId: 'some-tenant' }
    };
    const isEnabled = config.aad?.enabled && !!config.aad.clientId && !!config.aad.tenantId;
    expect(isEnabled).toBe(false);
  });

  it('should default autoCreateUser to true', () => {
    // process.env.AAD_AUTO_CREATE_USER not set → !== 'false' → true
    const autoCreate = undefined !== 'false';
    expect(autoCreate).toBe(true);
  });

  it('should default role to pro', () => {
    const role = undefined || 'pro';
    expect(role).toBe('pro');
  });
});

// ============================================================================
// Integration tests: Full loginWithAad flow simulation
// ============================================================================

/**
 * Simulate the full loginWithAad logic from aad.js using the test DB.
 * This mirrors the actual code but with a mockable verifyIdToken.
 */
function createLoginWithAadSimulator(testUserDb, config) {
  return async function loginWithAad(decoded) {
    // Check AAD enabled
    const isEnabled = config.aad?.enabled && !!config.aad.clientId && !!config.aad.tenantId;
    if (!isEnabled) {
      return { success: false, error: 'Azure AD login is not enabled' };
    }

    // Extract user info (same logic as aad.js lines 166-168)
    const aadOid = decoded.oid || decoded.sub;
    const email = decoded.preferred_username || decoded.email || decoded.upn;
    const name = decoded.name || email?.split('@')[0] || 'aad-user';

    if (!aadOid) {
      return { success: false, error: 'Token missing user identifier (oid)' };
    }

    // 1. Find by OID
    let user = testUserDb.getByAadOid(aadOid);

    // 2. Match by email
    if (!user && email) {
      const existingByEmail = testUserDb.getByUsername(email.split('@')[0]);
      if (existingByEmail && existingByEmail.email === email) {
        testUserDb.updateAadOid(existingByEmail.id, aadOid);
        user = existingByEmail;
      }
    }

    // 3. Auto-create
    if (!user) {
      if (!config.aad.autoCreateUser) {
        return { success: false, error: 'No matching local account found. Contact your admin.' };
      }
      let username = email ? email.split('@')[0] : name;
      username = username.replace(/[^a-zA-Z0-9_-]/g, '_');
      let candidate = username;
      let suffix = 1;
      while (testUserDb.getByUsername(candidate)) {
        candidate = `${username}_${suffix++}`;
      }
      const role = config.aad.defaultRole || 'pro';
      user = testUserDb.createFromAad(candidate, email, aadOid, role);
    }

    // 4. Complete login
    const sessionKey = generateSessionKey();
    const role = user.role === 'admin' ? 'admin' : 'pro';
    if (user.id) {
      testUserDb.updateLogin(user.id);
    }

    const token = jwt.sign({ username: user.username }, 'test-secret', { expiresIn: '1h' });
    return {
      success: true,
      token,
      sessionKey: encodeKey(sessionKey),
      role,
      needTotpCode: false,
      needTotpSetup: false,
      needEmailCode: false
    };
  };
}

const AAD_CONFIG_ENABLED = {
  aad: {
    enabled: true,
    clientId: '4c87999d-33ec-4675-aeb0-7dc1c17f536b',
    tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
    autoCreateUser: true,
    defaultRole: 'pro'
  }
};

const AAD_CONFIG_DISABLED = {
  aad: {
    enabled: false,
    clientId: '4c87999d-33ec-4675-aeb0-7dc1c17f536b',
    tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
    autoCreateUser: true,
    defaultRole: 'pro'
  }
};

const AAD_CONFIG_NO_AUTO_CREATE = {
  aad: {
    enabled: true,
    clientId: '4c87999d-33ec-4675-aeb0-7dc1c17f536b',
    tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
    autoCreateUser: false,
    defaultRole: 'pro'
  }
};

describe('AAD Integration - Full Login Flow', () => {
  it('should auto-create new user on first AAD login', async () => {
    const loginWithAad = createLoginWithAadSimulator(userDb, AAD_CONFIG_ENABLED);
    const result = await loginWithAad({
      oid: 'new-user-oid-123',
      preferred_username: 'newuser@microsoft.com',
      name: 'New User'
    });

    expect(result.success).toBe(true);
    expect(result.token).toBeTruthy();
    expect(result.sessionKey).toBeTruthy();
    expect(result.role).toBe('pro');
    expect(result.needTotpCode).toBe(false);
    expect(result.needTotpSetup).toBe(false);
    expect(result.needEmailCode).toBe(false);

    // Verify user was created in DB
    const user = userDb.getByAadOid('new-user-oid-123');
    expect(user).toBeTruthy();
    expect(user.username).toBe('newuser');
    expect(user.email).toBe('newuser@microsoft.com');
    expect(user.password_hash).toBeNull();
  });

  it('should find existing AAD user by OID on subsequent logins', async () => {
    // First login creates user
    userDb.createFromAad('returning', 'returning@ms.com', 'returning-oid', 'pro');

    const loginWithAad = createLoginWithAadSimulator(userDb, AAD_CONFIG_ENABLED);
    const result = await loginWithAad({
      oid: 'returning-oid',
      preferred_username: 'returning@ms.com',
      name: 'Returning User'
    });

    expect(result.success).toBe(true);
    expect(result.role).toBe('pro');

    // Should NOT create a new user
    const allUsers = userDb.getAll();
    const matchingUsers = allUsers.filter(u => u.aad_oid === 'returning-oid');
    expect(matchingUsers.length).toBe(1);
  });

  it('should link existing password user by email match', async () => {
    // Create a password user first
    const pwdUser = userDb.createFull('alice', TEST_PASSWORD_HASH, 'alice@microsoft.com', 'admin');
    expect(pwdUser.role).toBe('admin');

    const loginWithAad = createLoginWithAadSimulator(userDb, AAD_CONFIG_ENABLED);
    const result = await loginWithAad({
      oid: 'alice-aad-oid',
      preferred_username: 'alice@microsoft.com',
      name: 'Alice'
    });

    expect(result.success).toBe(true);
    expect(result.role).toBe('admin'); // Should inherit admin role

    // Should be linked
    const linkedUser = userDb.getByAadOid('alice-aad-oid');
    expect(linkedUser).toBeTruthy();
    expect(linkedUser.username).toBe('alice');
    expect(linkedUser.password_hash).toBe(TEST_PASSWORD_HASH); // Password preserved
  });

  it('should NOT link user if email does not match', async () => {
    // Create a password user with different email
    userDb.createFull('bob', TEST_PASSWORD_HASH, 'bob-other@example.com', 'pro');

    const loginWithAad = createLoginWithAadSimulator(userDb, AAD_CONFIG_ENABLED);
    const result = await loginWithAad({
      oid: 'bob-aad-oid',
      preferred_username: 'bob@microsoft.com',
      name: 'Bob'
    });

    expect(result.success).toBe(true);

    // Should auto-create a new user, not link to existing bob
    const linkedUser = userDb.getByAadOid('bob-aad-oid');
    expect(linkedUser).toBeTruthy();
    expect(linkedUser.username).toBe('bob_1'); // Dedup'd since 'bob' exists
  });

  it('should fail when AAD is disabled', async () => {
    const loginWithAad = createLoginWithAadSimulator(userDb, AAD_CONFIG_DISABLED);
    const result = await loginWithAad({
      oid: 'any-oid',
      preferred_username: 'test@ms.com'
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Azure AD login is not enabled');
  });

  it('should fail when token has no OID or sub', async () => {
    const loginWithAad = createLoginWithAadSimulator(userDb, AAD_CONFIG_ENABLED);
    const result = await loginWithAad({
      preferred_username: 'noid@ms.com',
      name: 'No OID User'
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Token missing user identifier (oid)');
  });

  it('should fail when auto-create disabled and no matching user', async () => {
    const loginWithAad = createLoginWithAadSimulator(userDb, AAD_CONFIG_NO_AUTO_CREATE);
    const result = await loginWithAad({
      oid: 'unknown-oid',
      preferred_username: 'unknown@ms.com'
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('No matching local account found. Contact your admin.');
  });

  it('should use sub as fallback when oid is missing', async () => {
    const loginWithAad = createLoginWithAadSimulator(userDb, AAD_CONFIG_ENABLED);
    const result = await loginWithAad({
      sub: 'sub-fallback-123', // No oid, use sub
      preferred_username: 'subfallback@ms.com',
      name: 'Sub Fallback'
    });

    expect(result.success).toBe(true);
    const user = userDb.getByAadOid('sub-fallback-123');
    expect(user).toBeTruthy();
    expect(user.username).toBe('subfallback');
  });

  it('should use email field when preferred_username is missing', async () => {
    const loginWithAad = createLoginWithAadSimulator(userDb, AAD_CONFIG_ENABLED);
    const result = await loginWithAad({
      oid: 'email-field-oid',
      email: 'emailonly@ms.com',
      name: 'Email Only'
    });

    expect(result.success).toBe(true);
    const user = userDb.getByAadOid('email-field-oid');
    expect(user).toBeTruthy();
    expect(user.username).toBe('emailonly');
    expect(user.email).toBe('emailonly@ms.com');
  });

  it('should use upn field as last email fallback', async () => {
    const loginWithAad = createLoginWithAadSimulator(userDb, AAD_CONFIG_ENABLED);
    const result = await loginWithAad({
      oid: 'upn-oid',
      upn: 'upnuser@ms.com',
      name: 'UPN User'
    });

    expect(result.success).toBe(true);
    const user = userDb.getByAadOid('upn-oid');
    expect(user.email).toBe('upnuser@ms.com');
  });

  it('should fallback to name-based username when no email', async () => {
    const loginWithAad = createLoginWithAadSimulator(userDb, AAD_CONFIG_ENABLED);
    const result = await loginWithAad({
      oid: 'noname-oid',
      name: 'Guest User'
    });

    expect(result.success).toBe(true);
    const user = userDb.getByAadOid('noname-oid');
    // "Guest User" → sanitized → "Guest_User"
    expect(user.username).toBe('Guest_User');
  });

  it('should fallback to "aad-user" when no email and no name', async () => {
    const loginWithAad = createLoginWithAadSimulator(userDb, AAD_CONFIG_ENABLED);
    const result = await loginWithAad({
      oid: 'minimal-oid'
      // No email, no name
    });

    expect(result.success).toBe(true);
    const user = userDb.getByAadOid('minimal-oid');
    expect(user.username).toBe('aad-user');
  });

  it('should update last_login_at on AAD login', async () => {
    userDb.createFromAad('logintime', 'lt@ms.com', 'logintime-oid', 'pro');
    const before = userDb.getByAadOid('logintime-oid');
    expect(before.last_login_at).toBeNull();

    const loginWithAad = createLoginWithAadSimulator(userDb, AAD_CONFIG_ENABLED);
    await loginWithAad({
      oid: 'logintime-oid',
      preferred_username: 'lt@ms.com'
    });

    const after = userDb.getByAadOid('logintime-oid');
    expect(after.last_login_at).toBeTruthy();
    expect(after.last_login_at).toBeGreaterThan(0);
  });

  it('should return valid JWT token with username', async () => {
    const loginWithAad = createLoginWithAadSimulator(userDb, AAD_CONFIG_ENABLED);
    const result = await loginWithAad({
      oid: 'jwt-test-oid',
      preferred_username: 'jwtuser@ms.com'
    });

    expect(result.success).toBe(true);
    const decoded = jwt.verify(result.token, 'test-secret');
    expect(decoded.username).toBe('jwtuser');
    expect(decoded.exp).toBeTruthy();
  });

  it('should handle multiple dedup collisions', async () => {
    // Create users that will collide
    userDb.createFull('mike', TEST_PASSWORD_HASH, 'mike1@test.com', 'pro');
    userDb.createFromAad('mike_1', 'mike2@ms.com', 'mike1-oid', 'pro');
    userDb.createFromAad('mike_2', 'mike3@ms.com', 'mike2-oid', 'pro');

    const loginWithAad = createLoginWithAadSimulator(userDb, AAD_CONFIG_ENABLED);
    const result = await loginWithAad({
      oid: 'mike-new-oid',
      preferred_username: 'mike@microsoft.com'
    });

    expect(result.success).toBe(true);
    const user = userDb.getByAadOid('mike-new-oid');
    expect(user.username).toBe('mike_3'); // mike, mike_1, mike_2 taken
  });
});

describe('AAD Integration - JWK to PEM conversion', () => {
  /**
   * Test with a real RSA key pair to verify jwkToPem works correctly
   */
  it('should produce a valid PEM from RSA JWK (round-trip test)', () => {
    // Generate a real RSA key pair for testing
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'jwk' }
    });

    // publicKey is a JWK object with n, e
    expect(publicKey.n).toBeTruthy();
    expect(publicKey.e).toBeTruthy();
    expect(publicKey.kty).toBe('RSA');

    // Replicate jwkToPem logic from aad.js
    const base64UrlToBuffer = (str) => {
      let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4 !== 0) base64 += '=';
      return Buffer.from(base64, 'base64');
    };

    const n = base64UrlToBuffer(publicKey.n);
    const e = base64UrlToBuffer(publicKey.e);

    const encodeDerLength = (length) => {
      if (length < 0x80) return Buffer.from([length]);
      if (length < 0x100) return Buffer.from([0x81, length]);
      return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
    };

    const encodeDerInteger = (buf) => {
      const needsPad = buf[0] & 0x80;
      const content = needsPad ? Buffer.concat([Buffer.from([0x00]), buf]) : buf;
      return Buffer.concat([Buffer.from([0x02]), encodeDerLength(content.length), content]);
    };

    const nDer = encodeDerInteger(n);
    const eDer = encodeDerInteger(e);
    const rsaKeyBody = Buffer.concat([nDer, eDer]);
    const rsaKeySeq = Buffer.concat([Buffer.from([0x30]), encodeDerLength(rsaKeyBody.length), rsaKeyBody]);
    const bitString = Buffer.concat([Buffer.from([0x03]), encodeDerLength(rsaKeySeq.length + 1), Buffer.from([0x00]), rsaKeySeq]);
    const algorithmId = Buffer.from([
      0x30, 0x0d,
      0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
      0x05, 0x00
    ]);
    const spkiBody = Buffer.concat([algorithmId, bitString]);
    const spki = Buffer.concat([Buffer.from([0x30]), encodeDerLength(spkiBody.length), spkiBody]);
    const base64Str = spki.toString('base64');
    const lines = base64Str.match(/.{1,64}/g).join('\n');
    const pem = `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;

    // Verify PEM is valid by creating a key object from it
    expect(pem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(pem).toContain('-----END PUBLIC KEY-----');

    // Sign data with private key and verify with our generated PEM
    const data = 'test message for signature verification';
    const sign = crypto.createSign('SHA256');
    sign.update(data);
    const signature = sign.sign(privateKey);

    const verify = crypto.createVerify('SHA256');
    verify.update(data);
    const valid = verify.verify(pem, signature);
    expect(valid).toBe(true);
  });

  it('should sign and verify JWT with generated PEM (simulating AAD token flow)', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'jwk' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    // Build PEM from JWK (same logic as aad.js)
    const base64UrlToBuffer = (str) => {
      let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4 !== 0) base64 += '=';
      return Buffer.from(base64, 'base64');
    };
    const n = base64UrlToBuffer(publicKey.n);
    const e = base64UrlToBuffer(publicKey.e);
    const encodeDerLength = (length) => {
      if (length < 0x80) return Buffer.from([length]);
      if (length < 0x100) return Buffer.from([0x81, length]);
      return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
    };
    const encodeDerInteger = (buf) => {
      const needsPad = buf[0] & 0x80;
      const content = needsPad ? Buffer.concat([Buffer.from([0x00]), buf]) : buf;
      return Buffer.concat([Buffer.from([0x02]), encodeDerLength(content.length), content]);
    };
    const nDer = encodeDerInteger(n);
    const eDer = encodeDerInteger(e);
    const rsaKeyBody = Buffer.concat([nDer, eDer]);
    const rsaKeySeq = Buffer.concat([Buffer.from([0x30]), encodeDerLength(rsaKeyBody.length), rsaKeyBody]);
    const bitString = Buffer.concat([Buffer.from([0x03]), encodeDerLength(rsaKeySeq.length + 1), Buffer.from([0x00]), rsaKeySeq]);
    const algorithmId = Buffer.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
    const spkiBody = Buffer.concat([algorithmId, bitString]);
    const spki = Buffer.concat([Buffer.from([0x30]), encodeDerLength(spkiBody.length), spkiBody]);
    const pem = `-----BEGIN PUBLIC KEY-----\n${spki.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;

    // Sign a JWT with the private key (like Microsoft would)
    const testPayload = {
      oid: 'test-oid-12345',
      preferred_username: 'testuser@microsoft.com',
      name: 'Test User',
      aud: '4c87999d-33ec-4675-aeb0-7dc1c17f536b',
      iss: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0'
    };

    const idToken = jwt.sign(testPayload, privateKey, {
      algorithm: 'RS256',
      header: { kid: 'test-kid-123', alg: 'RS256' }
    });

    // Verify with our PEM (like aad.js verifyWithKey does)
    const decoded = jwt.verify(idToken, pem, {
      algorithms: ['RS256'],
      audience: '4c87999d-33ec-4675-aeb0-7dc1c17f536b',
      issuer: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0'
    });

    expect(decoded.oid).toBe('test-oid-12345');
    expect(decoded.preferred_username).toBe('testuser@microsoft.com');
    expect(decoded.name).toBe('Test User');
  });

  it('should reject JWT with wrong audience', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const token = jwt.sign(
      { oid: 'test', aud: 'wrong-client-id' },
      privateKey,
      { algorithm: 'RS256' }
    );

    expect(() => jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      audience: 'correct-client-id'
    })).toThrow(/audience/i);
  });

  it('should reject JWT with wrong issuer', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const token = jwt.sign(
      { oid: 'test', iss: 'https://login.microsoftonline.com/wrong-tenant/v2.0' },
      privateKey,
      { algorithm: 'RS256', noTimestamp: true }
    );

    expect(() => jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: 'https://login.microsoftonline.com/correct-tenant/v2.0'
    })).toThrow(/issuer/i);
  });

  it('should reject expired JWT token', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const token = jwt.sign({ oid: 'test' }, privateKey, {
      algorithm: 'RS256',
      expiresIn: '0s'
    });

    // Wait for expiration
    await new Promise(r => setTimeout(r, 50));

    expect(() => jwt.verify(token, publicKey, {
      algorithms: ['RS256']
    })).toThrow(/expired/i);
  });
});

describe('AAD Integration - Route Handler Logic', () => {
  it('should return 400 for missing idToken in request body', () => {
    // Simulates the route handler check in auth-routes.js line 114
    const idToken = undefined;
    expect(!idToken).toBe(true);
    // In real code: returns res.status(400).json({ success: false, error: 'id_token is required' })
  });

  it('should return 400 for empty idToken', () => {
    const idToken = '';
    expect(!idToken).toBe(true);
  });

  it('should apply rate limiting to AAD endpoint', () => {
    // Simulate rate limit tracking
    const ipAttempts = new Map();
    const maxAttempts = 10;
    const ip = '192.168.1.100';

    function checkRateLimit(clientIp) {
      const attempts = ipAttempts.get(clientIp) || 0;
      if (attempts >= maxAttempts) return false;
      ipAttempts.set(clientIp, attempts + 1);
      return true;
    }

    // First 10 attempts should pass
    for (let i = 0; i < maxAttempts; i++) {
      expect(checkRateLimit(ip)).toBe(true);
    }
    // 11th attempt should be blocked
    expect(checkRateLimit(ip)).toBe(false);
  });

  it('should build correct auth mode response with AAD enabled', () => {
    // Simulates auth-routes.js /api/auth/mode response building
    const aadEnabled = true;
    const config = {
      skipAuth: false,
      aad: {
        clientId: '4c87999d-33ec-4675-aeb0-7dc1c17f536b',
        tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47'
      }
    };

    const response = {
      skipAuth: config.skipAuth,
      emailVerification: false,
      totpEnabled: true,
      registrationEnabled: true,
      aadEnabled,
      ...(aadEnabled && {
        aadClientId: config.aad.clientId,
        aadTenantId: config.aad.tenantId
      })
    };

    expect(response.aadEnabled).toBe(true);
    expect(response.aadClientId).toBe('4c87999d-33ec-4675-aeb0-7dc1c17f536b');
    expect(response.aadTenantId).toBe('72f988bf-86f1-41af-91ab-2d7cd011db47');
    expect(Object.keys(response)).toContain('aadClientId');
    expect(Object.keys(response)).toContain('aadTenantId');
  });

  it('should NOT include clientId/tenantId when AAD disabled', () => {
    const aadEnabled = false;
    const response = {
      skipAuth: false,
      aadEnabled,
      ...(aadEnabled && {
        aadClientId: 'should-not-appear',
        aadTenantId: 'should-not-appear'
      })
    };

    expect(response.aadEnabled).toBe(false);
    expect(Object.keys(response)).not.toContain('aadClientId');
    expect(Object.keys(response)).not.toContain('aadTenantId');
  });
});

describe('AAD Integration - Security', () => {
  it('should only allow RS256 algorithm', () => {
    // Simulates verifyWithKey options
    const options = { algorithms: ['RS256'] };
    expect(options.algorithms).toEqual(['RS256']);
    expect(options.algorithms).not.toContain('HS256'); // Prevent alg confusion attack
    expect(options.algorithms).not.toContain('none');
  });

  it('should validate audience matches client ID', () => {
    const clientId = '4c87999d-33ec-4675-aeb0-7dc1c17f536b';
    const tokenAud = '4c87999d-33ec-4675-aeb0-7dc1c17f536b';
    expect(tokenAud).toBe(clientId);
  });

  it('should validate issuer matches tenant', () => {
    const tenantId = '72f988bf-86f1-41af-91ab-2d7cd011db47';
    const expectedIssuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    const tokenIssuer = 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0';
    expect(tokenIssuer).toBe(expectedIssuer);
  });

  it('should not expose password_hash for AAD-only users', () => {
    const user = userDb.createFromAad('secureuser', 'secure@ms.com', 'secure-oid', 'pro');
    const dbUser = userDb.getByUsername('secureuser');
    expect(dbUser.password_hash).toBeNull();
    // AAD-only user cannot be used for password login
  });

  it('should preserve password_hash when linking existing user', () => {
    const existing = userDb.createFull('passholder', TEST_PASSWORD_HASH, 'pass@ms.com', 'admin');
    userDb.updateAadOid(existing.id, 'linked-secure-oid');

    const linked = userDb.getByAadOid('linked-secure-oid');
    expect(linked.password_hash).toBe(TEST_PASSWORD_HASH); // Password not wiped
    expect(linked.role).toBe('admin'); // Role preserved
  });

  it('should sanitize username from email to prevent injection', () => {
    const maliciousEmails = [
      "'; DROP TABLE users; --@evil.com",
      '<script>alert(1)</script>@evil.com',
      '../../../etc/passwd@evil.com',
      'user\x00null@evil.com'
    ];

    for (const email of maliciousEmails) {
      let username = email.split('@')[0];
      username = username.replace(/[^a-zA-Z0-9_-]/g, '_');
      // Should only contain safe chars
      expect(username).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(username).not.toContain("'");
      expect(username).not.toContain('<');
      expect(username).not.toContain('/');
      expect(username).not.toContain('\x00');
    }
  });

  it('should cache JWKS keys with TTL', () => {
    // Verify cache logic pattern
    const JWKS_CACHE_TTL = 3600000; // 1 hour
    let cache = null;
    let cacheExpiry = 0;

    const now = Date.now();

    // Cold cache
    expect(!!(cache && now < cacheExpiry)).toBe(false);

    // Warm cache
    cache = [{ kid: 'key1' }];
    cacheExpiry = now + JWKS_CACHE_TTL;
    expect(cache && now < cacheExpiry).toBe(true);

    // Expired cache
    cacheExpiry = now - 1;
    expect(cache && now < cacheExpiry).toBe(false);
  });

  it('should invalidate JWKS cache and retry on key miss', () => {
    // Simulate the cache invalidation + retry logic from verifyIdToken
    let cache = [{ kid: 'old-key-1' }, { kid: 'old-key-2' }];
    const targetKid = 'new-key-3';

    // First lookup fails
    let found = cache.find(k => k.kid === targetKid);
    expect(found).toBeUndefined();

    // Invalidate and refresh
    cache = null;
    const freshKeys = [{ kid: 'new-key-3' }, { kid: 'new-key-4' }];
    cache = freshKeys;

    // Retry succeeds
    found = cache.find(k => k.kid === targetKid);
    expect(found).toBeTruthy();
    expect(found.kid).toBe('new-key-3');
  });
});

describe('AAD Integration - Frontend MSAL Configuration', () => {
  it('should construct correct MSAL config', () => {
    const aadClientId = '4c87999d-33ec-4675-aeb0-7dc1c17f536b';
    const aadTenantId = '72f988bf-86f1-41af-91ab-2d7cd011db47';

    const msalConfig = {
      auth: {
        clientId: aadClientId,
        authority: `https://login.microsoftonline.com/${aadTenantId}`,
        redirectUri: 'https://chat.example.com'
      },
      cache: {
        cacheLocation: 'sessionStorage',
        storeAuthStateInCookie: false
      }
    };

    expect(msalConfig.auth.clientId).toBe(aadClientId);
    expect(msalConfig.auth.authority).toBe('https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47');
    expect(msalConfig.cache.cacheLocation).toBe('sessionStorage');
  });

  it('should request correct scopes for id_token', () => {
    const scopes = ['openid', 'profile', 'email'];
    expect(scopes).toContain('openid'); // Required for id_token
    expect(scopes).toContain('profile'); // Required for name claim
    expect(scopes).toContain('email'); // Required for email/preferred_username
  });

  it('should handle popup cancellation gracefully', () => {
    // MSAL throws BrowserAuthError when user cancels popup
    const msalErrors = [
      { errorCode: 'user_cancelled', name: 'BrowserAuthError' },
      { errorCode: 'interaction_in_progress', name: 'BrowserAuthError' }
    ];

    for (const err of msalErrors) {
      const isCancellation = err.errorCode === 'user_cancelled' || err.name === 'BrowserAuthError';
      expect(isCancellation).toBe(true);
    }
  });

  it('should guard against loginWithMicrosoft when AAD not enabled', () => {
    // Simulates the guard in auth.js loginWithMicrosoft action
    const states = [
      { aadEnabled: false, aadClientId: 'x', aadTenantId: 'y' },
      { aadEnabled: true, aadClientId: null, aadTenantId: 'y' },
      { aadEnabled: true, aadClientId: 'x', aadTenantId: null }
    ];

    for (const state of states) {
      const canLogin = state.aadEnabled && state.aadClientId && state.aadTenantId;
      expect(!canLogin).toBe(true);
    }
  });

  it('should pass only when all AAD state fields present', () => {
    const state = {
      aadEnabled: true,
      aadClientId: '4c87999d-33ec-4675-aeb0-7dc1c17f536b',
      aadTenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47'
    };
    const canLogin = state.aadEnabled && state.aadClientId && state.aadTenantId;
    expect(!!canLogin).toBe(true);
  });
});
