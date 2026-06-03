/**
 * Copilot model list.
 *
 * The Copilot CLI accepts `--model <id>` and the agent-facing API exposes
 * `GET https://api.githubcopilot.com/models` — the same endpoint VS Code's
 * model picker uses. We hit it on demand (cached in-process for 10 min),
 * filter to picker-enabled chat models, and fall back to a curated static
 * list if the network call fails (so the UI never shows an empty picker).
 *
 * Auth re-uses the existing `agent/yeaft/llm/credentials/github-copilot.js`
 * credential pipeline — gh CLI / env / persisted OAuth all work; the user
 * does not need to paste an API key as long as Copilot CLI is logged in.
 */

import { getApiToken, copilotRequestHeaders, validateRawToken } from '../yeaft/llm/credentials/github-copilot.js';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

// Curated fallback — small, but covers the common picks if /models is down or
// the user has no Copilot auth available yet.
export const FALLBACK_COPILOT_MODELS = Object.freeze([
  { id: 'claude-sonnet-4.5',  label: 'Claude Sonnet 4.5', vendor: 'Anthropic' },
  { id: 'claude-sonnet-4',    label: 'Claude Sonnet 4',   vendor: 'Anthropic' },
  { id: 'claude-opus-4.1',    label: 'Claude Opus 4.1',   vendor: 'Anthropic' },
  { id: 'gpt-5',              label: 'GPT-5',             vendor: 'OpenAI'    },
  { id: 'gpt-5-mini',         label: 'GPT-5 Mini',        vendor: 'OpenAI'    },
  { id: 'gpt-4.1',            label: 'GPT-4.1',           vendor: 'OpenAI'    },
  { id: 'gemini-2.5-pro',     label: 'Gemini 2.5 Pro',    vendor: 'Google'    },
]);

export const DEFAULT_COPILOT_MODEL = 'claude-sonnet-4.5';

const MODELS_ENDPOINT = 'https://api.githubcopilot.com/models';
const CACHE_TTL_MS = 10 * 60 * 1000;
const COPILOT_CLI_CONFIG = join(homedir(), '.copilot', 'config.json');

/**
 * Last-resort token source: the Copilot CLI itself caches an OAuth token at
 * ~/.copilot/config.json after `copilot login`. If the standard yeaft
 * credential pipeline (env / gh CLI / persisted device flow) didn't surface
 * a token, we re-use the CLI's. Same auth surface — no extra perm needed.
 */
async function _resolveCopilotCliToken() {
  try {
    const raw = await readFile(COPILOT_CLI_CONFIG, 'utf8');
    // Copilot CLI's config.json starts with `//` comments. Strip line comments
    // before JSON.parse — the file otherwise has no string-context `//`.
    const cleaned = raw.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const cfg = JSON.parse(cleaned);
    const tokens = cfg?.copilotTokens && typeof cfg.copilotTokens === 'object' ? cfg.copilotTokens : null;
    if (!tokens) return null;
    for (const tok of Object.values(tokens)) {
      if (typeof tok === 'string' && validateRawToken(tok).valid) return tok;
    }
    return null;
  } catch {
    return null;
  }
}

async function _resolveBearerToken() {
  // The /models endpoint accepts the GitHub OAuth token directly as a Bearer
  // — no token exchange needed (unlike the chat-completion endpoints). So we
  // prefer the raw OAuth from the standard yeaft pipeline first, then fall
  // back to the Copilot CLI's own cached OAuth at ~/.copilot/config.json.
  try {
    const { resolveRawToken } = await import('../yeaft/llm/credentials/github-copilot.js');
    const raw = await resolveRawToken();
    if (raw?.token) return raw.token;
  } catch { /* fall through */ }
  const cliRaw = await _resolveCopilotCliToken();
  if (cliRaw) return cliRaw;
  // Last resort: try exchanged token (works for chat endpoints; may also work
  // if /models gained that auth path in future).
  const cred = await getApiToken();
  return cred?.token || null;
}

let _cache = null; // { models, fetchedAt }

/**
 * Returns a list of `{id, label, vendor, preview}` records, picker-enabled
 * chat models only. Cached for 10 minutes. Never throws — falls back to the
 * static list on any error.
 */
export async function listCopilotModels({ force = false } = {}) {
  if (!force && _cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.models.slice();
  }
  try {
    const token = await _resolveBearerToken();
    if (!token) return FALLBACK_COPILOT_MODELS.slice();
    const res = await fetch(MODELS_ENDPOINT, {
      headers: { ...copilotRequestHeaders({ isAgentTurn: false }), Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return FALLBACK_COPILOT_MODELS.slice();
    const body = await res.json();
    const data = Array.isArray(body?.data) ? body.data : [];
    const models = data
      .filter(m => m && m.model_picker_enabled && m.capabilities?.type === 'chat')
      .map(m => ({
        id: m.id,
        label: m.name || m.id,
        vendor: m.vendor || '',
        preview: !!m.preview,
        family: m.capabilities?.family || '',
      }));
    if (!models.length) return FALLBACK_COPILOT_MODELS.slice();
    _cache = { models, fetchedAt: Date.now() };
    return models.slice();
  } catch {
    return FALLBACK_COPILOT_MODELS.slice();
  }
}

/** Tests only. */
export function _resetCopilotModelsCacheForTests() { _cache = null; }
