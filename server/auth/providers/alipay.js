/**
 * Alipay 网页授权 — RSA2-signed OAuth-like flow.
 *
 * Authorize URL: https://openauth.alipay.com/oauth2/publicAppAuthorize.htm
 * Gateway:       https://openapi.alipay.com/gateway.do (alipay.system.oauth.token, alipay.user.info.share)
 *
 * Subject = `user_id` returned by alipay.user.info.share.
 *
 * Alipay's "OAuth" is non-standard — every API call is signed with the merchant
 * RSA private key per Alipay's signing rules. Node's built-in `crypto` module
 * covers RSA2 (SHA256withRSA), so no extra dependency is needed.
 */
import { createSign } from 'crypto';
import { CONFIG } from '../../config.js';

export const name = 'alipay';

const GATEWAY = 'https://openapi.alipay.com/gateway.do';

export function isEnabled() {
  const c = CONFIG.sso?.alipay;
  return !!(c?.enabled && c.appId && c.privateKey && c.callbackUrl);
}

export function getAuthorizeUrl(state /* , intent */) {
  const c = CONFIG.sso.alipay;
  const url = new URL('https://openauth.alipay.com/oauth2/publicAppAuthorize.htm');
  url.searchParams.set('app_id', c.appId);
  url.searchParams.set('scope', 'auth_user');
  url.searchParams.set('redirect_uri', c.callbackUrl);
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Build an Alipay request payload, sign it with RSA2, and POST to the gateway.
 */
async function alipayCall(method, bizContent) {
  const c = CONFIG.sso.alipay;
  const params = {
    app_id: c.appId,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
    version: '1.0',
    ...bizContent
  };

  // Alipay signing rule: sort keys alphabetically, build k=v&k=v string, exclude
  // `sign` itself and any empty values.
  const signStr = Object.keys(params)
    .filter(k => k !== 'sign' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');

  const signer = createSign('RSA-SHA256');
  signer.update(signStr, 'utf8');
  const privateKey = c.privateKey.includes('BEGIN')
    ? c.privateKey
    : `-----BEGIN RSA PRIVATE KEY-----\n${c.privateKey}\n-----END RSA PRIVATE KEY-----`;
  const sign = signer.sign(privateKey, 'base64');

  const body = new URLSearchParams({ ...params, sign });
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body
  });
  if (!res.ok) throw new Error(`Alipay ${method} HTTP ${res.status}`);
  return res.json();
}

export async function exchangeCode(code /* , state */) {
  // Step 1: code -> access_token
  const tokRes = await alipayCall('alipay.system.oauth.token', {
    grant_type: 'authorization_code',
    code
  });
  const tokInner = tokRes.alipay_system_oauth_token_response;
  if (!tokInner) throw new Error(`Alipay token exchange unexpected response: ${JSON.stringify(tokRes)}`);
  if (tokInner.code && tokInner.code !== '10000') {
    throw new Error(`Alipay token error ${tokInner.code}: ${tokInner.msg || ''}`);
  }
  if (!tokInner.access_token) throw new Error('Alipay token response missing access_token');

  // Step 2: access_token -> profile
  const userRes = await alipayCall('alipay.user.info.share', {
    auth_token: tokInner.access_token
  });
  const userInner = userRes.alipay_user_info_share_response;
  if (!userInner) throw new Error('Alipay user info missing response wrapper');
  if (userInner.code && userInner.code !== '10000') {
    throw new Error(`Alipay user info error ${userInner.code}: ${userInner.msg || ''}`);
  }

  // Prefer open_id (per-app stable ID under Alipay's privacy/openid mode, on by
  // default for apps created since 2023). Fall back to user_id for legacy apps
  // that haven't migrated. Either is a stable per-user subject for binding.
  const subject = userInner.open_id || tokInner.open_id || userInner.user_id || tokInner.user_id;
  if (!subject) throw new Error('Alipay profile missing open_id/user_id');

  return {
    subject,
    email: null, // Alipay does not return email by default
    displayName: userInner.nick_name || userInner.user_name || null,
    raw: userInner
  };
}

export default { name, isEnabled, getAuthorizeUrl, exchangeCode };
