import { lstat, open, realpath, writeFile, readdir, stat, unlink, rename, mkdir, rm, copyFile, cp } from 'fs/promises';
import { constants, existsSync } from 'fs';
import { execFile } from 'node:child_process';
import { join, basename, dirname, extname, isAbsolute, relative, resolve } from 'path';
import { platform } from 'os';
import ctx from '../context.js';
import { resolveAndValidatePath, BINARY_EXTENSIONS, VIDEO_EXTENSIONS } from './utils.js';
import { hasCreationScope, resolveWorkItemPath, withCreationFiles } from './work-item-path.js';
import { sendWorkbenchResult } from './request-routing.js';

export const MAX_WORKBENCH_PREVIEW_BYTES = 100 * 1024 * 1024;
const MAX_RESPONSE_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024;
export const WORKBENCH_FILE_CHUNK_BYTES = 1024 * 1024;
export const WORKBENCH_VIDEO_CHUNK_BYTES = 1024 * 1024;

const hasBinaryControlBytes = buffer => buffer.some(byte => byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13);

// Unknown extensions may be binary. Never open lossy UTF-8 or control bytes in
// an editable buffer: saving that buffer could irreversibly corrupt the file.
export function isBinaryFileContent(buffer) {
  if (hasBinaryControlBytes(buffer)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

function assertPreviewSize(size, limitBytes) {
  if (size <= limitBytes) return;
  const error = new Error(`File is too large to transfer (${(size / 1024 / 1024).toFixed(1)} MB). The file limit is ${limitBytes / 1024 / 1024} MB.`);
  error.code = 'FILE_PREVIEW_TOO_LARGE';
  error.details = { sizeBytes: size, limitBytes };
  throw error;
}

async function canonicalWorkspaceReadPath(filePath, workDir, errorMessage = 'File is outside the active workspace.') {
  const canonicalRoot = await realpath(resolve(workDir));
  const canonicalFile = await realpath(resolveAndValidatePath(filePath, canonicalRoot));
  const relativePath = relative(canonicalRoot, canonicalFile);
  const outside = relativePath === '..'
    || relativePath.startsWith(`..${platform() === 'win32' ? '\\' : '/'}`)
    || isAbsolute(relativePath);
  if (outside) {
    const error = new Error(errorMessage);
    error.code = 'FILE_OUTSIDE_WORKSPACE';
    throw error;
  }
  return canonicalFile;
}

async function validateResponseImagePath(filePath, workDir) {
  const canonicalFile = await canonicalWorkspaceReadPath(
    filePath,
    workDir,
    'Response image is outside the active workspace.',
  );
  const mimeType = BINARY_EXTENSIONS[extname(canonicalFile).toLowerCase()];
  if (!mimeType?.startsWith('image/')) throw new Error('Response preview only supports image files.');
  return canonicalFile;
}

/**
 * Explicit Files actions operate on Agent-local paths, not just the Session cwd.
 * WorkItem routes remain confined to their Agent-resolved workspace; automatic
 * response image reads use the separate canonicalWorkspaceReadPath check above.
 */
async function canonicalWorkbenchReadPath(msg, filePath, workDir) {
  const resolved = await resolveWorkItemPath(msg, filePath, workDir);
  // Old preview capabilities predate explicit external reads. Preserve their
  // original workspace boundary on cache refills, without an image-only check.
  return msg.workspaceBoundPreview === true
    ? canonicalWorkspaceReadPath(resolved, workDir)
    : realpath(resolved);
}

async function withWorkbenchReadFile(msg, filePath, workDir, action, { video = false } = {}) {
  if (hasCreationScope(msg)) {
    return withCreationFiles(msg, files => {
      const resolved = files.target(filePath, { strictDescendant: true });
      return files.file(resolved, handle => action(resolved, handle));
    });
  }
  const resolved = !video && msg.responseImagePreview
    ? await validateResponseImagePath(filePath, workDir)
    : await canonicalWorkbenchReadPath(msg, filePath, workDir);
  if (video) videoMimeType(resolved);
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try { return await action(resolved, handle); }
  finally { await handle.close(); }
}

function videoMimeType(resolved) {
  const mimeType = VIDEO_EXTENSIONS[extname(resolved).toLowerCase()];
  if (!mimeType) throw new Error('Unsupported video format.');
  return mimeType;
}

export async function handleVideoMetadata(msg) {
  const { conversationId, filePath, requestId, _requestUserId, _requestClientId } = msg;
  try {
    const workDir = msg.workDir || ctx.conversations.get(conversationId)?.workDir || ctx.CONFIG.workDir;
    await withWorkbenchReadFile(msg, filePath, workDir, async (resolved, handle) => {
      const mimeType = videoMimeType(resolved);
      const fileStat = await handle.stat();
      if (!fileStat.isFile() || !Number.isSafeInteger(fileStat.size)) throw new Error('Video path is not a supported file.');
      await sendWorkbenchResult(ctx, msg, {
        type: 'video_metadata', conversationId, requestId, _requestUserId, _requestClientId,
        filePath: resolved, requestedFilePath: filePath, size: fileStat.size, mimeType,
        mtimeMs: fileStat.mtimeMs,
      });
    }, { video: true });
  } catch (error) {
    await sendWorkbenchResult(ctx, msg, {
      type: 'video_metadata', conversationId, requestId, _requestUserId, _requestClientId,
      filePath, requestedFilePath: filePath, error: error.message,
      errorCode: error.code || 'VIDEO_METADATA_FAILED',
    });
  }
}

export async function handleVideoChunk(msg) {
  const { conversationId, filePath, requestId, _requestUserId, _requestClientId } = msg;
  try {
    const workDir = msg.workDir || ctx.conversations.get(conversationId)?.workDir || ctx.CONFIG.workDir;
    await withWorkbenchReadFile(msg, filePath, workDir, async (resolved, handle) => {
      const mimeType = videoMimeType(resolved);
      const fileStat = await handle.stat();
      if (!fileStat.isFile() || !Number.isSafeInteger(fileStat.size)) throw new Error('Video path is not a supported file.');
      const start = Number(msg.start);
      const requestedEnd = Number(msg.end);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
          || start < 0 || requestedEnd < start || start >= fileStat.size) {
        const error = new Error('Invalid video byte range.');
        error.code = 'VIDEO_RANGE_INVALID';
        throw error;
      }
      if (Number(msg.expectedSize) !== fileStat.size || Number(msg.expectedMtimeMs) !== fileStat.mtimeMs) {
        const error = new Error('Video changed since the preview was opened.');
        error.code = 'VIDEO_FILE_CHANGED';
        throw error;
      }
      const end = Math.min(requestedEnd, fileStat.size - 1);
      if ((end - start + 1) > WORKBENCH_VIDEO_CHUNK_BYTES) {
        const error = new Error('Video byte range exceeds the chunk limit.');
        error.code = 'VIDEO_RANGE_TOO_LARGE';
        throw error;
      }
      const buffer = Buffer.alloc(end - start + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      if (bytesRead !== buffer.length) {
        const error = new Error('Video changed while it was being read.');
        error.code = 'VIDEO_FILE_CHANGED';
        throw error;
      }
      const outcome = await sendWorkbenchResult(ctx, msg, {
        type: 'video_chunk', conversationId, requestId, _requestUserId, _requestClientId,
        filePath: resolved, requestedFilePath: filePath, start, end, size: fileStat.size,
        mtimeMs: fileStat.mtimeMs, mimeType, content: buffer.toString('base64'),
      });
      if (outcome === 'dropped') console.warn('[Agent] Video chunk was dropped before delivery');
    }, { video: true });
  } catch (error) {
    await sendWorkbenchResult(ctx, msg, {
      type: 'video_chunk', conversationId, requestId, _requestUserId, _requestClientId,
      filePath, requestedFilePath: filePath, start: msg.start, end: msg.end,
      error: error.message, errorCode: error.code || 'VIDEO_CHUNK_FAILED',
    });
  }
}

async function reportFileTransferDropped(msg, base) {
  const errorResult = {
    ...base,
    type: 'file_content',
    content: '',
    binary: false,
    error: 'File transfer was dropped before it could be delivered.',
    errorCode: 'FILE_TRANSFER_DROPPED',
  };
  return sendWorkbenchResult(ctx, msg, errorResult);
}

async function sendBinaryFile(msg, base, buffer, mimeType) {
  const supportsChunks = ctx.serverCapabilities?.has?.('workbench_file_content_chunks')
    && ctx.agentCapabilities?.includes?.('workbench_file_content_chunks')
    && msg._workbenchRequestId;
  if (!supportsChunks || buffer.length <= WORKBENCH_FILE_CHUNK_BYTES) {
    const outcome = await sendWorkbenchResult(ctx, msg, {
      ...base,
      type: 'file_content',
      content: buffer.toString('base64'),
      binary: true,
      mimeType,
    });
    if (outcome === 'dropped') await reportFileTransferDropped(msg, base);
    return;
  }

  const chunkCount = Math.ceil(buffer.length / WORKBENCH_FILE_CHUNK_BYTES);
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * WORKBENCH_FILE_CHUNK_BYTES;
    const outcome = await sendWorkbenchResult(ctx, msg, {
      ...base,
      type: 'file_content_chunk',
      binary: true,
      mimeType,
      chunkIndex,
      chunkCount,
      totalBytes: buffer.length,
      content: buffer.subarray(start, start + WORKBENCH_FILE_CHUNK_BYTES).toString('base64'),
    });
    if (outcome === 'dropped') {
      await reportFileTransferDropped(msg, base);
      return;
    }
  }
}

export async function handleReadFile(msg) {
  const { conversationId, filePath, requestId, _requestUserId, _requestClientId } = msg;
  console.log('[Agent] handleReadFile received:', { filePath, conversationId, workDir: msg.workDir });
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    await withWorkbenchReadFile(msg, filePath, workDir, async (resolved, handle) => {
      const ext = extname(resolved).toLowerCase();
      if (msg.responseImagePreview && !BINARY_EXTENSIONS[ext]?.startsWith('image/')) {
        throw new Error('Response preview only supports image files.');
      }
      if (VIDEO_EXTENSIONS[ext]) {
        const error = new Error('Video files require the Workbench streaming protocol.');
        error.code = 'VIDEO_STREAM_REQUIRED';
        throw error;
      }
      // Automatic response images retain their smaller preview budget.
      const limitBytes = msg.responseImagePreview ? MAX_RESPONSE_IMAGE_PREVIEW_BYTES : MAX_WORKBENCH_PREVIEW_BYTES;
      // Downloads use byte-preserving chunks even for large UTF-8 text files.
      let mimeType = BINARY_EXTENSIONS[ext] || (msg.download === true ? 'application/octet-stream' : undefined);
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) throw new Error('Path is not a regular file.');
      if (mimeType) assertPreviewSize(fileStat.size, limitBytes);
      // Keep the existing text-file size behavior. Unknown binary files are
      // classified from a bounded prefix before allocating their full contents.
      if (!mimeType) {
        const sample = Buffer.alloc(Math.min(fileStat.size, 8192));
        const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
        // Do not mistake a UTF-8 character split at the sample boundary for
        // binary. Streaming decoding still rejects invalid bytes within it.
        const prefix = sample.subarray(0, bytesRead);
        let invalidUtf8 = false;
        try { new TextDecoder('utf-8', { fatal: true }).decode(prefix, { stream: bytesRead < fileStat.size }); }
        catch { invalidUtf8 = true; }
        if (invalidUtf8 || hasBinaryControlBytes(prefix)) {
          mimeType = 'application/octet-stream';
          assertPreviewSize(fileStat.size, limitBytes);
        }
      }
      const buffer = await handle.readFile();
      if (!mimeType && isBinaryFileContent(buffer)) mimeType = 'application/octet-stream';
      if (mimeType) {
        assertPreviewSize(buffer.length, limitBytes);
        console.log('[Agent] Sending binary file_content:', { filePath: resolved, size: buffer.length, mimeType, conversationId });
        await sendBinaryFile(msg, {
          conversationId,
          requestId,
          _requestUserId,
          _requestClientId,
          filePath: resolved,
          requestedFilePath: filePath,
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
        }, buffer, mimeType);
      } else {
        const content = buffer.toString('utf-8');

        // 检测语言
        const langMap = {
          '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
          '.ts': 'javascript', '.tsx': 'javascript', '.jsx': 'javascript',
          '.py': 'python', '.pyw': 'python',
          '.html': 'htmlmixed', '.htm': 'htmlmixed',
          '.css': 'css', '.scss': 'css', '.less': 'css',
          '.json': 'javascript',
          '.md': 'markdown',
          '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
          '.cs': 'text/x-csharp', '.java': 'text/x-java',
          '.cpp': 'text/x-c++src', '.c': 'text/x-csrc', '.h': 'text/x-csrc',
          '.xml': 'xml', '.svg': 'xml',
          '.yaml': 'yaml', '.yml': 'yaml',
          '.sql': 'sql',
          '.go': 'go', '.rs': 'rust', '.rb': 'ruby',
          '.php': 'php', '.swift': 'swift'
        };

        console.log('[Agent] Sending file_content:', { filePath: resolved, contentLen: content.length, conversationId });
        sendWorkbenchResult(ctx, msg, {
          type: 'file_content',
          conversationId,
          requestId,
          _requestUserId,
          _requestClientId,
          filePath: resolved,
          requestedFilePath: filePath,
          content,
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
          language: langMap[ext] || null
        });
      }
    });
  } catch (e) {
    sendWorkbenchResult(ctx, msg, {
      type: 'file_content',
      conversationId,
      requestId,
      _requestUserId,
      _requestClientId,
      filePath,
      requestedFilePath: filePath,
      content: '',
      error: e.message,
      errorCode: e.code || null,
      errorDetails: e.details || null
    });
  }
}

async function assertTextTarget(handle) {
  const binary = () => Object.assign(new Error('Cannot overwrite a binary file from text Canvas.'), { code: 'FILE_IS_BINARY' });
  const chunk = Buffer.alloc(64 * 1024);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let offset = 0; ;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
    if (!bytesRead) break;
    const slice = chunk.subarray(0, bytesRead);
    if (hasBinaryControlBytes(slice)) throw binary();
    try { decoder.decode(slice, { stream: true }); } catch { throw binary(); }
    offset += bytesRead;
  }
  try { decoder.decode(); } catch { throw binary(); }
}

export async function handleWriteFile(msg) {
  const { conversationId, filePath, content, requestId, _requestUserId, _requestClientId } = msg;
  const reply = { type: 'file_saved', conversationId, requestId, _requestUserId, _requestClientId, requestedFilePath: filePath };
  if (typeof content !== 'string') {
    return sendWorkbenchResult(ctx, msg, {
      ...reply, filePath, success: false, error: 'File content must be a string.', errorCode: 'INVALID_CONTENT',
    });
  }

  try {
    const encoded = Buffer.from(content, 'utf-8');
    const conv = ctx.conversations.get(conversationId);
    const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;
    let resolved, postStat;
    if (hasCreationScope(msg)) {
      [resolved, postStat] = await withCreationFiles(msg, async files => {
        const path = files.target(filePath, { strictDescendant: true });
        const result = await files.file(path, async (handle, verifyCurrent) => {
          const preStat = await handle.stat({ bigint: true });
          if ((msg.expectedSize != null && Number.isFinite(Number(msg.expectedSize)) && Number(preStat.size) !== Number(msg.expectedSize))
            || (msg.expectedMtimeMs != null && Number.isFinite(Number(msg.expectedMtimeMs)) && Math.abs(Number(preStat.mtimeNs) / 1e6 - Number(msg.expectedMtimeMs)) > 2)) {
            throw Object.assign(new Error('File changed on disk since it was loaded.'), { code: 'FILE_CONFLICT' });
          }
          if (msg.requireTextTarget === true && preStat.size > 0n) await assertTextTarget(handle);
          await verifyCurrent(preStat);
          const postScanStat = await handle.stat({ bigint: true });
          if (postScanStat.size !== preStat.size || postScanStat.mtimeNs !== preStat.mtimeNs || postScanStat.ctimeNs !== preStat.ctimeNs) {
            throw Object.assign(new Error('File changed on disk during save validation.'), { code: 'FILE_CONFLICT' });
          }
          await handle.truncate(0);
          for (let offset = 0; offset < encoded.length;) {
            const { bytesWritten } = await handle.write(encoded, offset, encoded.length - offset, offset);
            if (!bytesWritten) throw new Error('Could not finish writing the file.');
            offset += bytesWritten;
          }
          return handle.stat();
        }, { write: true, allowCreate: msg.expectedMtimeMs == null && msg.expectedSize == null });
        return [path, result];
      });
    } else {
      resolved = await resolveWorkItemPath(msg, filePath, workDir);
      await writeFile(resolved, encoded);
    }
    return sendWorkbenchResult(ctx, msg, {
      ...reply, filePath: resolved, success: true,
      ...(postStat && { mtimeMs: postStat.mtimeMs, size: postStat.size }),
    });
  } catch (e) {
    return sendWorkbenchResult(ctx, msg, {
      ...reply, filePath, success: false, error: e.message, errorCode: e.code || null,
    });
  }
}

let pendingWindowsDrives = null;

function listWindowsFixedDrives() {
  if (pendingWindowsDrives) return pendingWindowsDrives;
  // Drive types do not probe root accessibility or wait for disconnected mappings.
  const command = "$ErrorActionPreference = 'Stop'; [System.IO.DriveInfo]::GetDrives()"
    + ' | Where-Object { $_.DriveType -eq [System.IO.DriveType]::Fixed }'
    + ' | ForEach-Object { $_.Name }';
  pendingWindowsDrives = new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 16 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) reject(error);
      else if (stderr.trim()) reject(new Error(stderr.trim()));
      else resolve(stdout);
    });
  }).then(stdout => {
    const drives = stdout.trim() ? stdout.trim().split(/\r?\n/).map(line => line.trim()) : [];
    if (drives.some(drive => !/^[A-Za-z]:\\$/.test(drive))) {
      throw new Error('Invalid Windows drive listing');
    }
    return drives.sort().map(drive => ({ name: drive.slice(0, 2), type: 'directory', size: 0, isSymlink: false, mtimeMs: 0 }));
  }).finally(() => {
    pendingWindowsDrives = null;
  });
  return pendingWindowsDrives;
}

async function listDirectoryEntries(path, { creationScoped = false } = {}) {
  const entries = await readdir(path, { withFileTypes: true });
  const result = [];
  const skipDirs = new Set(['.git', 'node_modules', '__pycache__', '.next', '.nuxt', '.cache']);
  for (const entry of entries) {
    const isSymlink = entry.isSymbolicLink();
    if ((creationScoped && isSymlink) || (entry.isDirectory() && skipDirs.has(entry.name))) continue;
    const fullPath = join(path, entry.name);
    const s = await (creationScoped ? lstat(fullPath) : stat(fullPath)).catch(() => null);
    if (creationScoped && (!s || s.isSymbolicLink())) continue;
    result.push({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : 'file',
      size: s?.size ?? 0,
      isSymlink,
      mtimeMs: Number.isFinite(s?.mtimeMs) ? s.mtimeMs : 0,
    });
  }
  return result;
}

export async function handleListDirectory(msg) {
  const { conversationId, requestId, _requestUserId, _requestClientId } = msg;
  const dirPath = hasCreationScope(msg)
    ? msg.dirPath || '.'
    : msg.dirPath || (msg.workbenchRoute?.runtimeProvider === 'work-center' ? msg.workDir : msg.dirPath);
  const directoryPickerScope = msg.directoryPickerScope === 'agent' ? 'agent' : undefined;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  // 空路径：列出固定磁盘（Windows）或根目录（Unix）
  if (!dirPath || dirPath === '') {
    try {
      if (platform() === 'win32') {
        const drives = await listWindowsFixedDrives();
        sendWorkbenchResult(ctx, msg, {
          type: 'directory_listing',
          conversationId,
          ...(directoryPickerScope ? { directoryPickerScope } : {}),
          requestId,
          _requestUserId,
          _requestClientId,
          dirPath: '',
          entries: drives
        });
      } else {
        // Unix: 列出根目录
        const result = (await listDirectoryEntries('/')).sort((a, b) => a.name.localeCompare(b.name));
        sendWorkbenchResult(ctx, msg, {
          type: 'directory_listing',
          conversationId,
          ...(directoryPickerScope ? { directoryPickerScope } : {}),
          requestId,
          _requestUserId,
          _requestClientId,
          dirPath: '/',
          entries: result
        });
      }
    } catch (e) {
      sendWorkbenchResult(ctx, msg, {
        type: 'directory_listing',
        conversationId,
        ...(directoryPickerScope ? { directoryPickerScope } : {}),
        requestId,
        _requestUserId,
        _requestClientId,
        dirPath: '',
        entries: [],
        error: e.message
      });
    }
    return;
  }

  try {
    const [resolved, result] = hasCreationScope(msg) ? await withCreationFiles(msg, async files => {
      const path = files.target(dirPath);
      const entries = await files.list(path, anchor => listDirectoryEntries(anchor, { creationScoped: true }));
      return [path, entries];
    }) : await (async () => {
      const path = await resolveWorkItemPath(msg, dirPath, workDir);
      return [path, await listDirectoryEntries(path)];
    })();

    // 排序：目录在前，文件在后，各自按名称排序
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    sendWorkbenchResult(ctx, msg, {
      type: 'directory_listing',
      conversationId,
      ...(directoryPickerScope ? { directoryPickerScope } : {}),
      requestId,
      _requestUserId,
      _requestClientId,
      dirPath: resolved,
      entries: result
    });
  } catch (e) {
    sendWorkbenchResult(ctx, msg, {
      type: 'directory_listing',
      conversationId,
      ...(directoryPickerScope ? { directoryPickerScope } : {}),
      requestId,
      _requestUserId,
      _requestClientId,
      dirPath: dirPath || workDir,
      entries: [],
      error: e.message,
      errorCode: e.code || null,
    });
  }
}

export async function handleCreateFile(msg) {
  const { conversationId, filePath, isDirectory, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    const resolved = hasCreationScope(msg) ? await withCreationFiles(msg, async files => {
      const path = files.target(filePath, { strictDescendant: !isDirectory });
      if (isDirectory) await files.directory(path, () => {}, { create: true });
      else await files.file(path, () => {}, { write: true, exclusive: true, createParents: true });
      return path;
    }) : await resolveWorkItemPath(msg, filePath, workDir);
    if (!hasCreationScope(msg)) {
      if (isDirectory) {
        await mkdir(resolved, { recursive: true });
      } else {
        // Ensure parent directory exists
        const parentDir = dirname(resolved);
        await mkdir(parentDir, { recursive: true });
        // Create file only if it doesn't exist
        if (existsSync(resolved)) {
          throw new Error('File already exists: ' + resolved);
        }
        await writeFile(resolved, '', 'utf-8');
      }
    }
    sendWorkbenchResult(ctx, msg, {
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'create', success: true,
      message: (isDirectory ? 'Directory' : 'File') + ' created: ' + basename(resolved)
    });
  } catch (e) {
    sendWorkbenchResult(ctx, msg, {
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'create', success: false, error: e.message, errorCode: e.code || null
    });
  }
}

function withFileScope(msg, action) {
  return hasCreationScope(msg) ? withCreationFiles(msg, action) : action(null);
}

export async function handleDeleteFiles(msg) {
  const { conversationId, paths, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    if (!paths || paths.length === 0) throw new Error('No paths specified');
    const deleted = [];
    const errors = [];

    await withFileScope(msg, async files => {
      for (const p of paths) {
        try {
          const resolved = files ? files.target(p, { strictDescendant: true }) : await resolveWorkItemPath(msg, p, workDir);
          if (files) {
            await files.checkTree(resolved);
            await files.remove(resolved);
          } else if ((await stat(resolved)).isDirectory()) {
            await rm(resolved, { recursive: true, force: true });
          } else {
            await unlink(resolved);
          }
          deleted.push(basename(resolved));
        } catch (e) {
          errors.push(basename(p) + ': ' + e.message);
        }
      }
    });

    const message = deleted.length > 0
      ? 'Deleted: ' + deleted.join(', ') + (errors.length > 0 ? '; Errors: ' + errors.join(', ') : '')
      : 'Failed: ' + errors.join(', ');

    sendWorkbenchResult(ctx, msg, {
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'delete', success: deleted.length > 0,
      message, deletedCount: deleted.length, errorCount: errors.length
    });
  } catch (e) {
    sendWorkbenchResult(ctx, msg, {
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'delete', success: false, error: e.message
    });
  }
}

export async function handleMoveFiles(msg) {
  const { conversationId, paths, destination, newName, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    if (!paths || paths.length === 0) throw new Error('No paths specified');
    if (!destination) throw new Error('No destination specified');

    const moved = [];
    const errors = [];
    const destResolved = await withFileScope(msg, async files => {
      const destResolved = files ? files.target(destination) : await resolveWorkItemPath(msg, destination, workDir);
      // Ensure destination directory exists
      if (!files) await mkdir(destResolved, { recursive: true });

      for (const p of paths) {
        try {
          const srcResolved = files ? files.target(p, { strictDescendant: true }) : await resolveWorkItemPath(msg, p, workDir);
          const name = (newName && paths.length === 1) ? newName : basename(srcResolved);
          if (files) {
            const destPath = files.target(join(destResolved, name), { strictDescendant: true });
            // Only create the requested destination directory, not extra parents from newName.
            if (dirname(destPath) !== destResolved) throw new Error('Invalid destination filename.');
            await files.move(srcResolved, destPath, { createParents: true });
          } else {
            const destPath = await resolveWorkItemPath(msg, join(destResolved, name), workDir);
            if (existsSync(destPath)) throw new Error('Target already exists: ' + name);
            await rename(srcResolved, destPath);
          }
          moved.push(name);
        } catch (e) {
          errors.push(basename(p) + ': ' + e.message);
        }
      }
      return destResolved;
    });

    const message = moved.length > 0
      ? 'Moved: ' + moved.join(', ') + ' → ' + basename(destResolved) + (errors.length > 0 ? '; Errors: ' + errors.join(', ') : '')
      : 'Failed: ' + errors.join(', ');

    sendWorkbenchResult(ctx, msg, {
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'move', success: moved.length > 0,
      message, movedCount: moved.length, errorCount: errors.length
    });
  } catch (e) {
    sendWorkbenchResult(ctx, msg, {
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'move', success: false, error: e.message
    });
  }
}

export async function handleCopyFiles(msg) {
  const { conversationId, paths, destination, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    if (!paths || paths.length === 0) throw new Error('No paths specified');
    if (!destination) throw new Error('No destination specified');

    const copied = [];
    const errors = [];
    const destResolved = await withFileScope(msg, async files => {
      const destResolved = files ? files.target(destination) : await resolveWorkItemPath(msg, destination, workDir);
      if (!files) await mkdir(destResolved, { recursive: true });

      for (const p of paths) {
        try {
          const srcResolved = files ? files.target(p, { strictDescendant: true }) : await resolveWorkItemPath(msg, p, workDir);
          const name = basename(srcResolved);
          let destPath = join(destResolved, name);

          // If copying to same directory, generate a unique name
          if (destPath === srcResolved) {
            const ext = extname(name);
            const base = basename(name, ext);
            let counter = 1;
            do {
              destPath = join(destResolved, `${base} (copy${counter > 1 ? ' ' + counter : ''})${ext}`);
              counter++;
            } while (files ? await files.leaf(destPath, (_, info) => !!info) : existsSync(destPath));
          }

          if (files) {
            files.target(destPath, { strictDescendant: true });
            await files.directory(destResolved, () => {}, { create: true });
            await files.copy(srcResolved, destPath);
          } else {
            await resolveWorkItemPath(msg, destPath, workDir);
            const srcStat = await stat(srcResolved);
            if (srcStat.isDirectory()) {
              await cp(srcResolved, destPath, {
                recursive: true,
                ...(msg.workbenchRoute?.runtimeProvider === 'work-center' ? {
                  filter: async (source, target) => {
                    await resolveWorkItemPath(msg, source, workDir);
                    await resolveWorkItemPath(msg, target, workDir);
                    return true;
                  },
                } : {}),
              });
            } else {
              await copyFile(srcResolved, destPath);
            }
          }
          copied.push(basename(destPath));
        } catch (e) {
          errors.push(basename(p) + ': ' + e.message);
        }
      }
      return destResolved;
    });

    const message = copied.length > 0
      ? 'Copied: ' + copied.join(', ') + (errors.length > 0 ? '; Errors: ' + errors.join(', ') : '')
      : 'Failed: ' + errors.join(', ');

    sendWorkbenchResult(ctx, msg, {
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'copy', success: copied.length > 0,
      message, copiedCount: copied.length, errorCount: errors.length
    });
  } catch (e) {
    sendWorkbenchResult(ctx, msg, {
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'copy', success: false, error: e.message
    });
  }
}

export async function handleUploadToDir(msg) {
  const { conversationId, files, dirPath, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    if (!files || files.length === 0) throw new Error('No files specified');

    const saved = [];
    const errors = [];
    await withFileScope(msg, async scope => {
      const targetDir = scope ? scope.target(dirPath || '.') : await resolveWorkItemPath(msg, dirPath || workDir, workDir);
      if (scope) await scope.directory(targetDir, () => {}, { create: true });
      else await mkdir(targetDir, { recursive: true });

      for (const file of files) {
        try {
          const safeName = file.name;
          if (scope && (typeof safeName !== 'string' || !safeName || safeName === '.' || safeName === '..'
            || /[\\/:\0]/.test(safeName))) throw new Error('Invalid upload filename.');
          const buffer = Buffer.from(file.data, 'base64');
          if (scope) {
            const dest = scope.target(join(targetDir, safeName), { strictDescendant: true });
            await scope.file(dest, async handle => {
              await handle.truncate(0);
              await handle.writeFile(buffer);
            }, { write: true });
          } else {
            const dest = await resolveWorkItemPath(msg, join(targetDir, safeName), workDir);
            await writeFile(dest, buffer);
          }
          saved.push(file.name);
        } catch (e) {
          errors.push(file.name + ': ' + e.message);
        }
      }
    });

    const message = saved.length > 0
      ? 'Uploaded: ' + saved.join(', ') + (errors.length > 0 ? '; Errors: ' + errors.join(', ') : '')
      : 'Failed: ' + errors.join(', ');

    sendWorkbenchResult(ctx, msg, {
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'upload', success: saved.length > 0,
      message, uploadedCount: saved.length, errorCount: errors.length
    });
  } catch (e) {
    sendWorkbenchResult(ctx, msg, {
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'upload', success: false, error: e.message, errorCode: e.code || null
    });
  }
}
