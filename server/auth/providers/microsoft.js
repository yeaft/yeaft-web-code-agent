/**
 * Microsoft (Azure AD / Entra ID) provider — server-side OIDC code flow.
 *
 * Note: the existing `loginWithAad()` route (POST /api/auth/aad) using MSAL.js
 * client-side popup is preserved for backwards compatibility. This file exposes
 * the same provider under the new unified provider abstraction so binding +
 * server-driven start/callback can reuse one code path.
 */
import { CONFIG, isAadEnabled } from '../../config.js';

export const name = 'microsoft';

export function isEnabled() {
  return isAadEnabled();
}

function authority() {
  return `https://login.microsoftonline.com/${CONFIG.aad.tenantId}`;
}

function callbackUrl() {
  return process.env.SSO_MICROSOFT_CALLBACK_URL || `${CONFIG.aad.redirectBase || ''}/api/auth/sso/microsoft/callback`;
}

export function getAuthorizeUrl(state /* , intent */) {
  const url = new URL(`${authority()}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', CONFIG.aad.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', callbackUrl());
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeCode(code /* , state */) {
  const tokenUrl = `${authority()}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: CONFIG.aad.clientId,
    client_secret: process.env.AAD_CLIENT_SECRET || '',
    code,
    redirect_uri: callbackUrl(),
    grant_type: 'authorization_code'
  });
  const tokRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!tokRes.ok) {
    throw new Error(`Microsoft token exchange failed: ${tokRes.status}`);
  }
  const tok = await tokRes.json();
  if (!tok.id_token) throw new Error('Microsoft token response missing id_token');

  // Decode payload (without verification — verification happens in aad.js for the
  // legacy MSAL.js flow; for server-driven code flow we trust the token from the
  // authority endpoint we just contacted over HTTPS).
  const payload = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString());
  const subject = payload.oid || payload.sub;
  if (!subject) throw new Error('Microsoft id_token missing oid/sub');

  return {
    subject,
    email: payload.preferred_username || payload.email || payload.upn || null,
    displayName: payload.name || null,
    raw: payload
  };
}

export default { name, isEnabled, getAuthorizeUrl, exchangeCode };
