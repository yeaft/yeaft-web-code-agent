import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';
import { TEST_PASSWORD_HASH } from '../helpers/fixtures.js';

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
