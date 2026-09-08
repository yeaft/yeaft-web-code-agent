import { MAX_PREVIEW_FILE_BYTES } from './preview-files.js';

const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_ASSEMBLIES = 64;
const MAX_ASSEMBLY_BYTES = 64 * 1024 * 1024;
const ASSEMBLY_TTL_MS = 2 * 60 * 1000;
const assemblies = new Map();
let assemblyBytes = 0;

function key(agentId, requestId) {
  return `${String(agentId)}\u0000${String(requestId)}`;
}

function remove(keyValue) {
  const existing = assemblies.get(keyValue);
  if (!existing) return;
  if (existing.timeout) clearTimeout(existing.timeout);
  assemblyBytes = Math.max(0, assemblyBytes - existing.receivedBytes);
  assemblies.delete(keyValue);
}

function invalid(keyValue, status = 'invalid') {
  remove(keyValue);
  return { status };
}

function prune(now = Date.now()) {
  for (const [keyValue, assembly] of assemblies) {
    if (assembly.expiresAt <= now) remove(keyValue);
  }
}

function decodeChunk(content) {
  if (typeof content !== 'string' || content.length === 0 || content.length > 1_398_104) return null;
  if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) return null;
  const buffer = Buffer.from(content, 'base64');
  if (buffer.length === 0 || buffer.length > MAX_CHUNK_BYTES) return null;
  if (buffer.toString('base64') !== content) return null;
  return buffer;
}

export function appendFileContentChunk(agentId, msg) {
  prune();
  const requestId = msg?._workbenchRequestId;
  const chunkIndex = Number(msg?.chunkIndex);
  const chunkCount = Number(msg?.chunkCount);
  const totalBytes = Number(msg?.totalBytes);
  if (!agentId || !requestId
      || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0
      || !Number.isSafeInteger(chunkCount) || chunkCount < 2 || chunkCount > 20
      || !Number.isSafeInteger(totalBytes) || totalBytes <= MAX_CHUNK_BYTES
      || totalBytes > MAX_PREVIEW_FILE_BYTES
      || chunkIndex >= chunkCount) return { status: 'invalid' };
  const buffer = decodeChunk(msg.content);
  if (!buffer) return { status: 'invalid' };
  const expectedCount = Math.ceil(totalBytes / MAX_CHUNK_BYTES);
  const expectedBytes = chunkIndex === chunkCount - 1
    ? totalBytes - (chunkCount - 1) * MAX_CHUNK_BYTES
    : MAX_CHUNK_BYTES;
  if (chunkCount !== expectedCount || buffer.length !== expectedBytes) return { status: 'invalid' };

  const keyValue = key(agentId, requestId);
  let assembly = assemblies.get(keyValue);
  if (!assembly) {
    if (chunkIndex !== 0) return { status: 'out_of_order' };
    if (assemblies.size >= MAX_ASSEMBLIES || assemblyBytes + buffer.length > MAX_ASSEMBLY_BYTES) {
      return { status: 'capacity' };
    }
    assembly = {
      chunkCount,
      totalBytes,
      mimeType: msg.mimeType,
      filePath: msg.filePath,
      requestedFilePath: msg.requestedFilePath,
      conversationId: msg.conversationId,
      routeKey: msg.workbenchRouteKey,
      workspaceGeneration: msg.workbenchWorkspaceGeneration,
      nextIndex: 0,
      receivedBytes: 0,
      chunks: [],
      expiresAt: Date.now() + ASSEMBLY_TTL_MS,
      timeout: null,
    };
    assembly.timeout = setTimeout(() => remove(keyValue), ASSEMBLY_TTL_MS);
    assembly.timeout.unref?.();
    assemblies.set(keyValue, assembly);
  }
  if (assembly.nextIndex !== chunkIndex) return invalid(keyValue, 'out_of_order');
  if (assembly.chunkCount !== chunkCount || assembly.totalBytes !== totalBytes
      || assembly.mimeType !== msg.mimeType || assembly.filePath !== msg.filePath
      || assembly.requestedFilePath !== msg.requestedFilePath
      || assembly.conversationId !== msg.conversationId || assembly.routeKey !== msg.workbenchRouteKey
      || assembly.workspaceGeneration !== msg.workbenchWorkspaceGeneration) {
    return invalid(keyValue);
  }
  if (assemblyBytes + buffer.length > MAX_ASSEMBLY_BYTES) return invalid(keyValue, 'capacity');

  assembly.chunks.push(buffer);
  assembly.nextIndex += 1;
  assembly.receivedBytes += buffer.length;
  assemblyBytes += buffer.length;
  assembly.expiresAt = Date.now() + ASSEMBLY_TTL_MS;
  if (assembly.timeout) clearTimeout(assembly.timeout);
  assembly.timeout = setTimeout(() => remove(keyValue), ASSEMBLY_TTL_MS);
  assembly.timeout.unref?.();
  if (assembly.nextIndex !== assembly.chunkCount) return { status: 'pending' };
  if (assembly.receivedBytes !== assembly.totalBytes) {
    remove(keyValue);
    return { status: 'invalid' };
  }
  const completed = Buffer.concat(assembly.chunks, assembly.totalBytes);
  remove(keyValue);
  return { status: 'complete', buffer: completed };
}

export function discardFileContentAssembly(agentId, requestId) {
  remove(key(agentId, requestId));
}

export function clearFileContentAssembliesForAgent(agentId) {
  const prefix = `${String(agentId)}\u0000`;
  for (const keyValue of assemblies.keys()) {
    if (keyValue.startsWith(prefix)) remove(keyValue);
  }
}

export function __testResetFileContentAssemblies() {
  assemblies.clear();
  assemblyBytes = 0;
}
