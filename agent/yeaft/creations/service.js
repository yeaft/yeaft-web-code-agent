import { createCreationStore } from './store.js';
import { createCreationRunner } from './runner.js';
import { boundedText, fail, LIMITS } from './constants.js';

const object = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REQUEST', `Invalid ${name}`);
  return value;
};

export function createCreationService({ yeaftDir, store = createCreationStore({ yeaftDir }), emitEvent = () => {}, mediaUrlFor, engineFactory, bootId } = {}) {
  const publish = event => {
    try { Promise.resolve(emitEvent(event)).catch(() => {}); } catch { /* transport never rolls back writes */ }
  };
  let runner;
  try { runner = createCreationRunner({ store, yeaftDir, emitEvent: publish, mediaUrlFor, engineFactory, bootId }); }
  catch (error) { store.close(); throw error; }
  let closing = null;
  const emit = (type, creationId, fields) => publish({ type, creationId, ...fields });
  const media = (record, kind) => mediaUrlFor ? { ...record, url: mediaUrlFor(record.creationId, kind, record.id) } : record;
  function detail(id) {
    const creation = store.getCreation(id);
    const thread = store.getThread(id);
    const runs = store.listRuns(id).map(run => ({
      ...run,
      totalUnits: run.progress?.total ?? 0,
      completedUnits: run.progress?.completed ?? 0,
    }));
    return { creation, nodes: flatNodes(id), canon: store.listCanon(id),
      sources: store.listSources(id).map(source => media(source, 'source')),
      assets: store.listAssets(id).map(asset => media(asset, 'asset')), runs,
      thread, threads: store.listThreads(id), proposals: store.listProposals(id, { status: 'pending', includeContent: true, limit: 50 }) };
  }
  const flatNodes = id => store.listNodes(id).map(node => ({ ...node, sortOrder: node.position, isFolder: node.type === 'folder' }));
  const nodeResult = (id, node) => node.conflict ? node : { node, content: node.content, revisions: store.listRevisions(id, node.id) };
  function nodeChanged(id, node, type = 'node_content_updated') {
    if (!node.conflict) emit(type, id, { nodeId: node.id, node, ...(type === 'node_content_updated' ? { content: node.content, revisions: store.listRevisions(id, node.id) } : {}) });
    return node;
  }
  const ops = {
    list_creations: () => ({ creations: store.listCreations() }),
    create_creation: (_, input) => {
      const prompt = boundedText(input.prompt ?? '', LIMITS.promptBytes, 'creation prompt');
      const result = store.transaction(() => {
        const creation = store.createCreation({ ...input, mission: input.mission ?? prompt });
        const id = creation.id;
        const sources = store.addSources(id, input).map(source => media(source, 'source'));
        const thread = store.getThread(id);
        const starter = input.starterNode;
        if (starter != null && starter !== false) store.createNode(id, starter === true ? {} : object(starter, 'starter node'));
        return { creation: store.getCreation(id), nodes: flatNodes(id), sources, thread, threads: [thread] };
      });
      const { id } = result.creation;
      emit('creation_upserted', id, { creation: result.creation });
      if (prompt.trim() && input.autoPlan !== false) {
        try {
          result.initialTurn = runner.runThreadTurn({ creationId: id, threadId: result.thread.id, userText: prompt, model: input.model, effort: input.effort });
          result.creation = store.getCreation(id);
        } catch {
          // Creation is already durable. A retry must not create a duplicate.
          result.initialTurnError = 'Creation saved, but the planning turn could not start';
        }
      }
      return result;
    },
    get_creation: id => detail(id),
    update_creation: (id, p) => {
      const creation = store.updateCreation(id, p.patch == null ? p : object(p.patch, 'creation patch'));
      emit('creation_upserted', id, { creation });
      return { creation };
    },
    delete_creation: id => {
      const result = store.deleteCreation(id);
      emit('creation_deleted', id, result);
      return result;
    },
    add_sources: (id, p) => {
      const sources = store.addSources(id, p).map(source => media(source, 'source'));
      for (const source of sources) emit('source_added', id, { source });
      return { sources, creation: store.getCreation(id) };
    },
    get_source: (id, p) => ({ source: media(store.getSource(id, p.sourceId), 'source') }),
    delete_source: (id, p) => {
      const result = store.deleteSource(id, p.sourceId);
      emit('source_deleted', id, { sourceId: p.sourceId });
      return result;
    },
    upsert_canon: (id, p) => {
      const canon = store.upsertCanon(id, p.canon == null && p.item == null ? p : object(p.canon ?? p.item, 'canon item'));
      emit('canon_upserted', id, { canon });
      return { canon };
    },
    delete_canon: (id, p) => {
      const result = store.deleteCanon(id, p.canonId);
      emit('canon_deleted', id, { canonId: p.canonId });
      return result;
    },
    create_node: (id, p) => ({ node: nodeChanged(id, store.createNode(id, p.node == null ? p : object(p.node, 'node')), 'node_upserted') }),
    get_node: (id, p) => {
      const node = p.revId == null ? store.getNode(id, p.nodeId) : { ...store.getNode(id, p.nodeId),
        revision: store.getRevision(id, p.nodeId, p.revId) };
      const pendingProposals = store.listProposals(id, { status: 'pending', includeContent: true, limit: 50 })
        .filter(item => item.type === 'unit_edit' && item.nodeId === node.id);
      return { node, content: node.content, revisions: store.listRevisions(id, p.nodeId), pendingProposals };
    },
    update_node: (id, p) => {
      const patch = p.patch == null ? p : { ...(Object.hasOwn(p, 'baseRevId') ? { baseRevId: p.baseRevId } : {}), ...object(p.patch, 'node patch') };
      const node = nodeChanged(id, store.updateNode(id, p.nodeId, patch), Object.hasOwn(patch, 'content') ? 'node_content_updated' : 'node_upserted');
      return nodeResult(id, node);
    },
    reorder_nodes: (id, p) => {
      store.reorderNodes(id, p.parentId, p.nodeIds ?? p.orderedNodeIds ?? p.orderedIds);
      const nodes = flatNodes(id);
      emit('structure_updated', id, { nodes });
      return { nodes };
    },
    delete_node: (id, p) => {
      const result = store.deleteNode(id, p.nodeId);
      emit('node_deleted', id, { nodeId: p.nodeId, nodeIds: result.nodeIds });
      return result;
    },
    restore_revision: (id, p) => {
      const node = nodeChanged(id, store.restoreRevision(id, p.nodeId, p.revId ?? p.revisionId,
        Object.hasOwn(p, 'baseRevId') ? { baseRevId: p.baseRevId } : {}));
      return nodeResult(id, node);
    },
    list_proposals: (id, p) => ({ proposals: store.listProposals(id, { limit: 10, ...p }) }),
    resolve_proposal: (id, p) => {
      const result = store.resolveProposal(id, p.proposalId, { ...p, action: p.action ?? p.decision });
      if (!result.conflict && !result.unchanged) {
        if (result.node) nodeChanged(id, result.node);
        if (result.canon) emit('canon_upserted', id, { canon: result.canon });
        emit('proposal_resolved', id, { proposal: result.proposal });
      }
      return result;
    },
    get_thread: (id, p) => {
      const thread = store.getThread(id, p);
      const messages = store.listMessages(id, thread.id, p);
      const contextPreview = messages.findLast(message => message.contextMeta)?.contextMeta ?? null;
      return { thread, contextPreview, messages };
    },
    send_message: (id, p) => runner.runThreadTurn({ ...p, creationId: id, userText: p.userText ?? p.text ?? '' }),
    start_batch_run: (id, p) => ({ run: runner.startBatchRun({ ...p, creationId: id }) }),
    control_run: (id, p) => ({ run: runner.controlRun({ ...p, creationId: id }) }),
    export_creation: (id, p) => {
      const format = p.format ?? 'markdown';
      if (!['markdown', 'md', 'json'].includes(format)) fail('INVALID_REQUEST', 'Invalid export format');
      const creation = store.getCreation(id);
      const sources = store.listSources(id).map(source => media(source, 'source'));
      const assets = store.listAssets(id).map(asset => media(asset, 'asset'));
      const canon = store.listCanon(id);
      const nodes = store.getStructure(id, { includeContent: true });
      if (format === 'json') return { format: 'json', filename: `${id}.json`, mimeType: 'application/json',
        content: JSON.stringify({ version: 1, creation, nodes, canon, sources, assets }, null, 2) };
      return { format: 'markdown', filename: `${id}.md`, mimeType: 'text/markdown', content: exportMarkdown(creation, nodes) };
    },
  };

  return {
    store, runner,
    request({ op, payload = {} }) {
      if (closing) fail('INVALID_STATE', 'Creations is closed');
      if (typeof op !== 'string' || !Object.hasOwn(ops, op)) fail('UNSUPPORTED', 'Unknown Creations operation');
      object(payload, 'Creations payload');
      return boundedResponse(ops[op](payload.creationId ?? (op === 'create_creation' ? undefined : payload.id), payload));
    },
    handleMediaRead({ requestId, creationId, mediaKind, mediaId, start, end }) {
      if (closing) fail('INVALID_STATE', 'Creations is closed');
      const { bytes, ...info } = store.readMediaRange(creationId, mediaKind, mediaId, start, end);
      return { type: 'creation_media_chunk', requestId, creationId, mediaKind, mediaId, ok: true, ...info, data: bytes.toString('base64') };
    },
    close() { return closing ??= runner.close().finally(() => store.close()); },
  };
}

// Leave room for the WebSocket envelope and optional transport encryption.
function boundedResponse(value) {
  if (Buffer.byteLength(JSON.stringify(value)) > 5 * 1024 * 1024) {
    fail('LIMIT_EXCEEDED', 'Creation response exceeds the relay limit; list smaller pages or read units individually');
  }
  return value;
}

function exportMarkdown(creation, nodes) {
  const heading = value => value.replace(/[\r\n]+/g, ' ').trim();
  const lines = [`# ${heading(creation.title)}`];
  if (creation.description) lines.push(creation.description);
  function render(value, depth) {
    if (typeof value === 'string') { if (value.trim()) lines.push(value); return; }
    if (Array.isArray(value)) { for (const item of value) render(item, depth); return; }
    if (value && typeof value === 'object') {
      if (typeof value.title === 'string') lines.push(`${'#'.repeat(Math.min(depth, 6))} ${heading(value.title)}`);
      for (const [key, child] of Object.entries(value)) {
        if (key === 'title' && typeof child === 'string') continue;
        if (typeof child === 'boolean' || typeof child === 'number') lines.push(`**${heading(key)}:** ${child}`);
        else render(child, depth + 1);
      }
    }
  }
  function visit(tree, depth) {
    for (const node of tree) {
      lines.push(`${'#'.repeat(Math.min(depth, 6))} ${heading(node.title)}`);
      if (node.type === 'unit') render(node.hasReadableContent ? node.content : node.outlineMd, depth + 1);
      visit(node.children, depth + 1);
    }
  }
  visit(nodes, 2);
  return `${lines.join('\n\n')}\n`;
}
