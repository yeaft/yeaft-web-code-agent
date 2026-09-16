import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve, isAbsolute } from 'path';

export const execAsync = promisify(exec);

// 路径安全校验 - 确保路径格式正确
export function resolveAndValidatePath(filePath, workDir) {
  const resolved = isAbsolute(filePath) ? resolve(filePath) : resolve(workDir, filePath);
  return resolved;
}

// Helper: resolve git root for a working directory
export async function getGitRoot(workDir) {
  try {
    const { stdout } = await execAsync('git rev-parse --show-toplevel', {
      cwd: workDir, timeout: 5000, windowsHide: true
    });
    return stdout.trim();
  } catch {
    return workDir;
  }
}

// Helper: validate file path for shell safety
export function validateGitPath(filePath) {
  return filePath && !/[`$;|&><!\n\r]/.test(filePath);
}

// Binary file extensions → MIME type mapping
export const BINARY_EXTENSIONS = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon'
};

export const VIDEO_EXTENSIONS = {
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.webm': 'video/webm',
  '.ogv': 'video/ogg', '.ogg': 'video/ogg', '.mov': 'video/quicktime'
};
