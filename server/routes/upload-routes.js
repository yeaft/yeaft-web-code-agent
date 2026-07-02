import { randomUUID } from 'crypto';
import multer from 'multer';
import { CONFIG } from '../config.js';
import { userDb } from '../database.js';
import { pendingFiles, previewFiles } from '../context.js';

// 文件上传配置 (存储在内存中)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONFIG.maxFileSize }
});

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

// Cleanup expired preview files every 60s (10 min TTL)
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, f] of previewFiles) {
    if (f.createdAt < cutoff) previewFiles.delete(id);
  }
}, 60 * 1000);

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

  app.get('/api/preview/:fileId', (req, res) => {
    const file = previewFiles.get(req.params.fileId);
    if (!file) return res.status(404).send('File not found or expired');
    if (file.token && req.query.token !== file.token) {
      return res.status(403).send('Forbidden');
    }
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(file.buffer);
  });
}
