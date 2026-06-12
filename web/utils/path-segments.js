/**
 * path-segments.js — small shared helpers for path display in modals.
 *
 * Extracted so ChatPage's new-conversation modal and Yeaft's
 * SessionCreateModal render the same shape for the same data — keeps
 * the two creation surfaces visually identical and avoids the helper
 * duplication that caused them to drift (PR #901).
 */

export function getLastPathSegment(path) {
  if (!path) return '';
  const parts = String(path).split(/[/\\]/);
  return parts[parts.length - 1] || parts[parts.length - 2] || path;
}

/**
 * Format a timestamp the way ChatPage's resume list does so the two
 * modals stay visually identical. Requires `t` (a `$t`-style translator)
 * so the strings stay i18n'd.
 */
export function formatResumeDate(timestamp, t) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
  const tx = typeof t === 'function' ? t : ((k, p) => p && p.count != null ? `${p.count}d` : k);
  if (diffDays === 0) {
    return tx('chat.time.today') + ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } else if (diffDays === 1) {
    return tx('chat.time.yesterday') + ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } else if (diffDays < 7) {
    return tx('chat.time.daysAgo', { count: diffDays });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
