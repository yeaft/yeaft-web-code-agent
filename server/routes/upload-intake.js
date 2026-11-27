import multer from 'multer';
import { CONFIG } from '../config.js';
import { userDb } from '../database.js';
import { pendingFiles } from '../context.js';

const intake = Symbol('upload intake');
const MULTIPART_OVERHEAD_ALLOWANCE = 64 * 1024;
const sizeError = () => new multer.MulterError('LIMIT_FILE_SIZE');

const upload = multer({
  limits: { fileSize: CONFIG.maxFileSize, files: 10, fields: 10, fieldSize: 4096 },
  storage: {
    _handleFile(req, file, callback) {
      const state = req[intake];
      const { stream } = file;
      const chunks = [];
      let size = 0;
      let settled = false;
      const body = {};
      const release = () => {
        pendingFiles.release(state.userId, size);
        size = 0;
        chunks.length = 0;
        delete body.buffer;
        stream.off('data', onData);
        state.releases.delete(release);
      };
      const onData = chunk => {
        if (pendingFiles.reserve(state.userId, chunk.length, state.perUserBytes, state.globalBytes)) {
          size += chunk.length;
          chunks.push(chunk);
          return;
        }
        state.releaseAll();
        // Stop parsing/retaining the multipart body now. Multer itself drains
        // the remaining input before invoking next(error), so respond here.
        settled = true;
        callback(sizeError());
        state.rejectTooLarge();
      };
      state.releases.add(release);
      stream.on('data', onData);
      stream.once('limit', () => {
        if (settled) return;
        state.releaseAll();
        settled = true;
        callback(sizeError());
        state.rejectTooLarge();
      });
      // Multer handles the stream error and settles its pending-write counter.
      stream.once('error', () => {
        settled = true;
        state.releaseAll();
      });
      stream.once('end', () => {
        if (settled) return;
        settled = true;
        if (!state.releases.has(release)) return callback(sizeError());
        body.buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
        chunks.length = 0;
        callback(null, { body, size, release });
      });
    },
    _removeFile(_req, file, callback) {
      file.release?.();
      callback(null);
    },
  },
}).array('files', 10);

export function readPendingUploads(req, res, next) {
  const userId = userDb.getOrCreate(req.user.username).id;
  const perUserBytes = CONFIG.maxPendingUploadBytesPerUser ?? 100 * 1024 * 1024;
  const globalBytes = CONFIG.maxPendingUploadBytes ?? 256 * 1024 * 1024;
  const releases = new Set();
  const releaseAll = () => { for (const release of releases) release(); };
  const rejectTooLarge = () => {
    if (res.headersSent || res.destroyed) return;
    res.setHeader('Connection', 'close');
    res.status(413).json({ error: 'Payload Too Large' });
  };
  const length = Number(req.headers['content-length']);
  // Content-Length includes framing and fields. Near the limit, rely on
  // exact file bytes instead of charging the multipart envelope to the user.
  if (length > Math.max(0, pendingFiles.available(userId, perUserBytes, globalBytes)) + MULTIPART_OVERHEAD_ALLOWANCE) {
    return rejectTooLarge();
  }
  req[intake] = { userId, perUserBytes, globalBytes, releases, releaseAll, rejectTooLarge };
  const onClose = () => { if (!req.complete) releaseAll(); };
  req.once('close', onClose);
  req.once('error', releaseAll);
  req.once('aborted', releaseAll);
  upload(req, res, err => {
    req.off('close', onClose);
    req.off('error', releaseAll);
    req.off('aborted', releaseAll);
    if (err || res.headersSent || res.destroyed) {
      releaseAll();
      if (res.headersSent || res.destroyed) return;
      if (err.code === 'LIMIT_FILE_SIZE') return rejectTooLarge();
      return next(err);
    }
    req.uploadUserId = userId;
    next();
  });
}
