/**
 * path-display — shared helpers for compactly rendering filesystem paths
 * in sidebar rows. Both ChatPage and YeaftSidebar feed user workDirs
 * through the same truncator so the two sidebars stay visually aligned.
 */

/**
 * Truncate a path to roughly fit a sidebar row.
 * - Empty / nullish input → '-'
 * - Short paths (≤ 25 chars) pass through unchanged
 * - Long paths collapse to '...<last-two-segments>'
 *   (split on both forward and back slashes for Windows compatibility)
 */
export function shortenPath(path) {
  if (!path) return '-';
  const s = String(path);
  if (s.length <= 25) return s;
  const parts = s.split(/[/\\]/);
  if (parts.length <= 2) return s;
  return '...' + parts.slice(-2).join('/');
}
