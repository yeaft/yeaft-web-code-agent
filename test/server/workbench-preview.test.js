import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

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
  it('checks current owner access even on preview cache hits', async () => {
    cachePreviewFile('file-1', { buffer: bytes, token });
    state.accessError = 'Agent access denied';
    await request(app).get(url()).expect(403);
    expect(state.outbound).toHaveLength(0);
  });

});
