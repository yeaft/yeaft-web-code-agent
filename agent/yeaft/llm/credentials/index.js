/**
 * credentials/index.js — Registry of credential providers.
 *
 * A "credential provider" knows how to produce an apiKey for a provider
 * dynamically — at request time — instead of the user pasting a static
 * string into config.json. Today we ship one: `github-copilot` (env vars,
 * disk-cached device-flow token, or the `gh` CLI).
 *
 * Contract:
 *   getApiKey() → Promise<string>
 *   Throws if no credential is available so the router surfaces a
 *   clear error rather than sending an empty Authorization header.
 *
 * Routing-time contract: the registry is consulted ONLY when a provider
 * config sets `credentialProvider: "<name>"`. Providers without this
 * field follow the existing static `apiKey` path unchanged — that is the
 * regression guard.
 */

import * as githubCopilot from './github-copilot.js';

/**
 * @typedef {{ getApiKey: () => Promise<string>, name: string }} CredentialProvider
 */

/**
 * @param {string} name
 * @returns {CredentialProvider | null}
 */
export function getCredentialProvider(name) {
  if (name === 'github-copilot') {
    return {
      name: 'github-copilot',
      async getApiKey() {
        const r = await githubCopilot.getApiToken();
        if (!r || !r.token) {
          throw new Error(
            'github-copilot credential provider could not resolve a token. ' +
            'Try: set COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN env var, ' +
            'or run `gh auth login`, or sign in via the device flow.'
          );
        }
        return r.token;
      },
    };
  }
  return null;
}

/**
 * Names of registered credential providers. UI uses this to populate the
 * picker; keep in sync with `getCredentialProvider` above.
 */
export const CREDENTIAL_PROVIDER_NAMES = ['github-copilot'];
