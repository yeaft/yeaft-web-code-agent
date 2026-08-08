import { readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import ctx from '../context.js';
import { execAsync, resolveAndValidatePath, getGitRoot, validateGitPath } from './utils.js';
import { sendWorkbenchResult } from './request-routing.js';

export async function handleGitStatus(msg) {
  const { conversationId, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    // Get git repo root to ensure paths are consistent
    let gitRoot = workDir;
    try {
      const { stdout: rootOut } = await execAsync('git rev-parse --show-toplevel', {
        cwd: workDir,
        timeout: 5000,
        windowsHide: true
      });
      gitRoot = rootOut.trim();
    } catch {}

    const { stdout: statusOut } = await execAsync('git status --porcelain', {
      cwd: gitRoot,
      timeout: 10000,
      windowsHide: true
    });

    let branch = '';
    try {
      const { stdout: branchOut } = await execAsync('git branch --show-current', {
        cwd: gitRoot,
        timeout: 5000,
        windowsHide: true
      });
      branch = branchOut.trim();
    } catch {}

    // Get ahead/behind counts relative to upstream
    let ahead = 0, behind = 0;
    try {
      const { stdout: abOut } = await execAsync('git rev-list --left-right --count HEAD...@{upstream}', {
        cwd: gitRoot, timeout: 5000, windowsHide: true
      });
      const parts = abOut.trim().split(/\s+/);
      ahead = parseInt(parts[0]) || 0;
      behind = parseInt(parts[1]) || 0;
    } catch {}

    const files = [];
    for (const line of statusOut.split('\n')) {
      if (!line || line.length < 4) continue;
      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const path = line.slice(3);
      // Handle renamed files: "R  old -> new"
      const displayPath = path.includes(' -> ') ? path.split(' -> ')[1] : path;
      files.push({ path: displayPath, indexStatus, workTreeStatus });
    }

    sendWorkbenchResult(ctx, msg, {
      type: 'git_status_result',
      conversationId,
      _requestUserId,
      branch,
      files,
      ahead,
      behind,
      workDir,
      gitRoot
    });
  } catch (e) {
    sendWorkbenchResult(ctx, msg, {
      type: 'git_status_result',
      conversationId,
      _requestUserId,
      error: e.message,
      isGitRepo: !e.message.includes('not a git repository') && !e.message.includes('ENOENT')
    });
  }
}

export async function handleGitDiff(msg) {
  const { conversationId, filePath, staged, untracked, fullFile, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    // 安全检查：验证 filePath 不包含 shell 注入字符
    if (!filePath || /[`$;|&><!\n\r]/.test(filePath)) {
      sendWorkbenchResult(ctx, msg, {
        type: 'git_diff_result',
        conversationId,
        _requestUserId,
        filePath,
        error: 'Invalid file path'
      });
      return;
    }

    // Get git repo root — git status paths are relative to this, not workDir
    let gitRoot = workDir;
    try {
      const { stdout: rootOut } = await execAsync('git rev-parse --show-toplevel', {
        cwd: workDir,
        timeout: 5000,
        windowsHide: true
      });
      gitRoot = rootOut.trim();
    } catch {}

    if (untracked) {
      // Untracked files: resolve path relative to git root
      const fullPath = resolve(gitRoot, filePath);
      const resolved = resolveAndValidatePath(fullPath, gitRoot);
      const content = await readFile(resolved, 'utf-8');
      sendWorkbenchResult(ctx, msg, {
        type: 'git_diff_result',
        conversationId,
        _requestUserId,
        filePath,
        diff: null,
        newFileContent: content
      });
      return;
    }

    // 使用 -- 分隔选项和路径, execAsync 的参数已被验证无注入字符
    const contextFlag = fullFile ? '-U99999' : '';
    const cmd = staged
      ? `git diff --cached ${contextFlag} -- "${filePath}"`
      : `git diff ${contextFlag} -- "${filePath}"`;

    const { stdout } = await execAsync(cmd, {
      cwd: gitRoot,
      timeout: 15000,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true
    });

    // 如果 git diff 返回空，尝试用 --cached 或反之
    if (!stdout.trim() && !staged) {
      const cachedCmd = `git diff --cached ${contextFlag} -- "${filePath}"`;
      const { stdout: cachedOut } = await execAsync(cachedCmd, {
        cwd: gitRoot,
        timeout: 15000,
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true
      });
      if (cachedOut.trim()) {
        sendWorkbenchResult(ctx, msg, {
          type: 'git_diff_result',
          conversationId,
          _requestUserId,
          filePath,
          staged: true,
          diff: cachedOut
        });
        return;
      }
    } else if (!stdout.trim() && staged) {
      const wtCmd = `git diff ${contextFlag} -- "${filePath}"`;
      const { stdout: wtOut } = await execAsync(wtCmd, {
        cwd: gitRoot,
        timeout: 15000,
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true
      });
      if (wtOut.trim()) {
        sendWorkbenchResult(ctx, msg, {
          type: 'git_diff_result',
          conversationId,
          _requestUserId,
          filePath,
          staged: false,
          diff: wtOut
        });
        return;
      }
    }

    sendWorkbenchResult(ctx, msg, {
      type: 'git_diff_result',
      conversationId,
      _requestUserId,
      filePath,
      staged: !!staged,
      diff: stdout
    });
  } catch (e) {
    sendWorkbenchResult(ctx, msg, {
      type: 'git_diff_result',
      conversationId,
      _requestUserId,
      filePath,
      error: e.message
    });
  }
}

export async function handleGitAdd(msg) {
  const { conversationId, filePath, addAll, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    const gitRoot = await getGitRoot(workDir);

    if (addAll) {
      await execAsync('git add -A', { cwd: gitRoot, timeout: 10000, windowsHide: true });
    } else {
      if (!validateGitPath(filePath)) {
        sendWorkbenchResult(ctx, msg, { type: 'git_op_result', conversationId, _requestUserId, operation: 'add', success: false, error: 'Invalid file path' });
        return;
      }
      await execAsync(`git add -- "${filePath}"`, { cwd: gitRoot, timeout: 10000, windowsHide: true });
    }

    sendWorkbenchResult(ctx, msg, { type: 'git_op_result', conversationId, _requestUserId, operation: 'add', success: true, message: addAll ? 'All files staged' : `Staged: ${filePath}` });
  } catch (e) {
    sendWorkbenchResult(ctx, msg, { type: 'git_op_result', conversationId, _requestUserId, operation: 'add', success: false, error: e.message });
  }
}

export async function handleGitReset(msg) {
  const { conversationId, filePath, resetAll, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    const gitRoot = await getGitRoot(workDir);

    if (resetAll) {
      await execAsync('git reset HEAD', { cwd: gitRoot, timeout: 10000, windowsHide: true });
    } else {
      if (!validateGitPath(filePath)) {
        sendWorkbenchResult(ctx, msg, { type: 'git_op_result', conversationId, _requestUserId, operation: 'reset', success: false, error: 'Invalid file path' });
        return;
      }
      await execAsync(`git reset HEAD -- "${filePath}"`, { cwd: gitRoot, timeout: 10000, windowsHide: true });
    }

    sendWorkbenchResult(ctx, msg, { type: 'git_op_result', conversationId, _requestUserId, operation: 'reset', success: true, message: resetAll ? 'All files unstaged' : `Unstaged: ${filePath}` });
  } catch (e) {
    sendWorkbenchResult(ctx, msg, { type: 'git_op_result', conversationId, _requestUserId, operation: 'reset', success: false, error: e.message });
  }
}

export async function handleGitRestore(msg) {
  const { conversationId, filePath, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    if (!validateGitPath(filePath)) {
      sendWorkbenchResult(ctx, msg, { type: 'git_op_result', conversationId, _requestUserId, operation: 'restore', success: false, error: 'Invalid file path' });
      return;
    }

    const gitRoot = await getGitRoot(workDir);
    await execAsync(`git restore -- "${filePath}"`, { cwd: gitRoot, timeout: 10000, windowsHide: true });
    sendWorkbenchResult(ctx, msg, { type: 'git_op_result', conversationId, _requestUserId, operation: 'restore', success: true, message: `Restored: ${filePath}` });
  } catch (e) {
    sendWorkbenchResult(ctx, msg, { type: 'git_op_result', conversationId, _requestUserId, operation: 'restore', success: false, error: e.message });
  }
}

export async function handleGitCommit(msg) {
  const { conversationId, commitMessage, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    if (!commitMessage || !commitMessage.trim()) {
      sendWorkbenchResult(ctx, msg, { type: 'git_op_result', conversationId, _requestUserId, operation: 'commit', success: false, error: 'Commit message is required' });
      return;
    }

    const gitRoot = await getGitRoot(workDir);

    // Write commit message to temp file to avoid shell injection
    const tmpFile = join(gitRoot, '.git', 'WEBCHAT_COMMIT_MSG');
    await writeFile(tmpFile, commitMessage.trim(), 'utf8');

    try {
      const { stdout } = await execAsync(`git commit -F "${tmpFile}"`, {
        cwd: gitRoot, timeout: 30000, windowsHide: true
      });
      sendWorkbenchResult(ctx, msg, { type: 'git_op_result', conversationId, _requestUserId, operation: 'commit', success: true, message: stdout.trim() });
    } finally {
      // Clean up temp file
      try { await writeFile(tmpFile, '', 'utf8'); } catch {}
    }
  } catch (e) {
    sendWorkbenchResult(ctx, msg, { type: 'git_op_result', conversationId, _requestUserId, operation: 'commit', success: false, error: e.stderr?.trim() || e.message });
  }
}

export async function handleGitPush(msg) {
  const { conversationId, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;

  try {
    const gitRoot = await getGitRoot(workDir);
    const { stdout, stderr } = await execAsync('git push', {
      cwd: gitRoot, timeout: 60000, windowsHide: true
    });
    sendWorkbenchResult(ctx, msg, { type: 'git_op_result', conversationId, _requestUserId, operation: 'push', success: true, message: (stdout + '\n' + stderr).trim() || 'Push complete' });
  } catch (e) {
    sendWorkbenchResult(ctx, msg, { type: 'git_op_result', conversationId, _requestUserId, operation: 'push', success: false, error: e.stderr?.trim() || e.message });
  }
}
