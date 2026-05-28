/**
 * github-copilot.js — GitHub Copilot credential provider.
 *
 * Resolves a GitHub OAuth token usable with the Copilot API and exchanges
 * it for the short-lived Copilot API token. Ported from hermes' Python
 * `copilot_auth.py` (https://github.com/hermes-agent), same client id and
 * the same VS Code / Copilot CLI headers so a working `gh auth login` on
 * the host machine is enough — the user does NOT need to paste an API key.
 *
 * Resolution order (matches hermes / Copilot CLI):
 *   1. env  COPILOT_GITHUB_TOKEN
 *   2. env  GH_TOKEN
 *   3. env  GITHUB_TOKEN
 *   4. disk ~/.yeaft/credentials/github-copilot.json (persisted device flow)
 *   5. shell `gh auth token` (with GITHUB_TOKEN/GH_TOKEN stripped so gh
 *      reads its own credential store instead of echoing env back)
 *
 * Token kinds:
 *   gho_*         OAuth                  ✓
 *   github_pat_*  Fine-grained PAT       ✓ (needs Copilot Requests perm)
 *   ghu_*         GitHub App token       ✓
 *   ghp_*         Classic PAT            ✗ Copilot API rejects these.
 *
 * The exchanged Copilot API token is a short-lived (~30min) string used
 * as `Authorization: Bearer <token>`. We cache it in-process keyed by a
 * sha256 fingerprint of the raw token (so different raw tokens don't
 * collide) and refresh 120s before expiry.
 *
 * NOTE: This module makes NO network calls at import time. All I/O is
 * lazy. Tests can stub `fetch` and `child_process.execFile` to exercise
 * every branch without touching real GitHub.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, mkdir, stat, chmod } from 'fs/promises';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { join, dirname } from 'path';

const execFileAsync = promisify(execFile);

// Same client_id used by Copilot CLI / opencode / hermes. Public — fine to ship.
export const COPILOT_OAUTH_CLIENT_ID = 'Ov23li8tweQw6odWQebz';

const CLASSIC_PAT_PREFIX = 'ghp_';
const SUPPORTED_PREFIXES = ['gho_', 'github_pat_', 'ghu_'];
const ENV_VARS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];

const TOKEN_EXCHANGE_URL = 'https://api.github.com/copilot_internal/v2/token';
const DEVICE_CODE_URL_TEMPLATE = host => `https://${host}/login/device/code`;
const ACCESS_TOKEN_URL_TEMPLATE = host => `https://${host}/login/oauth/access_token`;

const EDITOR_VERSION = 'vscode/1.104.1';
const EXCHANGE_USER_AGENT = 'GitHubCopilotChat/0.26.7';
const REQUEST_USER_AGENT = 'claude-web-chat/1.0';

const JWT_REFRESH_MARGIN_SECONDS = 120;
const DEVICE_POLL_SAFETY_MARGIN_SECONDS = 3;
const DEFAULT_DEVICE_TIMEOUT_SECONDS = 300;

const CREDENTIALS_DIR = join(homedir(), '.yeaft', 'credentials');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'github-copilot.json');

// In-process cache: rawTokenFingerprint → { apiToken, expiresAt }.
// Keyed by fingerprint (not the token itself) so we never keep the secret
// in two places. Reset via _resetCacheForTests.
const _jwtCache = new Map();

// In-flight exchange promises keyed by fingerprint. Dedupes concurrent
// `exchangeToken` calls for the same raw token so we make ONE network call
// instead of N when several requests race during a cold start or a refresh.
const _exchangeInFlight = new Map();

/**
 * Reset all in-process state. Tests only.
 */
export function _resetCacheForTests() {
  _jwtCache.clear();
  _exchangeInFlight.clear();
}

/**
 * Anchor for `gh auth token` output validation. gh prints either a bare
 * token followed by a newline or, on misconfiguration, a help banner /
 * error text. We only accept output that looks like a GitHub token, so
 * the help banner doesn't get treated as a credential.
 */
const GH_TOKEN_SHAPE = /^(gho_|github_pat_|ghu_|ghs_)[A-Za-z0-9_]{20,}$/;

/**
 * Validate a raw GitHub token shape. Copilot API rejects classic PATs.
 *
 * @param {string} token
 * @returns {{valid: boolean, message: string}}
 */
export function validateRawToken(token) {
  const trimmed = (token || '').trim();
  if (!trimmed) return { valid: false, message: 'Empty token' };
  if (trimmed.startsWith(CLASSIC_PAT_PREFIX)) {
    return {
      valid: false,
      message:
        'Classic Personal Access Tokens (ghp_*) are not supported by the ' +
        'Copilot API. Use `gh auth login` (produces gho_*) or a fine-grained ' +
        'PAT with the Copilot Requests permission.',
    };
  }
  // Accept supported prefixes OR anything else that's non-empty — GitHub may
  // introduce new prefixes; we surface server-side rejection later rather
  // than refusing here.
  const supported = SUPPORTED_PREFIXES.some(p => trimmed.startsWith(p));
  if (!supported) {
    return { valid: true, message: 'Unknown prefix, will try anyway' };
  }
  return { valid: true, message: 'OK' };
}

/**
 * Read the persisted device-flow token, if any. Returns null on missing /
 * malformed file. Does NOT throw — callers fall through to the next source.
 *
 * @returns {Promise<{token: string, source: string, obtainedAt: number} | null>}
 */
export async function readPersistedToken() {
  try {
    const buf = await readFile(CREDENTIALS_FILE, 'utf8');
    const obj = JSON.parse(buf);
    if (obj && typeof obj.token === 'string' && obj.token) return obj;
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist a device-flow token. File mode is 0600 so other users on the
 * machine can't read it. Directory created with 0700.
 *
 * @param {{token: string, source: string}} entry
 */
export async function writePersistedToken({ token, source }) {
  await mkdir(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({ token, source, obtainedAt: Date.now() }, null, 2);
  await writeFile(CREDENTIALS_FILE, payload, { mode: 0o600 });
  // mkdir's `mode` is masked by umask on some systems; ensure dir perms too.
  try {
    const s = await stat(CREDENTIALS_DIR);
    if ((s.mode & 0o077) !== 0) {
      await chmod(CREDENTIALS_DIR, 0o700);
    }
  } catch { /* best effort */ }
}

/**
 * Run `gh auth token`. Strips GITHUB_TOKEN/GH_TOKEN from the subprocess
 * env so gh reads `hosts.yml` instead of echoing the env back at us.
 *
 * @param {object} [opts]
 * @param {string} [opts.hostname] — pass --hostname to gh
 * @returns {Promise<string | null>}
 */
export async function tryGhCliToken({ hostname } = {}) {
  const args = ['auth', 'token'];
  if (hostname) args.push('--hostname', hostname);

  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;

  // Don't bother probing every Homebrew path — `gh` on PATH covers 99% of
  // installs. If the user's `gh` isn't on PATH the env vars or device flow
  // are the fallback.
  try {
    const { stdout } = await execFileAsync('gh', args, {
      timeout: 5000,
      env,
      windowsHide: true,
    });
    const trimmed = (stdout || '').trim();
    if (!trimmed) return null;
    // Guard against gh printing a help banner / error text when not logged
    // in. We only trust output that matches the GitHub token shape.
    if (!GH_TOKEN_SHAPE.test(trimmed)) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Resolve a raw GitHub token from env / disk / gh CLI. Returns
 * `{token, source}` or `null` if no usable token is available.
 *
 * Sources are tried in priority order; the first valid one wins. Classic
 * PATs (ghp_*) found in env are SKIPPED (they don't work with Copilot)
 * rather than returned as an error — the next source still gets a chance.
 *
 * @param {object} [opts]
 * @param {string} [opts.hostname] — passed through to gh CLI
 * @returns {Promise<{token: string, source: string} | null>}
 */
export async function resolveRawToken({ hostname } = {}) {
  // 1-3: env vars
  for (const name of ENV_VARS) {
    const val = (process.env[name] || '').trim();
    if (!val) continue;
    if (validateRawToken(val).valid) {
      return { token: val, source: `env:${name}` };
    }
  }

  // 4: persisted device-flow token
  const persisted = await readPersistedToken();
  if (persisted && validateRawToken(persisted.token).valid) {
    return { token: persisted.token, source: persisted.source || 'persisted' };
  }

  // 5: gh CLI
  const ghToken = await tryGhCliToken({ hostname });
  if (ghToken && validateRawToken(ghToken).valid) {
    return { token: ghToken, source: 'gh-cli' };
  }

  return null;
}

/**
 * sha256-prefix fingerprint of a raw token. Never log the token itself.
 */
function tokenFingerprint(rawToken) {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Exchange a raw GitHub token for a short-lived Copilot API token. Caches
 * in-process; refreshes 120s before expiry. On failure, throws — caller
 * may choose to fall back to the raw token (see `getApiToken`).
 *
 * @param {string} rawToken
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchFn] — for tests
 * @returns {Promise<{apiToken: string, expiresAt: number}>}
 */
export async function exchangeToken(rawToken, { fetchFn = fetch } = {}) {
  if (!rawToken) throw new Error('exchangeToken: empty rawToken');

  const fp = tokenFingerprint(rawToken);
  const cached = _jwtCache.get(fp);
  const now = Math.floor(Date.now() / 1000);
  if (cached && now < cached.expiresAt - JWT_REFRESH_MARGIN_SECONDS) {
    return cached;
  }

  // Dedupe: if another caller is already exchanging the same token, await
  // their result instead of firing a parallel request. Cleared in finally
  // so a failure doesn't poison the next attempt.
  const inFlight = _exchangeInFlight.get(fp);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const res = await fetchFn(TOKEN_EXCHANGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `token ${rawToken}`,
        'User-Agent': EXCHANGE_USER_AGENT,
        Accept: 'application/json',
        'Editor-Version': EDITOR_VERSION,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Copilot token exchange failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const apiToken = data && typeof data.token === 'string' ? data.token : '';
    if (!apiToken) throw new Error('Copilot token exchange returned empty token');

    const expiresAtRaw = data.expires_at;
    const expiresAt =
      typeof expiresAtRaw === 'number' && expiresAtRaw > 0
        ? expiresAtRaw
        : now + 1800; // hermes default: 30 minutes

    const entry = { apiToken, expiresAt };
    _jwtCache.set(fp, entry);
    return entry;
  })();

  _exchangeInFlight.set(fp, promise);
  try {
    return await promise;
  } finally {
    _exchangeInFlight.delete(fp);
  }
}

/**
 * Convenience: resolve a raw token AND exchange it. On exchange failure,
 * falls back to the raw token (matches hermes' `get_copilot_api_token`).
 *
 * Returns null if no raw token can be resolved at all.
 *
 * @param {object} [opts]
 * @param {string} [opts.hostname]
 * @param {typeof fetch} [opts.fetchFn]
 * @returns {Promise<{token: string, source: string, exchanged: boolean} | null>}
 */
export async function getApiToken({ hostname, fetchFn = fetch } = {}) {
  const raw = await resolveRawToken({ hostname });
  if (!raw) return null;
  try {
    const { apiToken } = await exchangeToken(raw.token, { fetchFn });
    return { token: apiToken, source: raw.source, exchanged: true };
  } catch {
    return { token: raw.token, source: raw.source, exchanged: false };
  }
}

/**
 * Headers that Copilot API expects in addition to Authorization. These
 * match the VS Code / Copilot CLI conventions and unlock the internal-only
 * models for accounts that have them.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.isAgentTurn] default true
 * @param {boolean} [opts.isVision] default false
 * @returns {Record<string, string>}
 */
export function copilotRequestHeaders({ isAgentTurn = true, isVision = false } = {}) {
  const h = {
    'Editor-Version': EDITOR_VERSION,
    'User-Agent': REQUEST_USER_AGENT,
    'Copilot-Integration-Id': 'vscode-chat',
    'Openai-Intent': 'conversation-edits',
    'x-initiator': isAgentTurn ? 'agent' : 'user',
  };
  if (isVision) h['Copilot-Vision-Request'] = 'true';
  return h;
}

// ─── Device Flow (used by future UI handler) ─────────────────────

/**
 * Step 1 of the GitHub OAuth device flow. Returns the user-visible
 * verification URI + user code plus the device_code needed for polling.
 *
 * @param {object} [opts]
 * @param {string} [opts.host] default github.com
 * @param {typeof fetch} [opts.fetchFn]
 * @returns {Promise<{deviceCode: string, userCode: string, verificationUri: string, interval: number, expiresIn: number}>}
 */
export async function startDeviceFlow({ host = 'github.com', fetchFn = fetch } = {}) {
  const body = new URLSearchParams({
    client_id: COPILOT_OAUTH_CLIENT_ID,
    scope: 'read:user',
  });
  const res = await fetchFn(DEVICE_CODE_URL_TEMPLATE(host), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': REQUEST_USER_AGENT,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`GitHub device code request failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data.device_code || !data.user_code) {
    throw new Error('GitHub did not return a device code');
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri || `https://${host}/login/device`,
    interval: Math.max(Number(data.interval) || 5, 1),
    expiresIn: Number(data.expires_in) || DEFAULT_DEVICE_TIMEOUT_SECONDS,
  };
}

/**
 * Poll the access-token endpoint exactly once. Returns one of:
 *   { status: 'success', token }
 *   { status: 'pending' }
 *   { status: 'slow_down', interval }   — caller MUST adopt the new interval
 *   { status: 'expired' }
 *   { status: 'denied' }
 *   { status: 'error', error }
 *
 * @param {{deviceCode: string, host?: string, fetchFn?: typeof fetch}} params
 */
export async function pollDeviceFlow({ deviceCode, host = 'github.com', fetchFn = fetch }) {
  const body = new URLSearchParams({
    client_id: COPILOT_OAUTH_CLIENT_ID,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  const res = await fetchFn(ACCESS_TOKEN_URL_TEMPLATE(host), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': REQUEST_USER_AGENT,
    },
    body: body.toString(),
  });
  // GitHub returns 200 even for the pending/slow_down cases; treat HTTP
  // failures as transient and let the caller's loop retry.
  if (!res.ok) {
    return { status: 'error', error: `HTTP ${res.status}` };
  }
  const data = await res.json();
  if (data.access_token) {
    return { status: 'success', token: data.access_token };
  }
  switch (data.error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down': {
      const next = Number(data.interval);
      return { status: 'slow_down', interval: Number.isFinite(next) && next > 0 ? next : null };
    }
    case 'expired_token':
      return { status: 'expired' };
    case 'access_denied':
      return { status: 'denied' };
    default:
      return { status: 'error', error: data.error || 'unknown' };
  }
}

/**
 * Run the full device flow: kick off, then poll until success/failure/timeout.
 * Calls `onPending({userCode, verificationUri, expiresIn})` immediately so
 * the caller can present the code to the user.
 *
 * @param {object} opts
 * @param {(info: {userCode: string, verificationUri: string, expiresIn: number}) => void} opts.onPending
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutSeconds]
 * @param {string} [opts.host]
 * @param {typeof fetch} [opts.fetchFn]
 * @param {(ms: number) => Promise<void>} [opts.sleepFn] — for tests
 * @returns {Promise<string>} the raw OAuth token
 */
export async function runDeviceFlow({
  onPending,
  signal,
  timeoutSeconds = DEFAULT_DEVICE_TIMEOUT_SECONDS,
  host = 'github.com',
  fetchFn = fetch,
  sleepFn = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  const start = await startDeviceFlow({ host, fetchFn });
  if (typeof onPending === 'function') {
    onPending({
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      expiresIn: start.expiresIn,
    });
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  let interval = start.interval;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('device flow aborted');
    // Race the sleep against the abort signal so cancellation is observed
    // immediately instead of waiting out the current poll interval.
    await abortableSleep(sleepFn, (interval + DEVICE_POLL_SAFETY_MARGIN_SECONDS) * 1000, signal);
    if (signal?.aborted) throw new Error('device flow aborted');
    const r = await pollDeviceFlow({ deviceCode: start.deviceCode, host, fetchFn });
    if (r.status === 'success') {
      // Don't fail the flow if persist fails — the token in memory is still
      // usable for this process. Warn so a recurring failure stays visible.
      try {
        await writePersistedToken({ token: r.token, source: 'device-flow' });
      } catch (err) {
        console.warn(`[copilot-auth] failed to persist device-flow token: ${err.message}`);
      }
      return r.token;
    }
    if (r.status === 'pending') continue;
    if (r.status === 'slow_down') {
      if (r.interval) interval = r.interval;
      else interval += 5;
      continue;
    }
    if (r.status === 'expired') throw new Error('device code expired');
    if (r.status === 'denied') throw new Error('authorization denied');
    // status === 'error' — treat as transient; loop continues.
  }
  throw new Error('device flow timed out');
}

/**
 * Sleep that resolves either when the timeout elapses or when the abort
 * signal fires (whichever comes first). The signal listener is removed in
 * the cleanup paths so we don't leak listeners across many poll cycles.
 */
function abortableSleep(sleepFn, ms, signal) {
  if (!signal) return sleepFn(ms);
  return new Promise(resolve => {
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort);
    sleepFn(ms).then(() => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}
