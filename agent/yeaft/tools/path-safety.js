/**
 * path-safety.js — Cross-platform path containment helpers for tools.
 */

import path from 'path';

/**
 * Return true when child is equal to or inside parent for the supplied path
 * implementation (`path` on the host, or `path.win32`/`path.posix` in tests).
 *
 * @param {string} parent
 * @param {string} child
 * @param {{ relative: Function, isAbsolute: Function, resolve: Function }} [pathImpl]
 */
export function isPathInsideOrEqual(parent, child, pathImpl = path) {
  if (!parent || !child) return false;
  const base = pathImpl.resolve(parent);
  const target = pathImpl.resolve(child);
  const rel = pathImpl.relative(base, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !pathImpl.isAbsolute(rel));
}

/**
 * @param {string} absPath
 * @param {string} cwd
 * @param {string[]} [allowlist]
 * @param {{ relative: Function, isAbsolute: Function, resolve: Function }} [pathImpl]
 */
export function checkPathAllowed(absPath, cwd, allowlist = [], pathImpl = path) {
  if (isPathInsideOrEqual(cwd, absPath, pathImpl)) return null;

  if (Array.isArray(allowlist)) {
    for (const dir of allowlist) {
      if (typeof dir !== 'string' || !pathImpl.isAbsolute(dir)) continue;
      if (isPathInsideOrEqual(dir, absPath, pathImpl)) return null;
    }
  }

  const inputWasAbs = pathImpl.isAbsolute(absPath);
  return inputWasAbs
    ? {
        kind: 'absolute_outside_allowlist',
        message: 'Absolute image paths must be inside the project directory or a ctx.imageAllowlist directory.',
      }
    : {
        kind: 'relative_escape',
        message: 'Relative image paths may not escape the working directory.',
      };
}
