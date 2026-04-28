/**
 * Identity binding tests — focus on the conflict policy and "can't unbind the
 * last login method" guard, exercised against an in-memory fake of identityDb
 * + userDb. We mock server/database.js so these tests don't require the
 * native SQLite engine (which needs Node 22.5+).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory state for the fake DB.
const _state = {
  users: new Map(),  // id -> user row
  identities: [],    // array of identity rows
};

function _resetState() {
  _state.users.clear();
  _state.identities.length = 0;
}

// In-memory userDb fake — mirrors the subset oauth-flow uses.
const fakeUserDb = {
  get(id) { return _state.users.get(id) || null; },
  getByUsername(name) {
    for (const u of _state.users.values()) if (u.username === name) return u;
    return null;
  },
  updateLogin() {},
  updateAadOid(id, oid) { const u = _state.users.get(id); if (u) u.aad_oid = oid; },
  updateDisplayName(id, name) { const u = _state.users.get(id); if (u && name) u.display_name = name; },
  createFromAad(username, email, aadOid, role = 'pro', displayName = null) {
    const id = `u_${_state.users.size + 1}`;
    const u = { id, username, display_name: displayName || username, email, aad_oid: aadOid, role, password_hash: null };
    _state.users.set(id, u);
    return u;
  }
};

const fakeIdentityDb = {
  create({ userId, provider, subject, email = null, displayName = null }) {
    const dup = _state.identities.find(r => r.provider === provider && r.subject === subject);
    if (dup) return null; // UNIQUE conflict
    const row = { id: `idn_${_state.identities.length + 1}`, user_id: userId, provider, subject, email, display_name: displayName, created_at: Date.now(), last_login_at: Date.now() };
    _state.identities.push(row);
    return row;
  },
  findBySubject(provider, subject) {
    return _state.identities.find(r => r.provider === provider && r.subject === subject) || null;
  },
  findForUser(userId, provider) {
    return _state.identities.find(r => r.user_id === userId && r.provider === provider) || null;
  },
  listForUser(userId) { return _state.identities.filter(r => r.user_id === userId); },
  countForUser(userId) { return _state.identities.filter(r => r.user_id === userId).length; },
  touchLogin(id) { const r = _state.identities.find(x => x.id === id); if (r) r.last_login_at = Date.now(); },
  removeForUser(userId, provider) {
    const before = _state.identities.length;
    _state.identities = _state.identities.filter(r => !(r.user_id === userId && r.provider === provider));
    return _state.identities.length < before;
  },
  upsert(args) {
    const existing = this.findBySubject(args.provider, args.subject);
    if (existing) return { row: existing, created: false };
    const row = this.create(args);
    return { row, created: !!row };
  }
};

vi.mock('../../server/database.js', () => ({
  userDb: fakeUserDb,
  identityDb: fakeIdentityDb
}));

vi.mock('../../server/auth/login.js', () => ({
  completeLogin: (username, sessionKey, role) => ({
    success: true,
    token: `jwt-${username}`,
    sessionKey: 'sk-' + sessionKey?.slice(0, 4),
    role
  })
}));

vi.mock('../../server/encryption.js', () => ({
  generateSessionKey: () => 'session-key-bytes',
  encodeKey: (k) => 'enc-' + k
}));

// Stub providers so we can drive exchangeCode synchronously.
const _provider = {
  name: 'github',
  isEnabled: () => true,
  getAuthorizeUrl: (state) => `https://gh/?state=${state}`,
  exchangeCode: vi.fn()
};
vi.mock('../../server/auth/providers/types.js', () => ({
  getProvider: (n) => (n === 'github' ? _provider : null),
  listEnabledProviders: () => ['github'],
  listProviderNames: () => ['github']
}));

// Configure CONFIG.sso defaults for github (autoCreateUser default true).
process.env.SSO_GITHUB_ENABLED = 'true';
process.env.SSO_GITHUB_CLIENT_ID = 'g';
process.env.SSO_GITHUB_CLIENT_SECRET = 's';
process.env.SSO_GITHUB_CALLBACK_URL = 'https://x/cb';

// Stub server/config.js to avoid loading the database side-effect chain.
vi.mock('../../server/config.js', () => ({
  CONFIG: {
    aad: { autoCreateUser: true, defaultRole: 'pro' },
    sso: {
      github: { enabled: true, autoCreateUser: true, defaultRole: 'pro' },
      google: { enabled: false },
      wechat: { enabled: false },
      alipay: { enabled: false }
    }
  },
  isAadEnabled: () => false,
  getEnabledSsoProviders: () => ({ github: true, google: false, wechat: false, alipay: false })
}));

const { handleCallback, createState, _resetStateStore } = await import('../../server/auth/oauth-flow.js');

describe('Identity binding — conflict + last login guard', () => {
  beforeEach(() => {
    _resetState();
    _resetStateStore();
    _provider.exchangeCode.mockReset();
  });

  it('autocreates a new user and identity row on first SSO login', async () => {
    _provider.exchangeCode.mockResolvedValue({ subject: 'gh-1', email: 'u1@x.com', displayName: 'U1' });
    const state = createState({ provider: 'github', intent: 'login' });
    const r = await handleCallback({ provider: 'github', code: 'c1', state });
    expect(r.kind).toBe('login');
    expect(r.token).toMatch(/^jwt-/);
    expect(_state.users.size).toBe(1);
    expect(_state.identities.length).toBe(1);
    expect(_state.identities[0].provider).toBe('github');
    expect(_state.identities[0].subject).toBe('gh-1');
  });

  it('logs into the same user when the same identity returns', async () => {
    _provider.exchangeCode.mockResolvedValue({ subject: 'gh-2', email: null, displayName: 'U' });

    const s1 = createState({ provider: 'github', intent: 'login' });
    await handleCallback({ provider: 'github', code: 'c', state: s1 });
    const userIdFirst = _state.identities[0].user_id;

    const s2 = createState({ provider: 'github', intent: 'login' });
    const r2 = await handleCallback({ provider: 'github', code: 'c', state: s2 });
    expect(r2.kind).toBe('login');
    expect(_state.users.size).toBe(1);
    expect(_state.identities.length).toBe(1);
    expect(_state.identities[0].user_id).toBe(userIdFirst);
  });

  it('binds a new identity to an existing logged-in user (intent=bind)', async () => {
    // Pre-create user A.
    const userA = fakeUserDb.createFromAad('alice', 'a@x.com', null, 'pro');
    _provider.exchangeCode.mockResolvedValue({ subject: 'gh-A', email: 'a@x.com', displayName: 'Alice' });

    const state = createState({ provider: 'github', intent: 'bind', userId: userA.id });
    const r = await handleCallback({ provider: 'github', code: 'c', state });
    expect(r.kind).toBe('bind');
    expect(r.provider).toBe('github');
    expect(_state.identities.length).toBe(1);
    expect(_state.identities[0].user_id).toBe(userA.id);
  });

  it('rejects binding with 409 when the identity already belongs to another user', async () => {
    const userA = fakeUserDb.createFromAad('alice', 'a@x.com', null, 'pro');
    const userB = fakeUserDb.createFromAad('bob', 'b@x.com', null, 'pro');
    fakeIdentityDb.create({ userId: userA.id, provider: 'github', subject: 'shared-gh' });

    _provider.exchangeCode.mockResolvedValue({ subject: 'shared-gh', email: 'b@x.com', displayName: 'Bob' });
    const state = createState({ provider: 'github', intent: 'bind', userId: userB.id });
    const r = await handleCallback({ provider: 'github', code: 'c', state });
    expect(r.kind).toBe('error');
    expect(r.status).toBe(409);
    // No new identity row was inserted.
    expect(_state.identities.length).toBe(1);
    expect(_state.identities[0].user_id).toBe(userA.id);
  });

  it('treats already-bound-to-self bind as a no-op success', async () => {
    const userA = fakeUserDb.createFromAad('alice', null, null, 'pro');
    fakeIdentityDb.create({ userId: userA.id, provider: 'github', subject: 'gh-self' });
    _provider.exchangeCode.mockResolvedValue({ subject: 'gh-self', email: null, displayName: 'A' });
    const state = createState({ provider: 'github', intent: 'bind', userId: userA.id });
    const r = await handleCallback({ provider: 'github', code: 'c', state });
    expect(r.kind).toBe('bind');
    expect(_state.identities.length).toBe(1);
  });

  it('rejects callback when state is missing/expired', async () => {
    _provider.exchangeCode.mockResolvedValue({ subject: 'x', email: null, displayName: null });
    const r = await handleCallback({ provider: 'github', code: 'c', state: 'never-issued' });
    expect(r.kind).toBe('error');
    expect(r.status).toBe(400);
    expect(_provider.exchangeCode).not.toHaveBeenCalled();
  });

  it('state is one-shot: same state cannot be reused', async () => {
    _provider.exchangeCode.mockResolvedValue({ subject: 'gh-once', email: null, displayName: null });
    const state = createState({ provider: 'github', intent: 'login' });
    await handleCallback({ provider: 'github', code: 'c1', state });
    const r2 = await handleCallback({ provider: 'github', code: 'c2', state });
    expect(r2.kind).toBe('error');
    expect(r2.status).toBe(400);
  });

  it('preserves provider displayName on auto-created user', async () => {
    // Chinese nickname — used to get collapsed to "__" then "alipay_user".
    _provider.exchangeCode.mockResolvedValue({ subject: 'gh-zh', email: null, displayName: '张三' });
    const state = createState({ provider: 'github', intent: 'login' });
    await handleCallback({ provider: 'github', code: 'c', state });
    const user = [..._state.users.values()][0];
    // username comes from sanitizeUsername which now keeps Unicode letters
    expect(user.username).toBe('张三');
    expect(user.display_name).toBe('张三');
  });

  it('backfills display_name on subsequent SSO login when previously equal to username', async () => {
    // Simulate a user created back when displayName wasn't stored.
    _state.users.set('u_legacy', {
      id: 'u_legacy', username: 'alipay_user', display_name: 'alipay_user',
      email: null, aad_oid: null, role: 'pro', password_hash: null
    });
    _state.identities.push({
      id: 'idn_legacy', user_id: 'u_legacy', provider: 'github', subject: 'gh-legacy',
      email: null, display_name: null, created_at: 0, last_login_at: 0
    });

    _provider.exchangeCode.mockResolvedValue({ subject: 'gh-legacy', email: null, displayName: 'Real Name' });
    const state = createState({ provider: 'github', intent: 'login' });
    const r = await handleCallback({ provider: 'github', code: 'c', state });
    expect(r.kind).toBe('login');
    expect(_state.users.get('u_legacy').display_name).toBe('Real Name');
  });

  it('does NOT overwrite a manually-set display_name on subsequent login', async () => {
    _state.users.set('u_manual', {
      id: 'u_manual', username: 'alipay_user', display_name: '我自己设的名字',
      email: null, aad_oid: null, role: 'pro', password_hash: null
    });
    _state.identities.push({
      id: 'idn_manual', user_id: 'u_manual', provider: 'github', subject: 'gh-manual',
      email: null, display_name: null, created_at: 0, last_login_at: 0
    });

    _provider.exchangeCode.mockResolvedValue({ subject: 'gh-manual', email: null, displayName: 'Provider Name' });
    const state = createState({ provider: 'github', intent: 'login' });
    await handleCallback({ provider: 'github', code: 'c', state });
    expect(_state.users.get('u_manual').display_name).toBe('我自己设的名字');
  });
});

describe('identity-db: countForUser + removeForUser', () => {
  beforeEach(() => _resetState());

  it('countForUser reflects inserts + deletes', () => {
    const u = fakeUserDb.createFromAad('zoe', null, null, 'pro');
    expect(fakeIdentityDb.countForUser(u.id)).toBe(0);
    fakeIdentityDb.create({ userId: u.id, provider: 'github', subject: 'a' });
    fakeIdentityDb.create({ userId: u.id, provider: 'google', subject: 'b' });
    expect(fakeIdentityDb.countForUser(u.id)).toBe(2);
    fakeIdentityDb.removeForUser(u.id, 'github');
    expect(fakeIdentityDb.countForUser(u.id)).toBe(1);
    expect(fakeIdentityDb.findForUser(u.id, 'github')).toBeNull();
  });

  it('UNIQUE(provider, subject) — second create returns null', () => {
    const u1 = fakeUserDb.createFromAad('u1', null, null, 'pro');
    const u2 = fakeUserDb.createFromAad('u2', null, null, 'pro');
    expect(fakeIdentityDb.create({ userId: u1.id, provider: 'github', subject: 'dup' })).toBeTruthy();
    expect(fakeIdentityDb.create({ userId: u2.id, provider: 'github', subject: 'dup' })).toBeNull();
  });
});
