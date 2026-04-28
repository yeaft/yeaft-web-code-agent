/**
 * GitHub OAuth2 provider — server-side code flow.
 * Endpoint: https://github.com/login/oauth/authorize and /access_token
 * Profile API: https://api.github.com/user (requires User-Agent header)
 */
import { CONFIG } from '../../config.js';

export const name = 'github';

export function isEnabled() {
  const c = CONFIG.sso?.github;
  return !!(c?.enabled && c.clientId && c.clientSecret && c.callbackUrl);
}

export function getAuthorizeUrl(state /* , intent */) {
  const c = CONFIG.sso.github;
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', c.clientId);
  url.searchParams.set('redirect_uri', c.callbackUrl);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'true');
  return url.toString();
}

export async function exchangeCode(code /* , state */) {
  const c = CONFIG.sso.github;
  // Step 1: code -> access_token
  const tokRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      code,
      redirect_uri: c.callbackUrl
    })
  });
  if (!tokRes.ok) throw new Error(`GitHub token exchange failed: ${tokRes.status}`);
  const tok = await tokRes.json();
  if (!tok.access_token) throw new Error(`GitHub token response missing access_token: ${tok.error || ''}`);

  // Step 2: access_token -> profile
  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${tok.access_token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'yeaft-webchat'
    }
  });
  if (!userRes.ok) throw new Error(`GitHub /user failed: ${userRes.status}`);
  const profile = await userRes.json();
  if (!profile.id) throw new Error('GitHub /user missing id');

  let email = profile.email;
  if (!email) {
    // Email may be private — fetch /user/emails to find primary verified.
    try {
      const emailRes = await fetch('https://api.github.com/user/emails', {
        headers: {
          'Authorization': `Bearer ${tok.access_token}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'yeaft-webchat'
        }
      });
      if (emailRes.ok) {
        const emails = await emailRes.json();
        const primary = Array.isArray(emails) ? emails.find(e => e.primary && e.verified) : null;
        if (primary) email = primary.email;
      }
    } catch { /* ignore */ }
  }

  return {
    subject: String(profile.id),
    email: email || null,
    displayName: profile.name || profile.login || null,
    raw: profile
  };
}

export default { name, isEnabled, getAuthorizeUrl, exchangeCode };
