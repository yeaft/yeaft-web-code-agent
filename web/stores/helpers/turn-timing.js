/**
 * turn-timing.js — pure helpers for VP turn timing UI.
 *
 * Pure: no Vue / Pinia dependency, no Date.now(), no DOM.
 */

/**
 * Format a duration for the turn header.
 *
 * Units are always spelled out (`5m10s`) instead of a bare colon clock
 * (`5:10`), because the value sits inline after an absolute start time and
 * readers otherwise parse it as a second timestamp. Seconds are the smallest
 * unit; the counter never degrades to a raw second total (`310s`).
 */
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const seconds = totalSec % 60;
  const minutes = Math.floor(totalSec / 60) % 60;
  const hours = Math.floor(totalSec / 3600);
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (totalSec >= 60) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}
