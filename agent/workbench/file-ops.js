import { open, readFile, realpath, writeFile, readdir, stat, unlink, rename, mkdir, rm, copyFile, cp } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename, dirname, extname, isAbsolute, relative, resolve } from 'path';
import { platform } from 'os';
import ctx from '../context.js';
import { resolveAndValidatePath, BINARY_EXTENSIONS, VIDEO_EXTENSIONS } from './utils.js';
import { sendWorkbenchResult } from './request-routing.js';

export const MAX_WORKBENCH_PREVIEW_BYTES = 20 * 1024 * 1024;
export const WORKBENCH_FILE_CHUNK_BYTES = 1024 * 1024;
export const WORKBENCH_VIDEO_CHUNK_BYTES = 1024 * 1024;

async function validateResponseImagePath(filePath, workDir) {
  const canonicalRoot = await realpath(resolve(workDir));
  const canonicalFile = await realpath(resolveAndValidatePath(filePath, canonicalRoot));
  const relativePath = relative(canonicalRoot, canonicalFile);
  const outside = relativePath === '..'
    || relativePath.startsWith(`..${platform() === 'win32' ? '\\' : '/'}`)
    || isAbsolute(relativePath);
  if (outside) throw new Error('Response image is outside the active workspace.');
  const mimeType = BINARY_EXTENSIONS[extname(canonicalFile).toLowerCase()];
  if (!mimeType?.startsWith('image/')) throw new Error('Response preview only supports image files.');
  return canonicalFile;
}

async function canonicalVideoFile(filePath, workDir) {
  const canonicalRoot = await realpath(resolve(workDir));
  const resolved = await realpath(resolveAndValidatePath(filePath, canonicalRoot));
  const relativePath = relative(canonicalRoot, resolved);
  const outside = relativePath === '..'
    || relativePath.startsWith(`..${platform() === 'win32' ? '\\' : '/'}`)
    || isAbsolute(relativePath);
  if (outside) throw new Error('Video is outside the active workspace.');
  const mimeType = VIDEO_EXTENSIONS[extname(resolved).toLowerCase()];
  if (!mimeType) throw new Error('Unsupported video format.');
  return { resolved, mimeType };
}

export async function handleVideoMetadata(msg) {
  const { conversationId, filePath, requestId, _requestUserId, _requestClientId } = msg;
  try {
    const { resolved, mimeType } = await canonicalVideoFile(filePath, msg.workDir || ctx.CONFIG.workDir);
    const handle = await open(resolved, 'r');
    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile() || !Number.isSafeInteger(fileStat.size)) throw new Error('Video path is not a supported file.');
      await sendWorkbenchResult(ctx, msg, {
        type: 'video_metadata', conversationId, requestId, _requestUserId, _requestClientId,
        filePath: resolved, requestedFilePath: filePath, size: fileStat.size, mimeType,
        mtimeMs: fileStat.mtimeMs,
      });
    } finally {
      await handle.close();
    }
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
  let handle;
  try {
    const { resolved, mimeType } = await canonicalVideoFile(filePath, msg.workDir || ctx.CONFIG.workDir);
    handle = await open(resolved, 'r');
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
  } catch (error) {
    await sendWorkbenchResult(ctx, msg, {
      type: 'video_chunk', conversationId, requestId, _requestUserId, _requestClientId,
      filePath, requestedFilePath: filePath, start: msg.start, end: msg.end,
      error: error.message, errorCode: error.code || 'VIDEO_CHUNK_FAILED',
    });
  } finally {
    await handle?.close();
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
    const resolved = msg.responseImagePreview
      ? await validateResponseImagePath(filePath, workDir)
      : resolveAndValidatePath(filePath, workDir);
    const ext = extname(resolved).toLowerCase();
    if (VIDEO_EXTENSIONS[ext]) {
      const error = new Error('Video files require the Workbench streaming protocol.');
      error.code = 'VIDEO_STREAM_REQUIRED';
      throw error;
    }
    const mimeType = BINARY_EXTENSIONS[ext];

    if (mimeType) {
      const fileStat = await stat(resolved);
      if (fileStat.size > MAX_WORKBENCH_PREVIEW_BYTES) {
        const error = new Error(`File is too large to transfer (${(fileStat.size / 1024 / 1024).toFixed(1)} MB). The file limit is 20 MB.`);
        error.code = 'FILE_PREVIEW_TOO_LARGE';
        error.details = {
          sizeBytes: fileStat.size,
          limitBytes: MAX_WORKBENCH_PREVIEW_BYTES,
        };
        throw error;
      }
      const buffer = await readFile(resolved);
      console.log('[Agent] Sending binary file_content:', { filePath: resolved, size: buffer.length, mimeType, conversationId });
      await sendBinaryFile(msg, {
        conversationId,
        requestId,
        _requestUserId,
        _requestClientId,
        filePath: resolved,
        requestedFilePath: filePath,
      }, buffer, mimeType);
    } else {
      // Text file: read as utf-8
      const content = await readFile(resolved, 'utf-8');

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
        language: langMap[ext] || null
      });
    }
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

export async function handleWriteFile(msg) {
  const { conversationId, filePath, content, requestId, _requestUserId, _requestClientId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    const resolved = resolveAndValidatePath(filePath, workDir);
    await writeFile(resolved, content, 'utf-8');

    sendWorkbenchResult(ctx, msg, {
      type: 'file_saved',
      conversationId,
      requestId,
      _requestUserId,
      _requestClientId,
      filePath: resolved,
      requestedFilePath: filePath,
      success: true
    });
  } catch (e) {
    sendWorkbenchResult(ctx, msg, {
      type: 'file_saved',
      conversationId,
      requestId,
      _requestUserId,
      _requestClientId,
      filePath,
      requestedFilePath: filePath,
      success: false,
      error: e.message
    });
  }
}

export async function handleListDirectory(msg) {
  const { conversationId, requestId, dirPath, _requestUserId, _requestClientId } = msg;
  const directoryPickerScope = msg.directoryPickerScope === 'agent' ? 'agent' : undefined;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  // 空路径：列出驱动器（Windows）或根目录（Unix）
  if (!dirPath || dirPath === '') {
    try {
      if (platform() === 'win32') {
        const drives = [];
        for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) {
          const drivePath = letter + ':\\';
          if (existsSync(drivePath)) {
            drives.push({ name: letter + ':', type: 'directory', size: 0 });
          }
        }
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
        const entries = await readdir('/', { withFileTypes: true });
        const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.next', '.nuxt', '.cache']);
        const result = entries
          .filter(e => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
          .map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', size: 0 }))
          .sort((a, b) => a.name.localeCompare(b.name));
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
    const resolved = resolveAndValidatePath(dirPath, workDir);
    const entries = await readdir(resolved, { withFileTypes: true });
    const result = [];

    const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.next', '.nuxt', '.cache']);

    for (const entry of entries) {
      // 跳过大型/内部目录（.git, node_modules 等），但显示 dotfiles（.env, .gitignore 等）
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

      try {
        const fullPath = join(resolved, entry.name);
        const s = await stat(fullPath);
        result.push({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: s.size
        });
      } catch {
        result.push({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: 0
        });
      }
    }

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
      error: e.message
    });
  }
}

export async function handleCreateFile(msg) {
  const { conversationId, filePath, isDirectory, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    const resolved = resolveAndValidatePath(filePath, workDir);
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
    sendWorkbenchResult(ctx, msg, {
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'create', success: true,
      message: (isDirectory ? 'Directory' : 'File') + ' created: ' + basename(resolved)
    });
  } catch (e) {
    sendWorkbenchResult(ctx, msg, {
      type: 'file_op_result', conversationId, _requestUserId,
      operation: 'create', success: false, error: e.message
    });
  }
}

export async function handleDeleteFiles(msg) {
  const { conversationId, paths, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    if (!paths || paths.length === 0) throw new Error('No paths specified');
    const deleted = [];
    const errors = [];

    for (const p of paths) {
      try {
        const resolved = resolveAndValidatePath(p, workDir);
        const s = await stat(resolved);
        if (s.isDirectory()) {
          await rm(resolved, { recursive: true, force: true });
        } else {
          await unlink(resolved);
        }
        deleted.push(basename(resolved));
      } catch (e) {
        errors.push(basename(p) + ': ' + e.message);
      }
    }

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

    const destResolved = resolveAndValidatePath(destination, workDir);
    // Ensure destination directory exists
    await mkdir(destResolved, { recursive: true });

    const moved = [];
    const errors = [];

    for (const p of paths) {
      try {
        const srcResolved = resolveAndValidatePath(p, workDir);
        const name = (newName && paths.length === 1) ? newName : basename(srcResolved);
        const destPath = join(destResolved, name);
        if (existsSync(destPath)) {
          throw new Error('Target already exists: ' + name);
        }
        await rename(srcResolved, destPath);
        moved.push(name);
      } catch (e) {
        errors.push(basename(p) + ': ' + e.message);
      }
    }

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

    const destResolved = resolveAndValidatePath(destination, workDir);
    await mkdir(destResolved, { recursive: true });

    const copied = [];
    const errors = [];

    for (const p of paths) {
      try {
        const srcResolved = resolveAndValidatePath(p, workDir);
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
          } while (existsSync(destPath));
        }

        const srcStat = await stat(srcResolved);
        if (srcStat.isDirectory()) {
          await cp(srcResolved, destPath, { recursive: true });
        } else {
          await copyFile(srcResolved, destPath);
        }
        copied.push(basename(destPath));
      } catch (e) {
        errors.push(basename(p) + ': ' + e.message);
      }
    }

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

    const targetDir = resolveAndValidatePath(dirPath || workDir, workDir);
    await mkdir(targetDir, { recursive: true });

    const saved = [];
    const errors = [];

    for (const file of files) {
      try {
        const dest = join(targetDir, file.name);
        const buffer = Buffer.from(file.data, 'base64');
        await writeFile(dest, buffer);
        saved.push(file.name);
      } catch (e) {
        errors.push(file.name + ': ' + e.message);
      }
    }

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
      operation: 'upload', success: false, error: e.message
    });
  }
}
