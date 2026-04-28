/**
 * Google OIDC provider — server-side code flow.
 * Endpoint: https://accounts.google.com/o/oauth2/v2/auth
 * Token endpoint: https://oauth2.googleapis.com/token
 * The id_token contains a stable `sub` (Google account id).
 */
import { CONFIG } from '../../config.js';

export const name = 'google';

export function isEnabled() {
  const c = CONFIG.sso?.google;
  return !!(c?.enabled && c.clientId && c.clientSecret && c.callbackUrl);
}

export function getAuthorizeUrl(state /* , intent */) {
  const c = CONFIG.sso.google;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', c.clientId);
  url.searchParams.set('redirect_uri', c.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'online');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export async function exchangeCode(code /* , state */) {
  const c = CONFIG.sso.google;
  const body = new URLSearchParams({
    code,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: c.callbackUrl,
    grant_type: 'authorization_code'
  });
  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!tokRes.ok) throw new Error(`Google token exchange failed: ${tokRes.status}`);
  const tok = await tokRes.json();
  if (!tok.id_token) throw new Error('Google token response missing id_token');

  // Decode id_token payload (TLS to googleapis.com guarantees authenticity for
  // this confidential-client server-side code flow).
  const payload = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString());
  if (!payload.sub) throw new Error('Google id_token missing sub');

  return {
    subject: payload.sub,
    email: payload.email || null,
    displayName: payload.name || payload.email || null,
    raw: payload
  };
}

export default { name, isEnabled, getAuthorizeUrl, exchangeCode };
