import { createHash, randomUUID } from 'node:crypto';
import { CONFIG } from '../config.js';
import { pendingFiles, previewFiles } from '../context.js';
import { PREVIEW_FILE_TTL_MS, prunePreviewFiles } from '../preview-files.js';
import { detectImageMime, yeaftAssetStore } from '../yeaft-asset-store.js';
import { CREATION_MEDIA_CHUNK_BYTES, openCreationMedia } from '../creation-media-relay.js';
import { CREATION_MEDIA_SNIFF_BYTES, verifiedCreationMediaType } from '../creation-media-type.js';
import { readSessionAttachment } from '../session-attachment-relay.js';
import { openWorkbenchVideo, readWorkbenchPreview, WORKBENCH_VIDEO_CHUNK_BYTES } from '../workbench-preview.js';
import { readPendingUploads } from './upload-intake.js';

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
    let firstChunk;
    if (isHead || firstEnd < range.start) {
      if (typeof video.revalidate === 'function') await video.revalidate(abortController.signal);
    } else {
      firstChunk = await video.read(range.start, firstEnd, abortController.signal);
    }
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

function computeCreationMediaEtag(mediaKind, mediaId, totalSize, version) {
  const identity = [mediaKind, mediaId, totalSize];
  if (version !== null) identity.push(version);
  return `"${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}"`;
}

async function streamCreationMedia(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  // IncomingMessage also emits close after *normal* request completion. A
  // disconnect after the GET is fully read is detected on ServerResponse.
  const requestClosed = () => { if (!req.complete) abort(); };
  req.once('close', requestClosed);
  res.once('close', abort);
  if (res.destroyed) abort();
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store, no-transform');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  let transfer;
  try {
    transfer = openCreationMedia(req.user, req.params, controller.signal);
    // Resolve the total before parsing suffix/open-ended ranges. Full GETs
    // use their first pull as the probe so those bytes are not read twice.
    const probeSize = req.method === 'HEAD' || req.headers.range ? CREATION_MEDIA_SNIFF_BYTES : CREATION_MEDIA_CHUNK_BYTES;
    const first = await transfer.read(0, probeSize - 1);
    const { totalSize, mimeType, filename } = first;
    // Exports reuse their media ID across regenerations; pin to the version from the probe.
    const expectedVersion = first.version ?? null;
    const { mediaKind, mediaId } = req.params;
    const etag = computeCreationMediaEtag(mediaKind, mediaId, totalSize, expectedVersion);
    res.setHeader('ETag', etag);
    // If-Range requires a strong match. We don't publish Last-Modified, so
    // dates, weak tags and unknown validators all fall back to a full body.
    const rangeHeader = req.headers['if-range'] === undefined || req.headers['if-range'] === etag
      ? req.headers.range : undefined;
    const requested = parseByteRange(rangeHeader, totalSize);
    if (requested === false) {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      res.setHeader('Content-Length', '0');
      return res.status(416).end();
    }
    const range = requested ?? { start: 0, end: totalSize - 1 };
    const length = range.end - range.start + 1;
    const verifiedMimeType = verifiedCreationMediaType(first.buffer, mimeType, totalSize);
    const isSvg = verifiedMimeType === 'image/svg+xml';
    const inline = req.query.download !== '1' && (!isSvg || mediaKind === 'asset') && verifiedMimeType;
    const basename = filename.split(/[/\\]/).pop()?.replace(/[\x00-\x1f\x7f]/g, '') || 'media';
    const encoded = encodeURIComponent(basename.toWellFormed()).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16));
    res.status(requested ? 206 : 200);
    res.setHeader('Content-Type', inline ? verifiedMimeType : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`);
    res.setHeader('Content-Length', String(length));
    if (requested) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${totalSize}`);
    if (inline && isSvg) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (req.method === 'HEAD' || length === 0) return res.end();

    for (let start = range.start; start <= range.end;) {
      const buffered = start <= first.end;
      const end = Math.min(range.end, buffered ? first.end : start + Math.min(range.end - start, CREATION_MEDIA_CHUNK_BYTES - 1));
      const chunk = buffered ? first : await transfer.read(start, end, { expectedVersion });
      if ((chunk.version ?? null) !== expectedVersion || chunk.totalSize !== totalSize
          || chunk.mimeType !== mimeType || chunk.filename !== filename || chunk.end < end) {
        throw Object.assign(new Error('Creation media changed during transfer'), { status: 409 });
      }
      if (controller.signal.aborted) return;
      // A stalled reader must not pin a transfer slot indefinitely.
      const timer = setTimeout(() => res.destroy(), 60_000);
      timer.unref?.();
      try {
        if (!await writeResponseChunk(res, chunk.buffer.subarray(start - chunk.start, end - chunk.start + 1))) return;
      } finally {
        clearTimeout(timer);
      }
      start = end + 1;
    }
    res.end();
  } catch (error) {
    if (res.destroyed || controller.signal.aborted) return;
    if (res.headersSent) return res.destroy();
    for (const header of ['Content-Length', 'Content-Range', 'Content-Type', 'Content-Disposition', 'Content-Security-Policy', 'ETag']) {
      res.removeHeader(header);
    }
    res.status(error.status || 502).type('text/plain').send(error.status ? error.message : 'Creation media read failed');
  } finally {
    transfer?.close();
    req.off('close', requestClosed);
    res.off('close', abort);
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

// Expired staged files return their quota through the same path as consumers.
setInterval(() => pendingFiles.prune(Date.now(), CONFIG.fileCleanupInterval), 60_000).unref();

// Cleanup expired preview files every 60s.
setInterval(() => prunePreviewFiles(), Math.min(60 * 1000, PREVIEW_FILE_TTL_MS));

/**
 * Register file upload and preview routes.
 */
export function registerUploadRoutes(app, { requireAuth, requireSessionAuth = requireAuth }) {
  app.route('/api/yeaft/creations/:agentId/:creationId/media/:mediaKind/:mediaId')
    .head(requireSessionAuth, streamCreationMedia)
    .get(requireSessionAuth, streamCreationMedia);

  app.post('/api/upload', requireSessionAuth, readPendingUploads, (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const userId = req.uploadUserId;

    const uploaded = req.files.map((file, index) => {
      const fileId = randomUUID();
      const name = fallbackUploadName(file, index);
      const { buffer } = file.body;
      file.release(); // Transfer the reservation into the staged store synchronously.
      pendingFiles.set(fileId, {
        name,
        mimeType: file.mimetype,
        buffer,
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

  app.get('/api/yeaft/session-attachments/:agentId/:sessionId/:attachmentId', requireSessionAuth, async (req, res) => {
    const controller = new AbortController();
    // Bound the whole stream too: a browser that stops draining must not
    // pin a transfer slot indefinitely.
    const timeout = setTimeout(() => {
      controller.abort();
      if (res.headersSent) res.destroy();
    }, 60_000);
    const abort = () => controller.abort();
    res.once('close', abort);
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const download = req.query.download === '1';
    try {
      let first = true;
      for await (const chunk of readSessionAttachment(req.user, { ...req.params, download }, controller.signal)) {
        if (first) {
          first = false;
          // Never serve uploaded HTML/SVG or a user-supplied Content-Type inline
          // on the authenticated application origin.
          const mime = download ? 'application/octet-stream' : detectImageMime(chunk.buffer);
          if (!mime) return res.status(415).send('Attachment is not a supported preview image');
          const filename = chunk.filename.split(/[/\\]/).pop() || 'attachment';
          res.setHeader('Content-Type', mime);
          res.setHeader('Content-Length', String(chunk.size));
          res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename.toWellFormed()).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`);
          if (req.method === 'HEAD') return res.end();
        }
        if (!await writeResponseChunk(res, chunk.buffer)) return;
      }
      res.end();
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else {
        res.removeHeader('Content-Length');
        res.removeHeader('Content-Disposition');
        res.status(error.status === 499 ? 504 : error.status || 502).send(error.status === 499 ? 'Attachment read timed out' : error.status ? error.message : 'Attachment read failed');
      }
    } finally {
      clearTimeout(timeout);
      res.off('close', abort);
    }
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
