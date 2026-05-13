/**
 * format.js — human-readable formatters for tool-usage stats.
 *
 * Single source of truth shared by the agent-side CLI (`bin/yeaft-stats.js`)
 * and the REPL `/stats` command. The frontend `UnifyToolStatsDrawer.js`
 * copies the same logic verbatim because the no-build-step web layer can't
 * import from `agent/`; keep the two definitions byte-identical when
 * tweaking either side.
 */

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatPct(rate) {
  if (!Number.isFinite(rate) || rate === 0) return '0%';
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatLastCalled(iso, now = Date.now()) {
  if (typeof iso !== 'string' || !iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const ageMs = now - t;
  if (ageMs < 60_000) return 'just now';
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
}
