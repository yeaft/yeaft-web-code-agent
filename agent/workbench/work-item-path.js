import { constants, existsSync } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveCreationWorkspaceBinding } from '../yeaft/creations/bridge.js';

function outsideWorkspace(message) {
  return Object.assign(new Error(message), { code: 'FILE_OUTSIDE_WORKSPACE' });
}

function assertWithin(root, candidate, message = 'File is outside the WorkItem workspace.') {
  const path = relative(root, candidate);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw outsideWorkspace(message);
}

export const hasCreationScope = msg => msg.creationId !== undefined;

async function lookupCreationRoot(msg, lookupRoot = resolveCreationWorkspaceBinding) {
  const unavailable = 'Creation workspace is unavailable.';
  const creationId = typeof msg.creationId === 'string' && msg.creationId.trim();
  if (!creationId || typeof msg._requestUserId !== 'string' || !msg._requestUserId.trim()) {
    throw outsideWorkspace(unavailable);
  }
  try {
    const result = await lookupRoot(msg._requestUserId, creationId);
    const { rootDir, boundRootIdentity = null } = typeof result === 'string' ? { rootDir: result } : (result ?? {});
    // The Agent records canonical paths; do not accept a replaced ancestor.
    if (typeof rootDir !== 'string' || !isAbsolute(rootDir) || !(await lstat(rootDir)).isDirectory()
      || await realpath(rootDir) !== rootDir) throw outsideWorkspace(unavailable);
    return { rootDir, boundRootIdentity };
  } catch {
    throw outsideWorkspace(unavailable);
  }
}

function creationTarget(root, filePath, strictDescendant) {
  const candidate = resolve(root, filePath);
  assertWithin(root, candidate, 'File is outside the Creation workspace.');
  if (strictDescendant && candidate === root) throw outsideWorkspace('Operation cannot target the Creation workspace root.');
  return candidate;
}

async function resolveCreationPath(msg, filePath, { resolveCreationWorkspaceRoot: lookupRoot, strictDescendant }) {
  const { rootDir: canonicalRoot } = await lookupCreationRoot(msg, lookupRoot);
  const candidate = creationTarget(canonicalRoot, filePath, strictDescendant);
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
 * existing ancestor. Use withCreationFiles for descriptor-backed I/O.
 */
export async function resolveWorkItemPath(msg, filePath, workDir, deps = {}) {
  if (hasCreationScope(msg)) {
    return resolveCreationPath(msg, filePath, deps);
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

const inodeOptions = { bigint: true };
const sameInode = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
const changed = () => outsideWorkspace('Creation workspace path changed or contains a symbolic link.');

async function noLinkStat(path) {
  const info = await lstat(path, inodeOptions).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (info?.isSymbolicLink()) throw changed();
  return info;
}

// Node has no openat/renameat API. Linux procfs provides paths relative to
// *held* directory descriptors (not mutable, unchecked ancestor paths).
// Fail closed where this primitive or O_NOFOLLOW is unavailable.
function fdPath(handle) { return `/proc/self/fd/${handle.fd}`; }
function dirFlags() { return constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0); }

async function verifyNamed(path, handle, expected) {
  const info = await handle.stat(inodeOptions);
  if ((expected && !sameInode(expected, info)) || await realpath(fdPath(handle)) !== path
    || !sameInode(info, await noLinkStat(path))) throw changed();
  return info;
}

async function withDirectory(path, anchor, expected, action, verifyParent) {
  if (!expected?.isDirectory()) throw outsideWorkspace('Expected a Creation workspace directory.');
  const handle = await open(anchor, dirFlags());
  try {
    await verifyNamed(path, handle, expected);
    await verifyParent?.();
    return await action(handle);
  } finally { await handle.close(); }
}

class CreationFiles {
  constructor(root, handle) {
    this.root = root;
    this.handle = handle;
  }

  target(filePath, { strictDescendant = false } = {}) {
    return creationTarget(this.root, filePath, strictDescendant);
  }

  async directory(path, action, { create = false } = {}) {
    const parts = relative(this.root, this.target(path)).split(sep).filter(Boolean);
    const walk = async (index, canonical, handle) => {
      await verifyNamed(canonical, handle);
      if (index === parts.length) return action(handle);
      const anchor = join(fdPath(handle), parts[index]);
      const next = join(canonical, parts[index]);
      let info = await noLinkStat(anchor);
      let createdNow = false;
      const verifyParent = async () => {
        await verifyNamed(this.root, this.handle);
        if (handle !== this.handle) await verifyNamed(canonical, handle);
      };
      if (!info && create) {
        await verifyParent();
        try {
          await mkdir(anchor);
          createdNow = true;
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      let verified = false;
      try {
        if (!info) info = await noLinkStat(anchor);
        return await withDirectory(next, anchor, info, child => {
          verified = true;
          return walk(index + 1, next, child);
        }, verifyParent);
      } catch (error) {
        // Only undo this mkdir, not a pre-existing directory or a later operation.
        if (!createdNow || verified) throw error;
        await rmdir(anchor).catch(() => {});
        throw changed();
      }
    };
    return walk(0, this.root, this.handle);
  }

  async leaf(path, action, options) {
    this.target(path, { strictDescendant: true });
    const parent = dirname(path);
    return this.directory(parent, async handle => {
      const anchor = join(fdPath(handle), basename(path));
      const info = await noLinkStat(anchor);
      const verifyParent = async () => {
        await verifyNamed(this.root, this.handle);
        await verifyNamed(parent, handle);
      };
      await verifyParent();
      return action(anchor, info, verifyParent);
    }, options);
  }

  async file(path, action, { write = false, exclusive = false, createParents = false, allowCreate = true } = {}) {
    const missing = () => Object.assign(new Error('File no longer exists on disk.'), { code: 'FILE_CONFLICT' });
    return this.leaf(path, async (anchor, existing, verifyParent) => {
      if (!existing && !allowCreate) throw missing();
      if ((existing && !existing.isFile()) || (!existing && !write)) {
        throw outsideWorkspace('Expected a regular file in the Creation workspace.');
      }
      if (existing && exclusive) throw Object.assign(new Error('File already exists.'), { code: 'EEXIST' });
      const flags = (write ? (existing ? constants.O_RDWR : constants.O_WRONLY) : constants.O_RDONLY) | constants.O_NOFOLLOW
        | (constants.O_NONBLOCK ?? 0) | (existing ? 0 : constants.O_CREAT | constants.O_EXCL);
      const handle = await open(anchor, flags).catch(error => {
        if (!allowCreate && error.code === 'ENOENT') throw missing();
        throw error;
      });
      try {
        const info = await verifyNamed(path, handle, existing);
        if (!info.isFile()) throw changed();
        await verifyParent();
      } catch {
        const info = !existing && await handle.stat(inodeOptions).catch(() => null);
        await handle.close().catch(() => {});
        if (info && sameInode(info, await noLinkStat(anchor).catch(() => null))) await unlink(anchor).catch(() => {});
        throw changed();
      }
      const verifyCurrent = async expected => {
        try {
          await verifyParent();
          await verifyNamed(path, handle, expected);
          if (!sameInode(expected, await noLinkStat(anchor))) throw changed();
        } catch (error) {
          throw Object.assign(new Error('File changed on disk during save validation.', { cause: error }), { code: 'FILE_CONFLICT' });
        }
      };
      try { return await action(handle, verifyCurrent); }
      finally { await handle.close(); }
    }, { create: createParents });
  }

  async list(path, action) {
    return this.directory(path, async handle => {
      await verifyNamed(this.root, this.handle);
      return action(fdPath(handle));
    });
  }

  // Check trees before changing them, then use only pinned parents for each
  // actual operation. Do not hand a recursive path to rm or cp.
  async checkTree(path) {
    return this.leaf(path, async (anchor, info) => {
      if (info?.isDirectory()) {
        await withDirectory(path, anchor, info, async handle => {
          for (const name of await readdir(fdPath(handle))) await this.checkTree(join(path, name));
        });
      } else if (!info?.isFile()) throw outsideWorkspace('Expected a regular file or directory.');
    });
  }

  async remove(path) {
    return this.leaf(path, async (anchor, info, verifyParent) => {
      if (info?.isDirectory()) {
        await withDirectory(path, anchor, info, async handle => {
          for (const name of await readdir(fdPath(handle))) await this.remove(join(path, name));
        });
      } else if (!info?.isFile()) throw outsideWorkspace('Expected a regular file or directory.');
      await verifyParent();
      if (!sameInode(info, await noLinkStat(anchor))) throw changed();
      await (info.isDirectory() ? rmdir(anchor) : unlink(anchor));
    });
  }

  async move() {
    // Node does not expose an atomic no-replace rename on pinned directories.
    throw outsideWorkspace('Creation-scoped move requires atomic no-replace rename support.');
  }

  async copy(source, target) {
    const nested = relative(source, target);
    if (!nested || (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))) {
      throw outsideWorkspace('Cannot copy a directory into itself.');
    }
    await this.checkTree(source);
    await this.copyTree(source, target);
  }

  async copyTree(source, target) {
    return this.leaf(source, async (anchor, info) => {
      if (info?.isDirectory()) {
        await withDirectory(source, anchor, info, async handle => {
          await this.directory(target, () => {}, { create: true });
          for (const name of await readdir(fdPath(handle))) await this.copyTree(join(source, name), join(target, name));
        });
      } else {
        await this.file(source, input => this.file(target, async output => {
          // Equivalent to copyFile without reopening either pathname.
          if (sameInode(await input.stat(inodeOptions), await output.stat(inodeOptions))) {
            throw new Error('Source and destination refer to the same file.');
          }
          const chunk = Buffer.alloc(1024 * 1024);
          await output.truncate(0);
          for (;;) {
            const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
            if (!bytesRead) break;
            for (let offset = 0; offset < bytesRead;) {
              const { bytesWritten } = await output.write(chunk, offset, bytesRead - offset, null);
              if (!bytesWritten) throw new Error('Could not finish copying the file.');
              offset += bytesWritten;
            }
          }
        }, { write: true }));
      }
    });
  }
}

export function supportsCreationWorkbenchFiles() {
  return Boolean(constants.O_NOFOLLOW) && process.platform === 'linux' && existsSync('/proc/self/fd');
}

/** Run a scoped file operation, holding the canonical workspace root open. */
export async function withCreationFiles(msg, action) {
  if (!supportsCreationWorkbenchFiles()) {
    throw outsideWorkspace('Safe Creation workspace file access is not supported on this platform.');
  }
  const { rootDir, boundRootIdentity } = await lookupCreationRoot(msg);
  let handle;
  try {
    try {
      const expected = await noLinkStat(rootDir);
      if (!expected?.isDirectory()) throw changed();
      handle = await open(rootDir, dirFlags());
      const stat = await verifyNamed(rootDir, handle, expected);
      // A replacement may already have been in place when expected was read.
      if (boundRootIdentity != null && (String(stat.dev) !== boundRootIdentity.dev
        || String(stat.ino) !== boundRootIdentity.ino)) throw changed();
    } catch {
      throw changed();
    }
    return await action(new CreationFiles(rootDir, handle));
  } finally { await handle?.close(); }
}
