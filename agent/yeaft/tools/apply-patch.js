/**
 * apply-patch.js — Validate and apply a unified diff patch to files.
 *
 * The complete patch and every source file are validated before the first
 * write. Filesystem writes are still sequential and therefore are not a
 * cross-file transaction when a runtime I/O error occurs.
 */

import { defineTool } from './types.js';
import { readFile, mkdir, lstat, realpath, open } from 'fs/promises';
import { existsSync, constants } from 'fs';
import { dirname, posix, resolve, win32 } from 'path';

const NO_NEWLINE_MARKER = '\\ No newline at end of file';

function patchError(message, lineNumber) {
  const suffix = lineNumber == null ? '' : ` at patch line ${lineNumber}`;
  return new Error(`${message}${suffix}`);
}

function parsePatchTarget(line, prefix, lineNumber) {
  const raw = line.slice(4).replace(/\r$/, '');
  const tabIndex = raw.indexOf('\t');
  let filePath = (tabIndex === -1 ? raw : raw.slice(0, tabIndex)).trim();
  if (!filePath) throw patchError('Patch target path is empty', lineNumber);
  if (/[\u0000-\u001f\u007f]/.test(filePath)) {
    throw patchError('Patch target path contains control characters', lineNumber);
  }
  if (filePath === '/dev/null') return null;
  if (filePath.startsWith('"') || filePath.endsWith('"')) {
    throw patchError('Quoted patch target paths are not supported', lineNumber);
  }

  if (filePath.startsWith(`${prefix}/`)) filePath = filePath.slice(2);
  if (!filePath || filePath === '.' || filePath.includes('\\')
    || posix.isAbsolute(filePath) || win32.isAbsolute(filePath)) {
    throw patchError(`Patch target must be a relative path: ${filePath}`, lineNumber);
  }

  const normalized = posix.normalize(filePath);
  if (normalized === '..' || normalized.startsWith('../')
    || filePath.split('/').includes('..')) {
    throw patchError(`Patch target escapes the working directory: ${filePath}`, lineNumber);
  }
  return normalized;
}

function parseHunkHeader(line, lineNumber) {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?\r?$/);
  if (!match) throw patchError('Malformed hunk header', lineNumber);

  const hunk = {
    oldStart: Number.parseInt(match[1], 10),
    oldCount: match[2] == null ? 1 : Number.parseInt(match[2], 10),
    newStart: Number.parseInt(match[3], 10),
    newCount: match[4] == null ? 1 : Number.parseInt(match[4], 10),
    lines: [],
  };
  if (![hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount].every(Number.isSafeInteger)) {
    throw patchError('Hunk ranges must be safe integers', lineNumber);
  }
  if (hunk.oldStart === 0 && hunk.oldCount !== 0) {
    throw patchError('A non-empty old range must start at line 1 or later', lineNumber);
  }
  if (hunk.newStart === 0 && hunk.newCount !== 0) {
    throw patchError('A non-empty new range must start at line 1 or later', lineNumber);
  }
  return hunk;
}

function oldLineIndex(hunk) {
  return hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
}

function newLineIndex(hunk) {
  return hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
}

function validateParsedFile(fileDiff, lineNumber) {
  if (fileDiff.oldFile == null && fileDiff.newFile == null) {
    throw patchError('Both patch targets cannot be /dev/null', lineNumber);
  }
  if (fileDiff.newFile == null) {
    throw patchError('File deletion patches are not supported', lineNumber);
  }
  if (fileDiff.oldFile != null && fileDiff.oldFile !== fileDiff.newFile) {
    throw patchError('File rename patches are not supported', lineNumber);
  }
  if (fileDiff.hunks.length === 0) {
    throw patchError(`Patch for ${fileDiff.file} has no hunks`, lineNumber);
  }

  let previousOldEnd = 0;
  let cumulativeDelta = 0;
  for (const hunk of fileDiff.hunks) {
    const oldIndex = oldLineIndex(hunk);
    const newIndex = newLineIndex(hunk);
    if (oldIndex < previousOldEnd) {
      throw patchError(`Patch hunks for ${fileDiff.file} overlap or are out of order`, lineNumber);
    }
    if (newIndex !== oldIndex + cumulativeDelta) {
      throw patchError(`New line range for ${fileDiff.file} is inconsistent with earlier hunks`, lineNumber);
    }
    previousOldEnd = oldIndex + hunk.oldCount;
    cumulativeDelta += hunk.newCount - hunk.oldCount;
  }
}

/**
 * Parse the supported unified diff contract.
 * @param {string} patch
 * @returns {Array<{file: string, oldFile: string|null, newFile: string, hunks: Array}>}
 */
export function parsePatch(patch) {
  if (typeof patch !== 'string' || patch.length === 0) {
    throw new Error('Patch is empty');
  }

  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const files = [];
  const seenFiles = new Set();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].replace(/\r$/, '');
    let gitHeader = null;
    let hasNewFileMode = false;

    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git (\S+) (\S+)$/);
      if (!match) throw patchError('Malformed or unsupported diff --git header', i + 1);
      gitHeader = {
        oldFile: parsePatchTarget(`--- ${match[1]}`, 'a', i + 1),
        newFile: parsePatchTarget(`+++ ${match[2]}`, 'b', i + 1),
      };
      if (gitHeader.oldFile !== gitHeader.newFile) {
        throw patchError('File rename patches are not supported', i + 1);
      }
      i++;

      let hasIndex = false;
      while (i < lines.length) {
        const metadata = lines[i].replace(/\r$/, '');
        if (/^new file mode \d+$/.test(metadata)) {
          if (metadata !== 'new file mode 100644') {
            throw patchError('Only regular non-executable new files are supported; mode changes are not applied', i + 1);
          }
          if (hasNewFileMode || hasIndex) {
            throw patchError('Misplaced or duplicate new file mode header', i + 1);
          }
          hasNewFileMode = true;
          i++;
          continue;
        }
        if (/^index [0-9a-fA-F]+\.\.[0-9a-fA-F]+(?: \d+)?$/.test(metadata)) {
          if (hasIndex) throw patchError('Duplicate index header', i + 1);
          hasIndex = true;
          i++;
          continue;
        }
        break;
      }
    }

    if (i >= lines.length || !lines[i].replace(/\r$/, '').startsWith('--- ')) {
      const unexpected = i < lines.length ? lines[i].replace(/\r$/, '') : '<end of patch>';
      throw patchError(`Unsupported or unexpected patch header: ${unexpected}`, i + 1);
    }

    const oldFile = parsePatchTarget(lines[i], 'a', i + 1);
    i++;
    if (i >= lines.length || !lines[i].replace(/\r$/, '').startsWith('+++ ')) {
      throw patchError('A --- file header must be followed by a +++ file header', i + 1);
    }
    const newFile = parsePatchTarget(lines[i], 'b', i + 1);
    if (i + 1 < lines.length && lines[i + 1].replace(/\r$/, '').startsWith('+++ ')) {
      throw patchError('Unexpected duplicate +++ file header', i + 2);
    }
    if (gitHeader && (oldFile ?? gitHeader.oldFile) !== gitHeader.oldFile) {
      throw patchError('--- target does not match diff --git header', i);
    }
    if (gitHeader && newFile !== gitHeader.newFile) {
      throw patchError('+++ target does not match diff --git header', i + 1);
    }
    if (hasNewFileMode && oldFile != null) {
      throw patchError('new file mode requires --- /dev/null', i);
    }
    const file = newFile || oldFile;
    const fileDiff = { file, oldFile, newFile, hunks: [] };
    i++;

    if (seenFiles.has(file)) {
      throw patchError(`Patch contains duplicate file target: ${file}`, i);
    }
    seenFiles.add(file);

    while (i < lines.length) {
      const current = lines[i].replace(/\r$/, '');
      if (current === '' || current.startsWith('--- ')
        || /^diff --git /.test(current)) break;
      if (!current.startsWith('@@ ')) {
        throw patchError(`Unsupported or unexpected patch content: ${current}`, i + 1);
      }

      const hunk = parseHunkHeader(current, i + 1);
      i++;
      let oldCount = 0;
      let newCount = 0;
      let changed = false;

      while (oldCount < hunk.oldCount || newCount < hunk.newCount) {
        if (i >= lines.length) throw patchError('Hunk ended before its declared ranges', i + 1);
        const rawDiffLine = lines[i].replace(/\r$/, '');
        const type = rawDiffLine[0];
        if (![' ', '+', '-'].includes(type)) {
          throw patchError('Hunk ended before its declared ranges', i + 1);
        }

        const entry = { type, text: rawDiffLine.slice(1), noNewline: false };
        if (type !== '+') oldCount++;
        if (type !== '-') newCount++;
        if (type !== ' ') changed = true;
        if (oldCount > hunk.oldCount || newCount > hunk.newCount) {
          throw patchError('Hunk body exceeds its declared ranges', i + 1);
        }
        hunk.lines.push(entry);
        i++;

        if (i < lines.length && lines[i].replace(/\r$/, '') === NO_NEWLINE_MARKER) {
          entry.noNewline = true;
          i++;
        }
      }

      if (!changed) throw patchError('Hunk contains no additions or deletions', i);
      const oldEntries = hunk.lines.filter(entry => entry.type !== '+');
      const newEntries = hunk.lines.filter(entry => entry.type !== '-');
      const markedEntries = hunk.lines.filter(entry => entry.noNewline);
      for (const entry of markedEntries) {
        const lastOldEntry = entry.type === '+' || oldEntries.at(-1) === entry;
        const lastNewEntry = entry.type === '-' || newEntries.at(-1) === entry;
        if (!lastOldEntry || !lastNewEntry) {
          throw patchError('No-newline marker must describe the final line of its range', i);
        }
      }
      hunk.oldNoNewline = oldEntries.at(-1)?.noNewline === true;
      hunk.newNoNewline = newEntries.at(-1)?.noNewline === true;
      hunk.oldLines = oldEntries.map(entry => entry.text);
      hunk.newLines = newEntries.map(entry => entry.text);
      fileDiff.hunks.push(hunk);
    }

    validateParsedFile(fileDiff, i + 1);
    files.push(fileDiff);
  }

  if (files.length === 0) throw new Error('No valid file diffs found in patch');
  return files;
}

function splitFileContent(content) {
  const lines = [];
  const terminators = [];
  const pattern = /([^\n]*)(\n|$)/g;
  for (const match of content.matchAll(pattern)) {
    if (!match[0]) break;
    const crlf = match[2] && match[1].endsWith('\r');
    lines.push(crlf ? match[1].slice(0, -1) : match[1]);
    terminators.push(crlf ? '\r\n' : match[2]);
  }
  return { lines, terminators, endsWithNewline: content.endsWith('\n'),
    eol: terminators.find(Boolean) || '\n' };
}

function applyHunks(content, fileDiff) {
  const source = splitFileContent(content);
  const output = [];
  let cursor = 0;

  for (const hunk of fileDiff.hunks) {
    const start = oldLineIndex(hunk);
    if (start > source.lines.length || start + hunk.oldCount > source.lines.length) {
      throw new Error(`Hunk source range is outside ${fileDiff.file}`);
    }

    if (hunk.oldCount === 0 && start > 0 && !source.terminators[start - 1]) {
      throw new Error(`Insertion after an unterminated line requires replacing that line in ${fileDiff.file}`);
    }
    const actual = source.lines.slice(start, start + hunk.oldCount);
    for (let index = 0; index < hunk.oldLines.length; index++) {
      if (actual[index] !== hunk.oldLines[index]) {
        throw new Error(
          `Hunk context mismatch in ${fileDiff.file} at line ${start + index + 1}: `
          + `expected ${JSON.stringify(hunk.oldLines[index])}, found ${JSON.stringify(actual[index])}`,
        );
      }
    }

    const oldTouchesEof = start + hunk.oldCount === source.lines.length;
    if (hunk.oldNoNewline && (!oldTouchesEof || source.endsWithNewline)) {
      throw new Error(`Old no-newline marker does not match ${fileDiff.file}`);
    }
    if (oldTouchesEof && hunk.oldCount > 0 && !hunk.oldNoNewline && !source.endsWithNewline) {
      throw new Error(`Expected a newline at end of ${fileDiff.file}`);
    }

    if (hunk.newNoNewline && (!oldTouchesEof || hunk !== fileDiff.hunks.at(-1))) {
      throw new Error(`New no-newline marker must describe the final output line in ${fileDiff.file}`);
    }
    // Preserve every untouched line's terminator, including mixed LF/CRLF.
    for (let index = cursor; index < start; index++) {
      output.push(source.lines[index] + source.terminators[index]);
    }
    let oldCursor = start;
    for (const entry of hunk.lines) {
      if (entry.type === ' ') {
        output.push(source.lines[oldCursor] + source.terminators[oldCursor]);
        oldCursor++;
      } else if (entry.type === '-') {
        oldCursor++;
      } else {
        const eol = source.terminators[Math.max(start, oldCursor - 1)]
          || source.terminators[oldCursor] || source.eol;
        output.push(entry.text + (entry.noNewline ? '' : eol));
      }
    }
    cursor = start + hunk.oldCount;
  }

  for (let index = cursor; index < source.lines.length; index++) {
    output.push(source.lines[index] + source.terminators[index]);
  }
  return output.join('');
}

// Lexical containment is checked by parsePatch. Reject symlinks at every
// existing component, and remember identities to detect changes before I/O.
// These checks are not an OS sandbox against hostile concurrent directory swaps.
async function inspectTarget(cwd, file) {
  const parts = file.split('/');
  const identities = [];
  let current = cwd;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = resolve(current, parts[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (info.isSymbolicLink()) throw new Error(`Symbolic link target is not supported: ${file}`);
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(`Patch parent is not a directory: ${file}`);
    }
    if (index === parts.length - 1 && !info.isFile()) throw new Error(`Patch target is not a regular file: ${file}`);
    identities.push({ path: current, dev: info.dev, ino: info.ino });
  }
  return identities;
}

async function verifyTarget(cwd, plan) {
  const current = await inspectTarget(cwd, plan.file);
  for (const old of plan.identities) {
    if (!current.some(now => now.path === old.path && now.dev === old.dev && now.ino === old.ino)) {
      throw new Error(`Patch target changed after validation: ${plan.file}`);
    }
  }
  return current;
}

async function writePlan(cwd, plan, signal) {
  if (signal?.aborted) throw new Error('Patch cancelled before write');
  await verifyTarget(cwd, plan);
  await mkdir(dirname(plan.absPath), { recursive: true });
  await verifyTarget(cwd, plan);
  const flags = plan.oldFile == null ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    : constants.O_RDWR | (constants.O_NOFOLLOW || 0);
  const handle = await open(plan.absPath, flags, 0o666);
  try {
    const identities = await verifyTarget(cwd, plan);
    const opened = await handle.stat();
    const target = identities.at(-1);
    if (!opened.isFile() || target?.dev !== opened.dev || target?.ino !== opened.ino) {
      throw new Error(`Patch target replaced during open: ${plan.file}`);
    }
    if (plan.oldFile != null && await handle.readFile('utf8') !== plan.original) {
      throw new Error(`Patch content changed after validation: ${plan.file}`);
    }
    await verifyTarget(cwd, plan);
    if (signal?.aborted) throw new Error('Patch cancelled before write');
    const bytes = Buffer.from(plan.content, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (!bytesWritten) throw new Error('Patch write made no progress');
      offset += bytesWritten;
    }
    await handle.truncate(bytes.length);
  } finally { await handle.close(); }
}

async function preparePatch(cwd, fileDiffs) {
  const plans = [];
  for (const fileDiff of fileDiffs) {
    const absPath = resolve(cwd, fileDiff.file);
    const identities = await inspectTarget(cwd, fileDiff.file);
    const exists = existsSync(absPath);
    if (fileDiff.oldFile == null && exists) {
      throw new Error(`New file already exists: ${fileDiff.file}`);
    }
    if (fileDiff.oldFile != null && !exists) {
      throw new Error(`File not found: ${fileDiff.file}`);
    }

    const content = exists ? await readFile(absPath, 'utf8') : '';
    plans.push({
      ...fileDiff,
      absPath,
      identities,
      original: content,
      content: applyHunks(content, fileDiff),
    });
  }
  return plans;
}

export default defineTool({
  name: 'ApplyPatch',
  description: {
    en: `Apply a standard unified diff patch to one or more files.

The complete patch is parsed and all original context/deletion lines are matched before any file is written. Multiple hunks per file and multiple files are supported; new files use the standard /dev/null header. Targets must be relative paths that stay within the working directory.

Guidelines:
- Provide standard unified diff format (--- a/file, +++ b/file, @@ hunks)
- Include exact current context; stale or malformed patches make no changes
- Use one file header with multiple ordered hunks for several edits in a file
- Symlink targets/ancestors are rejected and checked again before writing; this is not a sandbox against hostile concurrent filesystem mutation
- Validation is all-or-nothing, but filesystem writes are not transactional: a runtime I/O failure can leave earlier files changed and the failed file partially written`,
    zh: `将标准 unified diff 补丁应用到一个或多个文件。

写入任何文件前，会完整解析补丁并匹配全部原上下文和删除行。支持同文件多个块和跨文件补丁；新文件使用标准 /dev/null 头。目标必须是工作目录内的相对路径。

使用指南：
- 提供标准 unified diff 格式（--- a/file、+++ b/file、@@ 块）
- 上下文必须与当前内容精确一致；过时或畸形补丁不会产生修改
- 同一文件的多处编辑使用一个文件头和多个有序块
- 拒绝符号链接目标和祖先，写入前再次检查；这不等同于防御恶意并发文件系统修改的 sandbox
- 验证是全有或全无的，但文件系统写入不是事务：运行时 I/O 失败可能保留之前已写入的文件，失败文件也可能只写入一部分`
  },
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description: {
          en: 'The standard unified diff patch content',
          zh: '标准 unified diff 补丁内容',
        },
      },
    },
    required: ['patch'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: () => false,
  async execute(input, ctx) {
    const { patch } = input;
    if (!patch) return JSON.stringify({ errorEffect: 'none', error: 'patch is required' });

    let cwd;
    let plans;
    try {
      const parsed = parsePatch(patch);
      cwd = await realpath(ctx?.cwd || process.cwd());
      plans = await preparePatch(cwd, parsed);
    } catch (err) {
      return JSON.stringify({
        errorEffect: 'none',
        error: `Patch validation failed: ${err.message}`,
      });
    }

    const results = [];
    for (let index = 0; index < plans.length; index++) {
      const plan = plans[index];
      try {
        await writePlan(cwd, plan, ctx?.signal);
        results.push({ file: plan.file, success: true, hunks: plan.hunks.length });
      } catch (err) {
        return JSON.stringify({
          errorEffect: 'unknown',
          error: `Patch write failed for ${plan.file}: ${err.message}`,
          results,
          failedFile: plan.file,
          remainingFiles: plans.slice(index + 1).map(item => item.file),
          warning: 'The patch was fully validated, but filesystem writes are not transactional; successful files listed in results may already be changed, and the failed file may be partially written.',
        }, null, 2);
      }
    }

    return JSON.stringify({
      success: true,
      results,
      summary: `Applied ${results.reduce((sum, result) => sum + result.hunks, 0)} hunk(s) to ${results.length} file(s)`,
    }, null, 2);
  },
});
