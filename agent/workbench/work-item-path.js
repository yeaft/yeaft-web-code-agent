import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveCreationWorkspaceRoot } from '../yeaft/creations/bridge.js';

function outsideWorkspace(message) {
  return Object.assign(new Error(message), { code: 'FILE_OUTSIDE_WORKSPACE' });
}

function assertWithin(root, candidate, message = 'File is outside the WorkItem workspace.') {
  const path = relative(root, candidate);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw outsideWorkspace(message);
}

async function resolveCreationPath(msg, filePath, lookupRoot) {
  const unavailable = 'Creation workspace is unavailable.';
  const creationId = typeof msg.creationId === 'string' && msg.creationId.trim();
  if (!creationId || typeof msg._requestUserId !== 'string' || !msg._requestUserId.trim()) {
    throw outsideWorkspace(unavailable);
  }
  let canonicalRoot;
  try {
    const root = await lookupRoot(msg._requestUserId, creationId);
    if (typeof root !== 'string' || !isAbsolute(root) || !(await lstat(root)).isDirectory()) {
      throw outsideWorkspace(unavailable);
    }
    canonicalRoot = await realpath(root);
    // The Agent records canonical paths; do not accept a replaced ancestor.
    if (canonicalRoot !== root) throw outsideWorkspace(unavailable);
  } catch {
    throw outsideWorkspace(unavailable);
  }

  const candidate = resolve(canonicalRoot, filePath);
  const outside = 'File is outside the Creation workspace.';
  assertWithin(canonicalRoot, candidate, outside);
  let ancestor = canonicalRoot;
  for (const part of relative(canonicalRoot, candidate).split(sep).filter(Boolean)) {
    const path = join(ancestor, part);
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        throw outsideWorkspace('Symlinks are not allowed inside a Creation workspace.');
      }
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    ancestor = path;
  }
  assertWithin(canonicalRoot, await realpath(ancestor), outside);
  return candidate;
}

/**
 * Confine Creation and WorkItem file operations to the Agent-resolved root.
 * Creations disallow all symlinks; new destinations validate the nearest
 * existing ancestor. This is not a concurrent filesystem sandbox.
 */
export async function resolveWorkItemPath(msg, filePath, workDir, deps = {}) {
  if (msg.creationId !== undefined) {
    return resolveCreationPath(msg, filePath, deps.resolveCreationWorkspaceRoot || resolveCreationWorkspaceRoot);
  }
  const candidate = resolve(workDir, filePath);
  if (msg.workbenchRoute?.runtimeProvider !== 'work-center') return candidate;
  if (!isAbsolute(workDir)) throw new Error('WorkItem workspace must be absolute.');
  const root = await realpath(workDir);
  // Check both lexical and canonical ownership. Return the original path so a
  // delete/rename still operates on a symlink itself, not on its target.
  assertWithin(resolve(workDir), candidate);
  let ancestor = candidate;
  for (;;) {
    try {
      await lstat(ancestor);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
      continue;
    }
    assertWithin(root, await realpath(ancestor));
    return candidate;
  }
}
