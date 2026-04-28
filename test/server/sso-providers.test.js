/**
 * SSO provider unit tests — verify each provider's exchangeCode() returns the
 * expected { subject, email, displayName } shape from canonical mocked
 * responses, and that getAuthorizeUrl() emits the right host + state.
 *
 * NOTE: These tests pull in server/config.js (transitively node:sqlite) so they
 * require Node 22.5+. They share the same environmental requirement as other
 * server-side tests in this repo.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockFetch, restoreFetch, fakeIdToken } from '../helpers/ssoMocks.js';

// Stub config.js so providers don't transitively import server/database.js
// (which requires Node 22.5+ via node:sqlite).
vi.mock('../../server/config.js', () => ({
  CONFIG: {
    sso: {
      github: { enabled: true, clientId: 'gh-client', clientSecret: 'gh-secret', callbackUrl: 'https://example.com/cb' },
      google: { enabled: true, clientId: 'g-client', clientSecret: 'g-secret', callbackUrl: 'https://example.com/cb' },
      wechat: { enabled: true, appId: 'wx-app', appSecret: 'wx-secret', callbackUrl: 'https://example.com/cb' },
      alipay: { enabled: false }
    }
  }
}));

const github = await import('../../server/auth/providers/github.js');
const google = await import('../../server/auth/providers/google.js');
const wechat = await import('../../server/auth/providers/wechat.js');

describe('SSO providers — getAuthorizeUrl', () => {
  it('GitHub authorize URL includes state + client_id + scope', () => {
    const url = github.getAuthorizeUrl('xyz-state');
    expect(url).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    expect(url).toContain('state=xyz-state');
    expect(url).toContain('client_id=gh-client');
    expect(url).toContain('scope=read%3Auser+user%3Aemail');
  });

  it('Google authorize URL targets accounts.google.com with openid scope', () => {
    const url = google.getAuthorizeUrl('abc');
    expect(url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    expect(url).toContain('state=abc');
    expect(url).toContain('scope=openid+email+profile');
  });

  it('WeChat authorize URL targets open.weixin.qq.com qrconnect with #wechat_redirect', () => {
    const url = wechat.getAuthorizeUrl('s1');
    expect(url).toMatch(/^https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect\?/);
    expect(url).toContain('appid=wx-app');
    expect(url).toContain('state=s1');
    expect(url.endsWith('#wechat_redirect')).toBe(true);
  });
});

describe('SSO providers — exchangeCode (mocked fetch)', () => {
  beforeEach(() => restoreFetch());
  afterEach(() => restoreFetch());

  it('GitHub: code → access_token → /user → { subject, email, displayName }', async () => {
    mockFetch({
      'https://github.com/login/oauth/access_token': { ok: true, json: { access_token: 'gh-token' } },
      'https://api.github.com/user': { ok: true, json: { id: 9001, login: 'octo', name: 'Octocat', email: 'octo@example.com' } }
    });
    const r = await github.exchangeCode('thecode');
    expect(r.subject).toBe('9001');
    expect(r.email).toBe('octo@example.com');
    expect(r.displayName).toBe('Octocat');
  });

  it('GitHub: falls back to /user/emails when /user.email is null', async () => {
    mockFetch({
      'https://github.com/login/oauth/access_token': { ok: true, json: { access_token: 'gh-token' } },
      'https://api.github.com/user': { ok: true, json: { id: 42, login: 'priv', email: null } },
      'https://api.github.com/user/emails': {
        ok: true,
        json: [{ email: 'priv@x.com', primary: true, verified: true }, { email: 'alt@x.com', primary: false, verified: true }]
      }
    });
    const r = await github.exchangeCode('thecode');
    expect(r.subject).toBe('42');
    expect(r.email).toBe('priv@x.com');
  });

  it('GitHub: throws on missing access_token', async () => {
    mockFetch({
      'https://github.com/login/oauth/access_token': { ok: true, json: { error: 'bad_code' } }
    });
    await expect(github.exchangeCode('bad')).rejects.toThrow(/access_token/);
  });

  it('Google: id_token.sub becomes subject', async () => {
    const idToken = fakeIdToken({ sub: 'google-sub-123', email: 'g@x.com', name: 'G User' });
    mockFetch({
      'https://oauth2.googleapis.com/token': { ok: true, json: { id_token: idToken, access_token: 'a' } }
    });
    const r = await google.exchangeCode('code');
    expect(r.subject).toBe('google-sub-123');
    expect(r.email).toBe('g@x.com');
    expect(r.displayName).toBe('G User');
  });

  it('Google: throws when id_token missing sub', async () => {
    const idToken = fakeIdToken({ email: 'no-sub@x.com' });
    mockFetch({
      'https://oauth2.googleapis.com/token': { ok: true, json: { id_token: idToken } }
    });
    await expect(google.exchangeCode('code')).rejects.toThrow(/sub/);
  });

  it('WeChat: prefers unionid over openid as subject', async () => {
    mockFetch({
      'https://api.weixin.qq.com/sns/oauth2/access_token': { ok: true, json: { access_token: 'wx-token', openid: 'open-1', unionid: 'union-9' } },
      'https://api.weixin.qq.com/sns/userinfo': { ok: true, json: { openid: 'open-1', unionid: 'union-9', nickname: '微信用户' } }
    });
    const r = await wechat.exchangeCode('code');
    expect(r.subject).toBe('union-9');
    expect(r.displayName).toBe('微信用户');
  });

  it('WeChat: falls back to openid if no unionid', async () => {
    mockFetch({
      'https://api.weixin.qq.com/sns/oauth2/access_token': { ok: true, json: { access_token: 'wx-token', openid: 'open-only' } },
      'https://api.weixin.qq.com/sns/userinfo': { ok: true, json: { openid: 'open-only', nickname: 'name' } }
    });
    const r = await wechat.exchangeCode('code');
    expect(r.subject).toBe('open-only');
  });
});
