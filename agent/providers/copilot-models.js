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

import { getApiToken, copilotRequestHeaders, validateRawToken, resolveRawToken } from '../yeaft/llm/credentials/github-copilot.js';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

// Curated fallback — mirrors the CLI's own hardcoded default model list
// (`jF` in @github/copilot/app.js@1.0.59). Used when /models is unavailable
// or when org policy hides the picker list at the API (some enterprise orgs
// gate it). `--model <id>` still accepts these IDs at chat time.
export const FALLBACK_COPILOT_MODELS = Object.freeze([
  { id: 'claude-sonnet-4.6',  label: 'Claude Sonnet 4.6', vendor: 'Anthropic' },
  { id: 'claude-sonnet-4.5',  label: 'Claude Sonnet 4.5', vendor: 'Anthropic' },
  { id: 'claude-haiku-4.5',   label: 'Claude Haiku 4.5',  vendor: 'Anthropic' },
  { id: 'claude-opus-4.8',    label: 'Claude Opus 4.8',   vendor: 'Anthropic' },
  { id: 'claude-opus-4.7',    label: 'Claude Opus 4.7',   vendor: 'Anthropic' },
  { id: 'claude-opus-4.6',    label: 'Claude Opus 4.6',   vendor: 'Anthropic' },
  { id: 'claude-opus-4.5',    label: 'Claude Opus 4.5',   vendor: 'Anthropic' },
  { id: 'gpt-5.5',            label: 'GPT-5.5',           vendor: 'OpenAI'    },
  { id: 'gpt-5.4',            label: 'GPT-5.4',           vendor: 'OpenAI'    },
  { id: 'gpt-5.3-codex',      label: 'GPT-5.3 Codex',     vendor: 'OpenAI'    },
  { id: 'gpt-5.2-codex',      label: 'GPT-5.2 Codex',     vendor: 'OpenAI'    },
  { id: 'gpt-5.2',            label: 'GPT-5.2',           vendor: 'OpenAI'    },
  { id: 'gpt-5.4-mini',       label: 'GPT-5.4 Mini',      vendor: 'OpenAI'    },
  { id: 'gpt-5-mini',         label: 'GPT-5 Mini',        vendor: 'OpenAI'    },
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
let _inflight = null; // dedupes concurrent cold-cache calls

/**
 * Returns a list of `{id, label, vendor, preview, family}` records,
 * picker-enabled chat models only. Cached for 10 minutes. Never throws —
 * falls back to the static list on any error (including network timeout).
 */
export async function listCopilotModels({ force = false } = {}) {
  if (!force && _cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.models.slice();
  }
  if (_inflight) return (await _inflight).slice();
  _inflight = (async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
      const token = await _resolveBearerToken();
      if (!token) return FALLBACK_COPILOT_MODELS.slice();
      const res = await fetch(MODELS_ENDPOINT, {
        signal: ac.signal,
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
    } finally {
      clearTimeout(timer);
    }
  })();
  try {
    return (await _inflight).slice();
  } finally {
    _inflight = null;
  }
}

/** Tests only. */
export function _resetCopilotModelsCacheForTests() { _cache = null; _inflight = null; }
