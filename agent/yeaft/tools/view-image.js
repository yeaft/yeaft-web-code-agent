/**
 * view-image.js — Load a local image file into the LLM's context.
 *
 * task-333b PR-B: upgraded from metadata-only stub to a real multimodal
 * loader. Returns a tool result that includes:
 *   - `image`: a base64-encoded data URI suitable for embedding into an
 *     LLM image content block (OpenAI / Anthropic style)
 *   - `media_type`: the canonical MIME (image/png, image/jpeg, ...)
 *   - `format`, `width`, `height`, `size`, `sizeFormatted`, `path`
 *
 * Safety rules (per PM 乔布斯 PR-B spec + prev-3 product review):
 *   - Path safety: no `..`, no absolute paths escaping cwd unless the
 *     resolved path lives under ctx.imageAllowlist[] (absolute dirs
 *     provided by the host).
 *   - Size cap: configurable via ctx.maxImageBytes (default 20 MiB).
 *     Larger files are rejected with a self-correcting error message
 *     that nudges resize/crop or config.json tuning.
 *   - MIME whitelist: png / jpeg / gif / webp / jfif. SVG / BMP / ICO /
 *     TIFF are intentionally excluded — they either aren't multimodal-
 *     LLM-safe (SVG = embedded script surface) or aren't supported by
 *     the mainstream vision endpoints.
 *   - HEIC is special-cased: we cannot decode it server-side, but the
 *     error nudges the user to convert via `sips -s format jpeg` (mac)
 *     instead of a generic "Unsupported format".
 */

import { defineTool } from './types.js';
import { stat, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, extname, isAbsolute } from 'path';
import { checkPathAllowed } from './path-safety.js';

/** Default max image size in bytes (20 MiB). Override via ctx.maxImageBytes. */
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Extension → canonical MIME type.
 * The keys are the whitelist; anything else is rejected.
 * `.jfif` (common Windows paste extension) maps to image/jpeg.
 */
const EXT_TO_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
});

const ALLOWED_EXTS = Object.keys(EXT_TO_MIME);

/**
 * Parse basic image dimensions from header bytes. Best-effort — returns
 * null if the file is too short or the format isn't one we parse.
 *
 * @param {Buffer} buffer
 * @param {string} ext — lowercase extension including the dot
 */
function parseImageDimensions(buffer, ext) {
  try {
    if (ext === '.png' && buffer.length >= 24) {
      // PNG: width at offset 16, height at 20 (big-endian 32-bit)
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if ((ext === '.jpg' || ext === '.jpeg' || ext === '.jfif') && buffer.length > 10) {
      // JPEG: scan for SOF0 (0xFFC0) / SOF2 (0xFFC2) marker
      for (let i = 0; i < buffer.length - 9; i++) {
        if (buffer[i] === 0xFF && (buffer[i + 1] === 0xC0 || buffer[i + 1] === 0xC2)) {
          return {
            height: buffer.readUInt16BE(i + 5),
            width: buffer.readUInt16BE(i + 7),
          };
        }
      }
    }
    if (ext === '.gif' && buffer.length >= 10) {
      // GIF: width at offset 6, height at 8 (little-endian 16-bit)
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (ext === '.webp' && buffer.length >= 30) {
      // WEBP: RIFF...WEBP...VP8(L|X| ). Three common sub-chunks.
      if (buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
          buffer.slice(8, 12).toString('ascii') === 'WEBP') {
        const fourcc = buffer.slice(12, 16).toString('ascii');
        if (fourcc === 'VP8 ' && buffer.length >= 30) {
          // Lossy: width/height at 26/28 as 14-bit LE (mask 0x3FFF)
          return {
            width: buffer.readUInt16LE(26) & 0x3FFF,
            height: buffer.readUInt16LE(28) & 0x3FFF,
          };
        }
        if (fourcc === 'VP8L' && buffer.length >= 25) {
          // Lossless: packed 14+14 bits at offset 21
          const b0 = buffer[21], b1 = buffer[22], b2 = buffer[23], b3 = buffer[24];
          const width = 1 + (((b1 & 0x3F) << 8) | b0);
          const height = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8X' && buffer.length >= 30) {
          // Extended: 24-bit LE widths/heights at 24/27, stored as (n-1)
          const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
          const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
          return { width, height };
        }
      }
    }
  } catch {
    // Dimension parsing is best-effort only.
  }
  return null;
}


function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export default defineTool({
  name: 'ViewImage',
  description: {
    en: `Load a local image file and attach it to the conversation so the LLM can see it.

Returns a base64 data URI (\`image\` field) plus metadata (format, dimensions,
size). The caller/bridge is responsible for turning the data URI into the
provider-specific image content block.

When to call:
  - User references a local image path (screenshot, design, log/chart) and
    asks you to read, analyse, or describe it.
  - User says "look at this file" / "check the screenshot at ..." / "what's
    in docs/assets/arch.png?".

When NOT to call:
  - The image is already attached to the current message (the host has
    already uploaded it — you can see it without this tool).
  - The image is a remote URL (http/https). ViewImage only reads local
    files; use a fetch-style tool for URLs.
  - You only need the file's existence / mtime / size — use Read or a
    filesystem tool instead; ViewImage loads the full bytes into memory.

Path examples:
  - Relative (resolved against project cwd): "./screenshots/bug.png",
    "docs/assets/arch.png"
  - Absolute inside an allowlisted dir: "/home/user/Downloads/error.png"
    (only works when the host added that dir to ctx.imageAllowlist)

Supported formats: PNG, JPEG (.jpg/.jpeg/.jfif), GIF, WebP.
Max size: 20 MiB by default (configurable via ctx.maxImageBytes).
Path must live under the project directory or an explicit host allowlist.`,
    zh: `加载本地图片文件并附加到对话中，使 LLM 可以查看。

返回 base64 data URI（image 字段）及元数据（格式、尺寸、大小）。调用方/桥接层负责将 data URI 转换为
provider 特定的图片内容块。

何时调用：
  - 用户引用本地图片路径（截图、设计稿、日志/图表）并要求你读取、分析或描述它。
  - 用户说"看看这个文件"/"检查 xxx 处的截图"/"docs/assets/arch.png 里有什么？"。

何时不调用：
  - 图片已附加到当前消息中（宿主已上传——你无需此工具即可看到）。
  - 图片是远程 URL（http/https）。ViewImage 只读本地文件；对 URL 使用抓取类工具。
  - 你只需要文件的存续/修改时间/大小——用 Read 或文件系统工具；ViewImage 会将完整文件字节加载到内存。

路径示例：
  - 相对路径（相对项目 cwd 解析）："./screenshots/bug.png"、"docs/assets/arch.png"
  - 白名单目录内的绝对路径："/home/user/Downloads/error.png"（仅当宿主将该目录加入 ctx.imageAllowlist 时有效）

支持格式：PNG、JPEG（.jpg/.jpeg/.jfif）、GIF、WebP。
最大文件：默认 20 MiB（可通过 ctx.maxImageBytes 配置）。
路径必须在项目目录下或已加入宿主白名单。`
  },
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the image file. Relative paths are resolved against the project cwd.',
      },
    },
    required: ['file_path'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { file_path } = input || {};
    if (!file_path || typeof file_path !== 'string') {
      return JSON.stringify({ error: 'file_path is required and must be a string' });
    }

    // Reject `..` segments explicitly before path resolution — catches the
    // cases where resolve() might still land inside cwd by accident. This
    // also gives LLMs a self-correcting error ("don't use ../") distinct
    // from the "path outside project" message for absolute paths.
    if (file_path.split(/[/\\]/).some(seg => seg === '..')) {
      return JSON.stringify({
        error:
          'file_path must not contain `..` segments. Use a path relative to the ' +
          'project (e.g. "docs/assets/foo.png") or an absolute path under an ' +
          'allowlisted directory.',
      });
    }

    const cwd = ctx?.cwd || process.cwd();
    const allowlist = Array.isArray(ctx?.imageAllowlist) ? ctx.imageAllowlist : [];
    // Size cap: ctx.maxImageBytes (host-injected from config.json) wins,
    // falling back to 20 MiB. A non-finite / non-positive override is ignored.
    const maxBytes =
      Number.isFinite(ctx?.maxImageBytes) && ctx.maxImageBytes > 0
        ? Math.floor(ctx.maxImageBytes)
        : DEFAULT_MAX_IMAGE_BYTES;
    const absPath = resolve(cwd, file_path);

    const pathErr = checkPathAllowed(absPath, cwd, allowlist);
    if (pathErr) {
      // prev-3 P2: split "absolute outside project" from "relative ..".
      // The `..` case is already handled above, so anything reaching here
      // is either an absolute path outside cwd/allowlist or a relative
      // path that resolve() pushed outside cwd (rare). Either way, the
      // host-level fix is the same, so we keep one nudge message.
      const isAbs = isAbsolute(file_path);
      const hint = isAbs
        ? 'Absolute path is outside the project directory. '
        : 'Resolved path is outside the project directory. ';
      return JSON.stringify({
        error: hint + pathErr.message,
        path: absPath,
      });
    }

    const ext = extname(absPath).toLowerCase();
    // HEIC special-case: iPhone screenshots default to HEIC and silently
    // fail today. Give users a concrete one-liner to fix it instead of a
    // generic "Unsupported format".
    if (ext === '.heic' || ext === '.heif') {
      return JSON.stringify({
        error:
          'HEIC images need to be converted to JPEG first. ' +
          'Use `sips -s format jpeg <file> --out <file>.jpg` on macOS ' +
          '(or an equivalent tool like ImageMagick on Linux/Windows), then retry.',
        format: ext.slice(1).toUpperCase(),
        supported: ALLOWED_EXTS,
      });
    }
    if (!(ext in EXT_TO_MIME)) {
      return JSON.stringify({
        error: `Unsupported image format: ${ext || '(none)'}`,
        supported: ALLOWED_EXTS,
      });
    }

    if (!existsSync(absPath)) {
      return JSON.stringify({ error: `Image not found: ${absPath}` });
    }

    let fileStat;
    try {
      fileStat = await stat(absPath);
    } catch (err) {
      return JSON.stringify({ error: `Failed to stat image: ${err.message}` });
    }

    if (!fileStat.isFile()) {
      return JSON.stringify({ error: 'file_path does not point to a regular file' });
    }

    if (fileStat.size > maxBytes) {
      return JSON.stringify({
        error:
          `Image exceeds ${formatBytes(maxBytes)} (${formatBytes(fileStat.size)} actual). ` +
          `Reduce image size (resize/crop), or set \`maxImageBytes\` in ` +
          `~/.yeaft/config.json if your LLM supports more.`,
        size: fileStat.size,
        maxSize: maxBytes,
      });
    }

    let buffer;
    try {
      buffer = await readFile(absPath);
    } catch (err) {
      return JSON.stringify({ error: `Failed to read image: ${err.message}` });
    }

    const mediaType = EXT_TO_MIME[ext];
    const base64 = buffer.toString('base64');
    const dataUri = `data:${mediaType};base64,${base64}`;
    const dimensions = parseImageDimensions(buffer, ext);

    const result = {
      path: absPath,
      format: ext.slice(1).toUpperCase() === 'JPG' ? 'JPEG' : ext.slice(1).toUpperCase(),
      media_type: mediaType,
      size: fileStat.size,
      sizeFormatted: formatBytes(fileStat.size),
      modified: fileStat.mtime.toISOString(),
      image: dataUri,
    };
    // Normalise .jfif to JPEG in display format too, for consistency.
    if (ext === '.jfif') result.format = 'JPEG';
    if (dimensions) {
      result.width = dimensions.width;
      result.height = dimensions.height;
    }

    return JSON.stringify(result, null, 2);
  },
});
