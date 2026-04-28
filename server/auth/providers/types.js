/**
 * Provider abstraction shape (multi-provider SSO).
 *
 * Every provider implementation must export an object with this shape:
 *
 *   {
 *     name: 'github',                      // unique identifier
 *     isEnabled() => boolean,              // gate routes + UI
 *     getAuthorizeUrl(state, intent) => string,
 *     exchangeCode(code, state) => Promise<{ subject, email, displayName, raw }>
 *   }
 *
 * `subject` MUST be a stable provider-side user id (oid/sub/unionid/user_id).
 * `state` is opaque to the provider — generated/validated by oauth-flow.js.
 */

import * as microsoft from './microsoft.js';
import * as github from './github.js';
import * as google from './google.js';
import * as wechat from './wechat.js';
import * as alipay from './alipay.js';

const REGISTRY = {
  microsoft: microsoft.default || microsoft,
  github: github.default || github,
  google: google.default || google,
  wechat: wechat.default || wechat,
  alipay: alipay.default || alipay
};

/**
 * Look up a provider implementation by name.
 * Returns null if the name is unknown.
 */
export function getProvider(name) {
  return REGISTRY[name] || null;
}

/**
 * List all known provider names (whether enabled or not).
 */
export function listProviderNames() {
  return Object.keys(REGISTRY);
}

/**
 * List the names of all currently-enabled providers.
 */
export function listEnabledProviders() {
  return Object.entries(REGISTRY)
    .filter(([, p]) => {
      try { return p.isEnabled && p.isEnabled(); } catch { return false; }
    })
    .map(([name]) => name);
}

export default REGISTRY;
