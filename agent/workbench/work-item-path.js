import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function assertWithin(root, candidate) {
  const path = relative(root, candidate);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    const error = new Error('File is outside the WorkItem workspace.');
    error.code = 'FILE_OUTSIDE_WORKSPACE';
    throw error;
  }
}

/**
 * Resolve a WorkItem file operation without following a symlink outside its
 * Agent-resolved workspace. New destinations validate the nearest existing
 * ancestor; dangling symlinks fail closed. Other Workbench routes keep their
 * existing path-picker behavior. This is not a concurrent filesystem sandbox.
 */
export async function resolveWorkItemPath(msg, filePath, workDir) {
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
