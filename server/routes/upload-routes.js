import { randomUUID } from 'crypto';
import multer from 'multer';
import { CONFIG } from '../config.js';
import { userDb } from '../database.js';
import { pendingFiles, previewFiles } from '../context.js';
import { PREVIEW_FILE_TTL_MS, prunePreviewFiles } from '../preview-files.js';
import { yeaftAssetStore } from '../yeaft-asset-store.js';
import { openWorkbenchVideo, readWorkbenchPreview, WORKBENCH_VIDEO_CHUNK_BYTES } from '../workbench-preview.js';

// 文件上传配置 (存储在内存中)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONFIG.maxFileSize }
});

export function parseByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size <= 0) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!/^\d+$/.test(match[2]) || !Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (!/^\d+$/.test(match[1]) || (match[2] && !/^\d+$/.test(match[2]))) return false;
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

async function writeResponseChunk(res, chunk) {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(chunk)) return true;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off?.('drain', onDrain);
      res.off?.('close', onClose);
      res.off?.('error', onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(error); };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
  return !res.destroyed && !res.writableEnded;
}

export async function streamWorkbenchVideo(req, res, video) {
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  req.once?.('aborted', abort);
  res.once?.('close', abort);
  try {
    const requested = parseByteRange(req.headers?.range, video.size);
    if (requested === false) {
      res.setHeader('Content-Range', `bytes */${video.size}`);
      return res.status(416).end();
    }
    if (video.size === 0 && requested) {
      res.setHeader('Content-Range', 'bytes */0');
      return res.status(416).end();
    }
    const range = requested || { start: 0, end: video.size - 1 };
    const partial = requested !== null;
    const isHead = req.method === 'HEAD';
    const firstEnd = video.size === 0 ? -1 : Math.min(range.end, range.start + WORKBENCH_VIDEO_CHUNK_BYTES - 1);
    const firstChunk = isHead || firstEnd < range.start
      ? null
      : await video.read(range.start, firstEnd, abortController.signal);
    res.status(partial ? 206 : 200);
    res.setHeader('Content-Type', video.mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(video.size === 0 ? 0 : range.end - range.start + 1));
    if (partial) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${video.size}`);
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(video.filename)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    if (isHead || video.size === 0) return res.end();
    if (!await writeResponseChunk(res, firstChunk)) return;
    for (let start = firstEnd + 1; start <= range.end;) {
      const end = Math.min(range.end, start + WORKBENCH_VIDEO_CHUNK_BYTES - 1);
      const chunk = await video.read(start, end, abortController.signal);
      if (!await writeResponseChunk(res, chunk)) return;
      start = end + 1;
    }
    res.end();
  } finally {
    req.off?.('aborted', abort);
    res.off?.('close', abort);
  }
}

export function extensionForMimeType(mimeType) {
  const type = String(mimeType || '').toLowerCase();
  if (type === 'image/png') return '.png';
  if (type === 'image/jpeg') return '.jpg';
  if (type === 'image/gif') return '.gif';
  if (type === 'image/webp') return '.webp';
  if (type === 'image/svg+xml') return '.svg';
  if (type === 'text/plain') return '.txt';
  if (type === 'application/json') return '.json';
  return '';
}

export function fallbackUploadName(file, index) {
  const original = typeof file?.originalname === 'string' ? file.originalname.trim() : '';
  if (original) return original;
  const isImage = String(file?.mimetype || '').startsWith('image/');
  const prefix = isImage ? 'pasted-image' : 'uploaded-file';
  return `${prefix}-${Date.now()}-${index + 1}${extensionForMimeType(file?.mimetype)}`;
}

// 定期清理超过 10 分钟的文件
setInterval(() => {
  const now = Date.now();
  for (const [fileId, file] of pendingFiles) {
    if (now - file.uploadedAt > CONFIG.fileCleanupInterval) {
      pendingFiles.delete(fileId);
    }
  }
}, 60 * 1000);

// Cleanup expired preview files every 60s.
setInterval(() => prunePreviewFiles(), Math.min(60 * 1000, PREVIEW_FILE_TTL_MS));

/**
 * Register file upload and preview routes.
 */
export function registerUploadRoutes(app, { requireAuth }) {
  app.post('/api/upload', requireAuth, upload.array('files', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const user = userDb.getOrCreate(req.user.username);
    const userId = user?.id;

    const uploaded = req.files.map((file, index) => {
      const fileId = randomUUID();
      const name = fallbackUploadName(file, index);
      pendingFiles.set(fileId, {
        name,
        mimeType: file.mimetype,
        buffer: file.buffer,
        uploadedAt: Date.now(),
        userId
      });
      return {
        fileId,
        name,
        mimeType: file.mimetype,
        size: file.size
      };
    });

    res.json({ files: uploaded });
  });

  app.get('/api/preview/:fileId', async (req, res) => {
    let file;
    try {
      if (typeof req.query.token === 'string' && req.query.token.startsWith('wbv1.')) {
        const video = openWorkbenchVideo(req.params.fileId, req.query.token);
        return await streamWorkbenchVideo(req, res, video);
      }
      file = typeof req.query.token === 'string' && req.query.token.startsWith('wb1.')
        ? await readWorkbenchPreview(req.params.fileId, req.query.token)
        : previewFiles.get(req.params.fileId);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(error.status || 502).send(error.status ? error.message : 'Preview read failed');
    }
    if (!file) return res.status(404).send('File not found or expired');
    if (file.token && req.query.token !== file.token) {
      return res.status(403).send('Forbidden');
    }
    res.setHeader('Content-Type', file.mimeType);
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(file.filename)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(file.buffer);
  });

  app.get('/api/yeaft/assets/:scopeId/:assetId', (req, res) => {
    const asset = yeaftAssetStore.read(req.params.scopeId, req.params.assetId, req.query.token);
    if (!asset) return res.status(404).send('Image asset not found');
    res.setHeader('Content-Type', asset.metadata.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(asset.metadata.filename)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('ETag', `"${asset.metadata.assetId}"`);
    res.send(asset.buffer);
  });
}
