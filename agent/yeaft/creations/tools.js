import { ToolRegistry } from '../tools/registry.js';
import { defineTool } from '../tools/types.js';
import { CANON_TYPES, LIMITS, fail, safeId } from './constants.js';
import { boundedList } from './store.js';

const string = { type: 'string' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const nullableId = { type: ['string', 'null'] };
const content = { type: ['string', 'object', 'array'] };
const anchor = { type: ['string', 'object'] };
const list = items => ({ type: 'array', items });
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const outline = schema({ id: string, parentId: nullableId, type: { type: 'string', enum: ['folder', 'unit'] },
  title: string, outlineMd: string, canonRefs: list(string) });
const unitArgs = { nodeId: string, baseRevId: nullableId, summary: string, anchor };

export function buildCreationToolRegistry({ store, creationId, emitEvent = () => {}, mediaUrlFor,
  assertActive = () => {}, batchNodeId = null, stageBatchWrite, stageBatchSummary } = {}) {
  safeId(creationId);
  const registry = new ToolRegistry();
  const emit = (type, fields) => emitEvent({ type, creationId, ...fields });
  const proposalResult = proposal => {
    emit('proposal_created', { proposal });
    return { proposal };
  };
  const add = (name, description, parameters, execute, readOnly = false) => registry.register(defineTool({
    name: `creation_${name}`, description, parameters, sideEffectScope: 'run', isReadOnly: () => readOnly,
    execute(input = {}, ctx) {
      ctx?.signal?.throwIfAborted();
      assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_REQUEST', 'Invalid Creation tool input');
      return JSON.stringify(execute(input));
    },
  }));
  add('list_structure', 'List this Creation’s ordered folders and units without prose.', schema({}),
    () => store.getStructure(creationId), true);
  add('read_source', 'Read up to twelve parsed source chunks by index.',
    schema({ sourceId: string, offset: integer, limit: integer }, ['sourceId']), ({ sourceId, offset = 0, limit = 8 }) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 12) fail('INVALID_REQUEST', 'Invalid source chunk range');
      const { parsed, chunks, ...source } = store.getSource(creationId, sourceId);
      return { ...source, chunks: chunks.slice(offset, offset + limit) };
    }, true);
  add('search_sources', 'Find relevant reference chunks in this Creation’s sources.', schema({ query: string, limit: integer }, ['query']),
    ({ query, limit }) => store.searchSources(creationId, query, { limit }), true);
  add('read_canon', 'Read one Canon item, recall by keyword, or list Canon titles.',
    schema({ canonId: string, query: string }), ({ canonId, query }) => canonId != null
      ? store.getCanon(creationId, canonId) ?? fail('NOT_FOUND', 'Canon item not found')
      : query ? store.recallCanon(creationId, query) : store.listCanon(creationId).map(({ id, title, type, pinned, lockedByUser }) => ({ id, title, type, pinned, lockedByUser })), true);
  add('propose_canon_patch', 'Propose a Canon change. autoApplyUnlocked only seeds a brand-new item; all existing items require review.',
    schema({ canonId: string, title: string, type: { type: 'string', enum: CANON_TYPES }, contentMd: string,
      pinned: boolean, state: { type: ['object', 'null'] }, summary: string, autoApplyUnlocked: boolean }), input => {
      const item = store.transaction(() => {
        const canonId = input.canonId ?? input.id;
        if (input.autoApplyUnlocked === true && (canonId == null || !store.getCanon(creationId, canonId))) {
          return { canon: store.upsertCanon(creationId, input, { actor: 'ai' }) };
        }
        return { proposal: store.proposeCanonPatch(creationId, input, { summary: input.summary }) };
      });
      if (item.canon) emit('canon_upserted', item);
      else emit('proposal_created', item);
      return item;
    });
  add('upsert_outlines', 'Create or update folders and unit outlines in order (parents before children). Existing prose and status are preserved.',
    schema({ nodes: list(outline) }, ['nodes']), input => {
      if (batchNodeId) fail('INVALID_STATE', 'Batch structure is fixed');
      const nodes = store.transaction(() => {
        const current = new Map(store.listNodes(creationId).map(node => [node.id, node]));
        return boundedList(input.nodes ?? input.outlines, 100, 'outlines').map(entry => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('INVALID_REQUEST', 'Invalid outline');
          const { id, nodeId, type, parentId, title, outlineMd, outline, canonRefs } = entry;
          const target = id ?? nodeId;
          const existing = target == null ? null : current.get(safeId(target));
          if (existing && ((type != null && type !== existing.type) || (parentId !== undefined && parentId !== existing.parentId))) {
            fail('INVALID_REQUEST', 'Cannot change node type or parent via outline tool');
          }
          const patch = Object.fromEntries(Object.entries({ title, outlineMd: outlineMd ?? outline, canonRefs }).filter(([, value]) => value !== undefined));
          const { content: _content, ...node } = existing
            ? store.updateNode(creationId, target, patch, { actor: 'ai' })
            : store.createNode(creationId, { id: target, type, parentId, ...patch }, { actor: 'ai' });
          current.set(node.id, node);
          return node;
        });
      });
      for (const node of nodes) emit('node_upserted', { node });
      return { nodes };
    });
  function requireBatchTarget(nodeId) {
    if (batchNodeId && batchNodeId !== nodeId) fail('INVALID_REQUEST', 'Batch can only edit its current unit');
  }
  add('write_unit', 'Write complete unit content. Final or user-edited units get review proposals instead of being overwritten.',
    schema({ ...unitArgs, content }, ['nodeId', 'content']), input => {
      const { nodeId } = input;
      requireBatchTarget(nodeId);
      if (stageBatchWrite) return stageBatchWrite(input);
      const result = store.transaction(() => {
        const node = store.getNode(creationId, nodeId);
        if (node.userEdited || node.status === 'final') return { proposal: store.proposeUnitEdit(creationId, nodeId, input) };
        const updated = store.updateNode(creationId, nodeId, { content: input.content,
          baseRevId: Object.hasOwn(input, 'baseRevId') ? input.baseRevId : node.currentRevId }, { actor: 'ai' });
        return updated.conflict ? updated : { node: updated };
      });
      if (result.node) emit('node_content_updated', { nodeId, node: result.node, content: result.node.content, revisions: store.listRevisions(creationId, nodeId) });
      if (result.proposal) emit('proposal_created', result);
      return result;
    });
  add('propose_unit_edit', 'Submit a reviewable replacement for a unit with an optional revision and anchor.',
    schema({ ...unitArgs, proposedContent: content }, ['nodeId', 'proposedContent']), input => {
      requireBatchTarget(input.nodeId);
      if (batchNodeId) fail('INVALID_STATE', 'Use creation_write_unit to draft the current batch unit');
      return proposalResult(store.proposeUnitEdit(creationId, input.nodeId, input));
    });
  add('update_unit_summary', 'Set a concise rolling continuity summary for a unit.',
    schema({ nodeId: string, summaryMd: string }, ['nodeId', 'summaryMd']), ({ nodeId, summaryMd }) => {
      requireBatchTarget(nodeId);
      if (stageBatchSummary) return stageBatchSummary(summaryMd);
      if (store.getNode(creationId, nodeId).type !== 'unit') fail('INVALID_REQUEST', 'Expected a unit');
      const { content: _content, ...node } = store.updateNode(creationId, nodeId, { summaryMd }, { actor: 'ai' });
      emit('node_upserted', { nodeId, node });
      return { node };
    });
  add('save_asset', 'Save a generated SVG or HTML string, or a base64 PNG, JPEG, GIF or WebP image.',
    schema({ ext: { type: 'string', enum: ['svg', 'html', 'png', 'jpg', 'jpeg', 'gif', 'webp'] }, content: string, base64: string }, ['ext']), input => {
      const asset = store.saveAsset(creationId, input);
      const ref = { ...asset, ...(mediaUrlFor ? { url: mediaUrlFor(creationId, 'asset', asset.id) } : {}) };
      emit('asset_saved', { asset: ref });
      return { asset: ref };
    });
  return registry;
}
