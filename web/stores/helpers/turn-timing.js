/**
 * turn-timing.js — pure helpers for VP turn timing UI.
 *
 * Pure: no Vue / Pinia dependency, no Date.now(), no DOM.
 */
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  const ss = String(seconds).padStart(2, '0');
  if (minutes < 60) return `${minutes}:${ss}`;
  const hours = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${hours}:${String(mm).padStart(2, '0')}:${ss}`;
}
