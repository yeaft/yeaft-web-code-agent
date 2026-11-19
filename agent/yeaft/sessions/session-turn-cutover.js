import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const SESSION_TURN_CUTOVER_ARG = '--session-turn-deletion-cutover';

/**
 * Capture deployment authorization from process arguments, not from files or
 * env loaded from the working directory. Workbench can edit both the data
 * directory and .env; neither is a trustworthy input for enabling deletion.
 */
export function sessionTurnDeletionCutoverRoots(args) {
  const roots = [];
  // Match the Agent launcher: consume ordinary value arguments so a value
  // resembling the cutover flag cannot accidentally grant authorization.
  const valueArgs = new Set(['--instance', '--server', '--name', '--secret', '--work-dir', '--yeaft-dir']);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') break;
    if (valueArgs.has(args[i])) { i++; continue; }
    if (args[i] !== SESSION_TURN_CUTOVER_ARG) continue;
    const root = args[++i];
    if (typeof root !== 'string' || !isAbsolute(root)) throw new Error(`${SESSION_TURN_CUTOVER_ARG} requires an absolute data directory`);
    roots.push(realpathSync(root));
  }
  return Object.freeze([...new Set(roots)]);
}

export function isSessionTurnDeletionCutoverConfirmed(ownerRoot, approvedRoots) {
  if (!ownerRoot || !Array.isArray(approvedRoots) || approvedRoots.length === 0) return false;
  try { return approvedRoots.includes(realpathSync(ownerRoot)); }
  catch { return false; }
}
