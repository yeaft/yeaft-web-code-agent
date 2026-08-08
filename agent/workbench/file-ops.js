import { readFile, writeFile, readdir, stat, unlink, rename, mkdir, rm, copyFile, cp } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename, dirname, extname } from 'path';
import { platform } from 'os';
import ctx from '../context.js';
import { resolveAndValidatePath, BINARY_EXTENSIONS } from './utils.js';
import { sendWorkbenchResult } from './request-routing.js';

export async function handleReadFile(msg) {
  const { conversationId, filePath, requestId, _requestUserId, _requestClientId } = msg;
  console.log('[Agent] handleReadFile received:', { filePath, conversationId, workDir: msg.workDir });
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    const resolved = resolveAndValidatePath(filePath, workDir);
    const ext = extname(resolved).toLowerCase();
    const mimeType = BINARY_EXTENSIONS[ext];

    if (mimeType) {
      // Binary file: read as Buffer, send base64
      const buffer = await readFile(resolved);
      console.log('[Agent] Sending binary file_content:', { filePath: resolved, size: buffer.length, mimeType, conversationId });
      sendWorkbenchResult(ctx, msg, {
        type: 'file_content',
        conversationId,
        requestId,
        _requestUserId,
        _requestClientId,
        filePath: resolved,
        requestedFilePath: filePath,
        content: buffer.toString('base64'),
        binary: true,
        mimeType
      });
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
      error: e.message
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
