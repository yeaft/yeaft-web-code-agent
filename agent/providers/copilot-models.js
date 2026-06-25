/**
 * Copilot model list.
 *
 * Source of truth (in order): another module can prime the in-process cache
 * by calling `cacheCopilotModelsFromAcp(availableModels)` after a successful
 * `session/new` — that response carries the full model list the CLI itself
 * would show in its `/model` picker, including pricing/usage metadata. If
 * the cache is cold when `listCopilotModels()` is called (e.g. the model
 * picker is opened before any Copilot conversation has started), we spawn
 * a one-shot `copilot --acp` child, do the `initialize` + `session/new`
 * handshake to get the same list, then close. Falls back to a static curated
 * list if even that fails.
 *
 * Why ACP and not the HTTP `/models` endpoint: the HTTP endpoint is gated
 * by org policy on enterprise accounts and frequently returns only legacy
 * models. ACP `session/new` always returns the real per-account picker list.
 */

import { spawn } from 'child_process';
import { AcpClient } from './acp-client.js';

// Curated fallback — last resort if no ACP cache and no live probe works.
// Vendor inferred from id prefix when missing.
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
  { id: 'gpt-5.2',            label: 'GPT-5.2',           vendor: 'OpenAI'    },
  { id: 'gpt-5.4-mini',       label: 'GPT-5.4 Mini',      vendor: 'OpenAI'    },
  { id: 'gpt-5-mini',         label: 'GPT-5 Mini',        vendor: 'OpenAI'    },
  { id: 'gemini-2.5-pro',     label: 'Gemini 2.5 Pro',    vendor: 'Google'    },
]);

export const DEFAULT_COPILOT_MODEL = 'claude-sonnet-4.5';

const CACHE_TTL_MS = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8000;

let _cache = null; // { models, fetchedAt }
let _inflight = null;

function _vendorFromId(id) {
  const s = String(id || '').toLowerCase();
  if (s.startsWith('claude')) return 'Anthropic';
  if (s.startsWith('gpt') || s.startsWith('o1') || s.startsWith('o3') || s.startsWith('chatgpt')) return 'OpenAI';
  if (s.startsWith('gemini')) return 'Google';
  return '';
}

function _normalizeAcpModel(m) {
  if (!m || !m.modelId) return null;
  // Skip "auto" sentinel — not a real model, just a router placeholder.
  if (m.modelId === 'auto') return null;
  const meta = m._meta || {};
  return {
    id: m.modelId,
    label: m.name || m.modelId,
    vendor: _vendorFromId(m.modelId),
    usage: meta.copilotUsage || '',              // "1x" / "0.33x" / "15x"
    priceCategory: meta.copilotPriceCategory || '', // "low" / "medium" / "high"
    enablement: meta.copilotEnablement || '',    // "enabled" / "disabled"
  };
}

/**
 * Prime the in-process cache from an ACP `session/new` response (preferred).
 * Called from copilot.js after a successful handshake.
 */
export function cacheCopilotModelsFromAcp(availableModels) {
  if (!Array.isArray(availableModels)) return;
  const models = availableModels.map(_normalizeAcpModel).filter(Boolean);
  if (!models.length) return;
  _cache = { models, fetchedAt: Date.now() };
}

/**
 * Spawn a short-lived `copilot --acp` child, do initialize + session/new,
 * pull `models.availableModels` out of the response, then close. Times out
 * after PROBE_TIMEOUT_MS. Resolves to an array (possibly empty) or rejects.
 */
function _probeAcpModels() {
  return new Promise((resolve, reject) => {
    let child;
    let client;
    let done = false;
    const finish = (err, models) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { client?.close(); } catch {}
      try { child?.kill('SIGTERM'); } catch {}
      if (err) reject(err); else resolve(models || []);
    };
    try {
      child = spawn('copilot', ['--acp'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { return reject(e); }
    const timer = setTimeout(() => finish(new Error('ACP probe timeout')), PROBE_TIMEOUT_MS);
    child.on('error', (e) => finish(e));
    child.on('exit', () => finish(new Error('ACP child exited')));
    child.stderr.on('data', () => { /* swallow */ });

    client = new AcpClient({
      stdin: child.stdin,
      stdout: child.stdout,
      onError: (e) => finish(e),
    });

    (async () => {
      try {
        await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
        const r = await client.request('session/new', { cwd: process.cwd(), mcpServers: [] });
        finish(null, r?.models?.availableModels || []);
      } catch (e) {
        finish(e);
      }
    })();
  });
}

/**
 * Returns picker-enabled chat models for the signed-in Copilot account.
 * Cache for 30 min. Never throws — falls back to the curated static list.
 */
export async function listCopilotModels({ force = false } = {}) {
  if (!force && _cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.models.slice();
  }
  if (_inflight) return (await _inflight).slice();
  _inflight = (async () => {
    try {
      const acpModels = await _probeAcpModels();
      const models = acpModels.map(_normalizeAcpModel).filter(Boolean);
      if (models.length) {
        _cache = { models, fetchedAt: Date.now() };
        return models;
      }
    } catch { /* fall through to static */ }
    return FALLBACK_COPILOT_MODELS.slice();
  })();
  try {
    return (await _inflight).slice();
  } finally {
    _inflight = null;
  }
}

/** Tests only. */
export function _resetCopilotModelsCacheForTests() { _cache = null; _inflight = null; }
/** Tests only. */
export function _normalizeAcpModelForTests(m) { return _normalizeAcpModel(m); }
