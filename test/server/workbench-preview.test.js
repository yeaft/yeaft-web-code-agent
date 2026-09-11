import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const state = vi.hoisted(() => ({
  previewFiles: new Map(), pendingFiles: new Map(), agents: new Map(), webClients: new Map(),
  user: { id: 'user-1', role: 'pro', deletion_state: 'active' },
  accessError: null, generation: 'generation-1', outbound: [], supportsCorrelation: true,
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
  resolveWorkbenchRequest: () => ({ routeKey: 'route-1', conversationId: '_workbench:route-1', workDir: '/workspace' }),
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

describe('streaming Workbench video URLs', () => {
  const videoPath = '/workspace/video.mp4';
  const videoBytes = Buffer.alloc(WORKBENCH_VIDEO_CHUNK_BYTES * 2 + 17, 0x5a);
  const videoUrl = videoToken => `/api/preview/video-1?token=${encodeURIComponent(videoToken)}`;

  function videoSource() {
    const pending = {
      ...source,
      route: source.route,
    };
    const metadata = {
      filePath: videoPath, size: videoBytes.length, mtimeMs: 1234, mimeType: 'video/mp4',
    };
    return createWorkbenchVideo('video-1', pending, metadata);
  }

  async function replyVideoChunk() {
    const msg = state.outbound.at(-1);
    const content = videoBytes.subarray(msg.start, msg.end + 1);
    await handleAgentFileTerminal('agent-1', {}, {
      type: 'video_chunk', conversationId: msg.conversationId,
      _workbenchRequestId: msg._workbenchRequestId, filePath: videoPath,
      start: msg.start, end: msg.end, size: videoBytes.length, mtimeMs: 1234,
      mimeType: 'video/mp4', content: content.toString('base64'),
    });
  }

  it('parses bounded, open, and suffix ranges', () => {
    expect(parseByteRange('bytes=2-8', 10)).toEqual({ start: 2, end: 8 });
    expect(parseByteRange('bytes=4-', 10)).toEqual({ start: 4, end: 9 });
    expect(parseByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseByteRange('bytes=10-', 10)).toBe(false);
    expect(parseByteRange('bytes=1-2,4-5', 10)).toBe(false);
  });

  it('rejects video tokens after capability or workspace access is revoked', async () => {
    const videoToken = videoSource();
    state.agents.get('agent-1').capabilities = ['workbench_session_routes', 'workbench_request_correlation'];
    await request(app).get(videoUrl(videoToken)).set('Range', 'bytes=0-9').expect(410);
    expect(state.outbound).toHaveLength(0);

    state.agents.get('agent-1').capabilities.push('workbench_video_stream');
    state.generation = 'generation-2';
    await request(app).get(videoUrl(videoToken)).set('Range', 'bytes=0-9').expect(410);
    expect(state.outbound).toHaveLength(0);
  });

  it('serves HEAD metadata without reading video bytes from the Agent', async () => {
    const videoToken = videoSource();
    const response = await request(app).head(videoUrl(videoToken)).expect(200);
    expect(response.headers).toMatchObject({
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      'content-length': String(videoBytes.length),
    });
    expect(state.outbound).toHaveLength(0);
  });

  it('serves a video range through bounded Agent reads without caching the file', async () => {
    const videoToken = videoSource();
    const responsePromise = request(app).get(videoUrl(videoToken)).set('Range', 'bytes=3-1048581').then(res => res);
    await vi.waitFor(() => expect(state.outbound).toHaveLength(1));
    expect(state.outbound[0]).toMatchObject({
      type: 'video_chunk', filePath: videoPath, start: 3, end: 1048578,
      expectedSize: videoBytes.length, expectedMtimeMs: 1234,
    });
    await replyVideoChunk();
    await vi.waitFor(() => expect(state.outbound).toHaveLength(2));
    expect(state.outbound[1]).toMatchObject({ type: 'video_chunk', start: 1048579, end: 1048581 });
    await replyVideoChunk();
    const response = await responsePromise;
    expect(response.status).toBe(206);
    expect(response.headers).toMatchObject({
      'content-type': 'video/mp4', 'accept-ranges': 'bytes',
      'content-range': `bytes 3-1048581/${videoBytes.length}`,
      'content-length': String(1048579),
      'content-disposition': 'inline; filename="video.mp4"',
    });
    expect(response.body).toEqual(videoBytes.subarray(3, 1048582));
    expect(state.previewFiles.size).toBe(0);
  });

  it('streams downloads in chunks and rejects invalid ranges before contacting the Agent', async () => {
    const videoToken = videoSource();
    const rejected = await request(app).get(videoUrl(videoToken)).set('Range', 'bytes=9999999-').expect(416);
    expect(rejected.headers['content-range']).toBe(`bytes */${videoBytes.length}`);
    expect(state.outbound).toHaveLength(0);

    const responsePromise = request(app).get(`${videoUrl(videoToken)}&download=1`).then(res => res);
    for (let count = 1; count <= 3; count += 1) {
      await vi.waitFor(() => expect(state.outbound).toHaveLength(count));
      await replyVideoChunk();
    }
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="video.mp4"');
    expect(response.body).toEqual(videoBytes);
    expect(state.outbound.map(msg => msg.end - msg.start + 1))
      .toEqual([WORKBENCH_VIDEO_CHUNK_BYTES, WORKBENCH_VIDEO_CHUNK_BYTES, 17]);
  }, 20000);
});

describe('stable Workbench preview URLs', () => {
  it('serves the SAME HTTP URL after TTL eviction without a browser Session/socket', async () => {
    cachePreviewFile('file-1', { buffer: bytes, token, mimeType: 'image/png', filename: 'picture.png' });
    const first = await request(app).get(url()).expect(200);
    expect(first.body).toEqual(bytes);
    prunePreviewFiles(Date.now() + PREVIEW_FILE_TTL_MS + 1);
    expect(state.previewFiles.size).toBe(0);
    const second = request(app).get(url()).then(res => res);
    await vi.waitFor(() => expect(state.outbound).toHaveLength(1));
    expect(state.outbound[0]).toMatchObject({ filePath, workbenchRoute: source.route, workbenchWorkspaceGeneration: 'generation-1' });
    await reply();
    const response = await second;
    expect(response.status).toBe(200);
    expect(response.body).toEqual(bytes);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(state.webClients.size).toBe(0);
  });

  it('coalesces concurrent misses and reassembles correlated binary chunks', async () => {
    const first = readWorkbenchPreview('file-1', token);
    const second = readWorkbenchPreview('file-1', token);
    expect(state.outbound).toHaveLength(1);
    const chunk = Buffer.alloc(1024 * 1024, 1);
    const expected = Buffer.concat([chunk, Buffer.from('de')]);
    await reply({ type: 'file_content_chunk', chunkIndex: 0, chunkCount: 2, totalBytes: expected.length, content: chunk.toString('base64') });
    await reply({ type: 'file_content_chunk', chunkIndex: 1, chunkCount: 2, totalBytes: expected.length, content: Buffer.from('de').toString('base64') });
    expect((await first).buffer.equals(expected)).toBe(true);
    expect((await second).buffer.equals(expected)).toBe(true);
  });

  it('refills from a route-capable legacy Agent using unique public correlation', async () => {
    state.supportsCorrelation = false;
    const result = readWorkbenchPreview('file-1', token);
    const sent = state.outbound.at(-1);
    await reply({ _workbenchRequestId: undefined, _requestUserId: sent._requestUserId,
      _requestClientId: sent._requestClientId, requestId: sent.requestId });
    expect((await result).buffer).toEqual(bytes);
  });

  it('keeps the URL usable under cache capacity pressure', async () => {
    for (let i = 0; i < MAX_PREVIEW_CACHE_FILES; i++) cachePreviewFile(`other-${i}`, { buffer: Buffer.alloc(1) });
    const result = readWorkbenchPreview('file-1', token);
    await reply();
    expect((await result).buffer).toEqual(bytes);
    expect(state.previewFiles.size).toBe(MAX_PREVIEW_CACHE_FILES);
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

  it.each(['deleted-user', 'downgraded-role', 'owner', 'archived', 'cwd', 'offline'])('checks current access on cache hits: %s', async kind => {
    cachePreviewFile('file-1', { buffer: bytes, token });
    if (kind === 'deleted-user') state.user = null;
    if (kind === 'downgraded-role') state.user.role = 'user';
    if (kind === 'owner') state.accessError = 'Agent access denied';
    if (kind === 'archived') state.generation = null;
    if (kind === 'cwd') state.generation = 'generation-2';
    if (kind === 'offline') state.accessError = 'Agent not found or offline';
    await request(app).get(url()).expect(kind === 'offline' ? 503 : ['archived', 'cwd'].includes(kind) ? 410 : 403);
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

  it('reports a missing file and permits retry with the original URL', async () => {
    const result = readWorkbenchPreview('file-1', token);
    const rejected = expect(result).rejects.toMatchObject({ status: 404 });
    await reply({ error: 'File not found', errorCode: 'ENOENT', binary: false });
    await rejected;
    const retry = readWorkbenchPreview('file-1', token);
    await reply();
    expect((await retry).buffer).toEqual(bytes);
  });

  it('releases refill slots on Agent disconnect and retries the same URL after reconnect', async () => {
    for (let i = 0; i < 18; i++) {
      const result = readWorkbenchPreview('file-1', token);
      const rejected = expect(result).rejects.toMatchObject({ status: 503 });
      clearWorkbenchCorrelationsForAgent('agent-1');
      await rejected;
    }
    const retry = readWorkbenchPreview('file-1', token);
    await reply();
    expect((await retry).buffer).toEqual(bytes);
  });

  it('times out a read and ignores its late response', async () => {
    const result = readWorkbenchPreview('file-1', token);
    const rejected = expect(result).rejects.toMatchObject({ status: 504 });
    __testExpireWorkbenchRequest('agent-1', state.outbound[0]._workbenchRequestId);
    await reply(); // Correlation lookup prunes the expired request and invokes its timeout.
    await rejected;
    expect(state.previewFiles.size).toBe(0);
  });
});
