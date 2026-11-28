export const MODALITY_BY_KIND = Object.freeze({
  book: 'markdown_doc', deck: 'slide_deck', gallery: 'image_gallery', video: 'video_episode',
});
export const CREATION_KINDS = Object.freeze(Object.keys(MODALITY_BY_KIND));
export const MODALITIES = Object.freeze(Object.values(MODALITY_BY_KIND));
export const CANON_TYPES = Object.freeze(['world', 'entity', 'ledger', 'rule']);
export const CREATION_STATUSES = Object.freeze(['seed', 'draft', 'active', 'needs_attention', 'archived']);
export const NODE_STATUSES = Object.freeze(['outline', 'draft', 'final']);
export const RUN_STATUSES = Object.freeze(['running', 'paused', 'completed', 'failed', 'cancelled']);
export const PROPOSAL_STATUSES = Object.freeze(['pending', 'accepted', 'rejected']);
export const LIMITS = Object.freeze({
  sourceBytes: 25 * 1024 * 1024, sourceBatchBytes: 50 * 1024 * 1024, sources: 64,
  parsedChars: 120_000, chunkChars: 2000, assetBytes: 8 * 1024 * 1024, assets: 256,
  nodeBytes: 512 * 1024, nodes: 500, treeDepth: 12, canon: 500, proposalCount: 1000,
  mediaRangeBytes: 1024 * 1024, promptBytes: 32 * 1024, responseChars: 256 * 1024,
  batchNodes: 100, threadHistory: 12, turnTimeoutMs: 10 * 60 * 1000,
});

export function defaultCelestialPlacement(kind, index = 0) {
  const arm = Math.max(0, CREATION_KINDS.indexOf(kind));
  const radius = 1.25 + 0.35 * Math.sqrt(index);
  const angle = arm * Math.PI / 2 + 0.75 * radius + index * 0.31;
  const r = Math.min(0.76, 0.30 + (index % 5) * 0.105);
  const theta = (arm * Math.PI) / 2 + 0.68 + index * 0.43;
  return { arm, r, theta, radius, angle, x: radius * Math.cos(angle), y: radius * Math.sin(angle), z: 0 };
}

export function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function safeId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value)) {
    fail('INVALID_REQUEST', 'Invalid Creations identifier');
  }
  return value;
}

export function boundedText(value, max, name, { required = false } = {}) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || (required && !value.trim())) {
    fail('INVALID_REQUEST', `Invalid ${name}`);
  }
  return value;
}

export function decodeBase64(value, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || value.length % 4 === 1
    || /[^A-Za-z0-9+/=]/.test(value) || /=/.test(value.replace(/={1,2}$/, ''))
    || (value.includes('=') && value.length % 4 !== 0)) fail('INVALID_REQUEST', 'Invalid base64 payload');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > max) fail('LIMIT_EXCEEDED', 'Payload is too large');
  return bytes;
}

export { CREATION_CATEGORIES, DEFAULT_KIND_BY_CATEGORY, DOC_WORKFLOW_STATUSES, inferCategoryFromKind, normalizeCategory } from './categories.js';
