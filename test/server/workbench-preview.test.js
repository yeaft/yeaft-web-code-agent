import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import agentCtx from '../../agent/context.js';
import { handleReadFile } from '../../agent/workbench/file-ops.js';

const state = vi.hoisted(() => ({
  previewFiles: new Map(), pendingFiles: new Map(), agents: new Map(), webClients: new Map(),
  user: { id: 'user-1', role: 'pro', deletion_state: 'active' },
  accessError: null, generation: 'generation-1', outbound: [], supportsCorrelation: true, workDir: '/workspace',
}));
vi.mock('../../server/context.js', () => state);
vi.mock('../../server/config.js', () => ({ CONFIG: { jwtSecret: 'test-preview-secret', skipAuth: false } }));
vi.mock('../../server/db/user-db.js', () => ({ userDb: { get: () => state.user } }));
vi.mock('../../server/database.js', () => ({ userDb: {} }));
vi.mock('../../server/yeaft-asset-store.js', () => ({ yeaftAssetStore: {} }));
vi.mock('../../server/ws-utils.js', () => ({
  forwardToAgent: vi.fn(async (_agentId, msg) => { state.outbound.push(msg); return true; }),
  resolveAgentAccessError: () => state.accessError,
  sendToAgent: vi.fn(), sendToWebClient: vi.fn(),
  setCachedDir: vi.fn(), invalidateParentDirCache: vi.fn(), clearAgentDirCache: vi.fn(),
}));
vi.mock('../../server/workbench-route.js', () => ({
  currentWorkbenchWorkspaceGeneration: () => state.generation,
  resolveWorkbenchRequest: () => ({ routeKey: 'route-1', conversationId: '_workbench:route-1', workDir: state.workDir }),
  workbenchRouteKeyFromConversationId: id => id === '_workbench:route-1' ? 'route-1' : '',
  agentSupportsWorkbenchRequestCorrelation: () => state.supportsCorrelation,
  agentSupportsWorkbenchTerminalCleanupFence: () => true,
}));
const {
  createWorkbenchPreview, createWorkbenchVideo, readWorkbenchPreview, WORKBENCH_VIDEO_CHUNK_BYTES,
} = await import('../../server/workbench-preview.js');
const { parseByteRange, registerUploadRoutes } = await import('../../server/routes/upload-routes.js');
const { handleAgentFileTerminal } = await import('../../server/handlers/agent-file-terminal.js');
const { __testResetWorkbenchCorrelations, __testExpireWorkbenchRequest, clearWorkbenchCorrelationsForAgent } = await import('../../server/workbench-correlation.js');
const { __testResetFileContentAssemblies } = await import('../../server/file-content-assembly.js');
const { cachePreviewFile, prunePreviewFiles, PREVIEW_FILE_TTL_MS, MAX_PREVIEW_CACHE_FILES } = await import('../../server/preview-files.js');
const app = express();
registerUploadRoutes(app, { requireAuth: (_req, _res, next) => next() });
const source = {
  agentId: 'agent-1', userId: 'user-1', workspaceGeneration: 'generation-1',
  route: { runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-1' },
};
const filePath = '/workspace/picture.png';
const bytes = Buffer.from('original preview bytes');
let token;
const url = () => `/api/preview/file-1?token=${encodeURIComponent(token)}`;

// Encode the actual pre-purpose payload; the current mint function would add
// false and silently turn this into a new explicit-read capability.
function legacyToken(payload, prefix = 'wb1.') {
  const key = createHash('sha256').update('workbench-preview:test-preview-secret').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return prefix + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

async function replyFromAgent() {
  const previousSend = agentCtx.sendToServer;
  agentCtx.sendToServer = msg => handleAgentFileTerminal('agent-1', {}, msg);
  try {
    await handleReadFile(state.outbound.at(-1));
  } finally {
    agentCtx.sendToServer = previousSend;
  }
}

function reply(overrides = {}) {
  const msg = state.outbound.at(-1);
  return handleAgentFileTerminal('agent-1', {}, {
    type: 'file_content', conversationId: msg.conversationId, _workbenchRequestId: msg._workbenchRequestId,
    filePath, binary: true, mimeType: 'image/png', content: bytes.toString('base64'), ...overrides,
  });
}

beforeEach(() => {
  state.previewFiles.clear();
  state.agents.clear();
  state.outbound.length = 0;
  state.user = { id: 'user-1', role: 'pro', deletion_state: 'active' };
  state.accessError = null;
  state.supportsCorrelation = true;
  state.generation = 'generation-1';
  state.workDir = '/workspace';
  state.agents.set('agent-1', {
    capabilities: ['workbench_session_routes', 'workbench_request_correlation', 'workbench_video_stream'],
  });
  token = createWorkbenchPreview('file-1', source, filePath);
});
afterEach(() => {
  __testResetWorkbenchCorrelations();
  __testResetFileContentAssemblies();
  vi.restoreAllMocks();
});

describe('stable Workbench preview URLs', () => {
  it('rejects a real legacy token after the cwd symlink changes canonical workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-legacy-preview-'));
    const projectA = join(root, 'A');
    const projectB = join(root, 'B');
    const cwd = join(root, 'current');
    mkdirSync(projectA);
    mkdirSync(projectB);
    const image = join(projectA, 'image.png');
    writeFileSync(image, bytes);
    symlinkSync(projectA, cwd, 'junction');
    state.workDir = cwd;
    token = legacyToken({ ...source, fileId: 'file-1', filePath: image });
    // The route generation uses the unchanged cwd string, not its realpath.
    unlinkSync(cwd);
    symlinkSync(projectB, cwd, 'junction');
    try {
      const result = readWorkbenchPreview('file-1', token);
      const rejected = expect(result).rejects.toMatchObject({ status: 502, message: 'File is outside the active workspace.' });
      expect(state.outbound.at(-1)).toMatchObject({ workspaceBoundPreview: true, workDir: cwd });
      expect(state.outbound.at(-1).responseImagePreview).toBeUndefined();
      await replyFromAgent();
      await rejected;
      expect(state.previewFiles.size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves automatic response image confinement when refilling an evicted preview', async () => {
    token = createWorkbenchPreview('file-1', { ...source, responseImagePreview: true }, filePath);
    const result = readWorkbenchPreview('file-1', token);
    expect(state.outbound.at(-1)).toMatchObject({ type: 'read_file', responseImagePreview: true, filePath, workDir: '/workspace' });
    const rejected = expect(result).rejects.toMatchObject({ status: 502, message: 'Response image is outside the active workspace.' });
    await reply({ binary: false, content: '', error: 'Response image is outside the active workspace.', errorCode: 'FILE_OUTSIDE_WORKSPACE' });
    await rejected;
    expect(state.previewFiles.size).toBe(0);
  });

  it('rejects tampering, wrong file ids, and missing tokens without contacting the Agent', async () => {
    await request(app).get(`/api/preview/file-1?token=${token.slice(0, 20)}X${token.slice(21)}`).expect(403);
    await request(app).get(`/api/preview/other?token=${token}`).expect(403);
    cachePreviewFile('file-1', { buffer: bytes, token });
    await request(app).get('/api/preview/file-1').expect(403);
    expect(state.outbound).toHaveLength(0);
    expect(token).not.toContain(filePath);
    expect(token).not.toContain('user-1');
  });

  it('checks current owner access even on preview cache hits', async () => {
    cachePreviewFile('file-1', { buffer: bytes, token });
    state.accessError = 'Agent access denied';
    await request(app).get(url()).expect(403);
    expect(state.outbound).toHaveLength(0);
  });

  it('rejects permission revocation during a read without caching bytes', async () => {
    const result = readWorkbenchPreview('file-1', token);
    const rejected = expect(result).rejects.toMatchObject({ status: 403 });
    state.user.role = 'user';
    await reply();
    await rejected;
    expect(state.previewFiles.size).toBe(0);
  });
});

describe('Agent non-text reads', () => {
  it('preserves audio/binary bytes, accepts UTF-8 text and rejects binary over 100 MiB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-binary-read-'));
    const send = vi.fn();
    const previousSend = agentCtx.sendToServer;
    const previousServerCapabilities = agentCtx.serverCapabilities;
    const previousAgentCapabilities = agentCtx.agentCapabilities;
    agentCtx.sendToServer = send;
    const read = async (name, buffer, options = {}) => {
      writeFileSync(join(root, name), buffer);
      await handleReadFile({ conversationId: 'binary-test', filePath: join(root, name), workDir: root, requestId: name, ...options });
      return send.mock.lastCall[0];
    };
    try {
      expect(await read('音频.MP3', Buffer.from([255, 251, 144, 0]))).toMatchObject({ binary: true, mimeType: 'audio/mpeg', content: '//uQAA==' });
      expect(await read('legacy.doc', bytes)).toMatchObject({ binary: true, mimeType: 'application/msword' });
      expect(await read('archive.zip', bytes)).toMatchObject({ binary: true, mimeType: 'application/octet-stream' });
      expect(await read('unknown.custom', Buffer.from([65, 0, 66]))).toMatchObject({ binary: true, content: 'QQBC', mimeType: 'application/octet-stream' });
      expect(await read('invalid-utf8', Buffer.from([255, 254, 65]))).toMatchObject({ binary: true, mimeType: 'application/octet-stream' });
      expect(await read('README', Buffer.from('Unicode 中文\r\ntext\t👍'))).toMatchObject({ content: 'Unicode 中文\r\ntext\t👍' });
      expect(await read('download.txt', Buffer.from('Unicode 中文\r\ntext\t👍'), { download: true })).toMatchObject({ binary: true, mimeType: 'application/octet-stream', content: Buffer.from('Unicode 中文\r\ntext\t👍').toString('base64') });
      // A UTF-8 character crossing the prefix boundary must not become binary.
      const split = Buffer.from('a'.repeat(8191) + '中文');
      expect(await read('split', split)).toMatchObject({ content: split.toString('utf8') });
      const oversized = join(root, 'huge.custom');
      writeFileSync(oversized, Buffer.from([0]));
      truncateSync(oversized, 100 * 1024 * 1024 + 1);
      await handleReadFile({ conversationId: 'binary-test', filePath: oversized, workDir: root });
      expect(send.mock.lastCall[0]).toMatchObject({ errorCode: 'FILE_PREVIEW_TOO_LARGE', errorDetails: { limitBytes: 100 * 1024 * 1024 } });
      expect(send.mock.lastCall[0].binary).toBeUndefined();

      const automaticImage = join(root, 'automatic.png');
      writeFileSync(automaticImage, Buffer.from([0]));
      truncateSync(automaticImage, 20 * 1024 * 1024 + 1);
      await handleReadFile({ conversationId: 'binary-test', filePath: automaticImage, workDir: root, responseImagePreview: true });
      expect(send.mock.lastCall[0]).toMatchObject({ errorCode: 'FILE_PREVIEW_TOO_LARGE', errorDetails: { limitBytes: 20 * 1024 * 1024 } });

      // Exercise the real Agent -> chunk assembly -> cache refill -> HTTP download
      // at the inclusive limit (also crosses the old 20-chunk and 64 MiB limits).
      const maximum = join(root, 'maximum.txt');
      writeFileSync(maximum, Buffer.alloc(100 * 1024 * 1024, 0x61));
      state.workDir = root;
      token = createWorkbenchPreview('file-1', source, maximum);
      agentCtx.serverCapabilities = new Set(['workbench_file_content_chunks']);
      agentCtx.agentCapabilities = ['workbench_file_content_chunks'];
      let chunks = 0;
      agentCtx.sendToServer = msg => {
        expect(msg.type).toBe('file_content_chunk');
        expect(msg.chunkCount).toBe(100);
        chunks += 1;
        return handleAgentFileTerminal('agent-1', {}, msg);
      };
      const refill = readWorkbenchPreview('file-1', token);
      await handleReadFile(state.outbound.at(-1));
      const file = await refill;
      expect(chunks).toBe(100);
      expect(file.buffer.length).toBe(100 * 1024 * 1024);
      expect(file.buffer[0]).toBe(0x61);
      expect(file.buffer.at(-1)).toBe(0x61);
      const sourceHash = createHash('sha256');
      for await (const chunk of createReadStream(maximum)) sourceHash.update(chunk);
      const digest = sourceHash.digest('hex');
      expect(createHash('sha256').update(file.buffer).digest('hex')).toBe(digest);
      const download = await request(app).get(`${url()}&download=1`).buffer(true).parse((res, callback) => {
        const hash = createHash('sha256');
        let size = 0;
        res.on('data', chunk => { size += chunk.length; hash.update(chunk); });
        res.on('end', () => callback(null, { size, digest: hash.digest('hex') }));
        res.on('error', callback);
      }).expect(200);
      expect(download.headers['content-disposition']).toContain('attachment;');
      expect(download.body).toEqual({ size: 100 * 1024 * 1024, digest });
    } finally {
      agentCtx.sendToServer = previousSend;
      agentCtx.serverCapabilities = previousServerCapabilities;
      agentCtx.agentCapabilities = previousAgentCapabilities;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
