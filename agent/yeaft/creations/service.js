import { compactProposal, createCreationStore } from './store.js';
import { createCreationRunner } from './runner.js';
import { readMediaChunk } from './media.js';
import { boundedText, fail, LIMITS } from './constants.js';

const object = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REQUEST', `Invalid ${name}`);
  return value;
};

export function createCreationService({ yeaftDir, storageRoot, namespaceKey, namespaceBinding,
  store = createCreationStore({ yeaftDir, storageRoot, namespaceKey, namespaceBinding }), emitEvent = () => {}, mediaUrlFor, engineFactory, bootId } = {}) {
  const publish = event => {
    try { Promise.resolve(emitEvent(event)).catch(() => {}); } catch { /* transport never rolls back writes */ }
  };
  let runner;
  try { runner = createCreationRunner({ store, yeaftDir, emitEvent: publish, mediaUrlFor, engineFactory, bootId }); }
  catch (error) { store.close(); throw error; }
  let closing = null;
  const emit = (type, creationId, fields) => publish({ type, creationId, ...fields });
  const summaryChanged = id => emit('creation_upserted', id, { creation: store.getCreation(id) });
  const media = (record, kind) => mediaUrlFor ? { ...record, url: mediaUrlFor(record.creationId, kind, record.id) } : record;
  function detail(id) {
    const creation = store.getCreation(id);
    const thread = store.getThread(id);
    let runs = store.listRuns(id).map(run => ({
      ...run,
      totalUnits: run.progress?.total ?? 0,
      completedUnits: run.progress?.completed ?? 0,
    }));
    if (responseBytes(runs) > 256 * 1024) {
      // Preserve every run's status and progress without embedding batch plans.
      runs = runs.map(({ instruction, nodeIds, completedNodeIds, ...run }) => ({
        ...run, ...(nodeIds ? { planTruncated: true } : {}),
      }));
    }
    let { proposals } = store.listProposals(id, { status: 'pending', includeContent: false, limit: 50 });
    if (responseBytes(proposals) > 512 * 1024) {
      proposals = proposals.map(proposal => previewText(previewText(proposal, 'summary', 'summaryTruncated', 512), 'preview', 'previewTruncated', 512));
    }
    return { creation, nodes: outlineNodes(id), canon: snapshotCanon(store.listCanon(id)),
      sources: store.listSources(id).map(source => media(source, 'source')),
      assets: store.listAssets(id).map(asset => media(asset, 'asset')), runs,
      thread, threads: store.listThreads(id), proposals };
  }
  const outlineNodes = id => {
    const nodes = store.listNodes(id).map(node => previewText(node, 'outlineMd', 'outlineTruncated'));
    if (responseBytes(nodes) <= 1024 * 1024) return nodes;
    // Long summaries, many references, or heavily escaped text can also bloat a snapshot.
    return nodes.map(({ canonRefs, ...node }) => ({
      ...previewText(previewText(previewText(node, 'outlineMd', 'outlineTruncated', 128), 'summaryMd', 'summaryTruncated', 64), 'title', 'titleTruncated', 64),
      canonRefs: canonRefs.slice(0, 4), ...(canonRefs.length > 4 ? { canonRefsTruncated: true } : {}),
    }));
  };
  const nodeResult = (id, node) => {
    if (node.conflict) return node;
    const { content, ...metadata } = node;
    const revisions = store.listRevisions(id, node.id);
    // Keep both legacy content fields unless JSON escaping would duplicate a huge body.
    return { node: Buffer.byteLength(JSON.stringify(content)) > 1.5 * 1024 * 1024 ? metadata : node, content, revisions };
  };
  function nodeChanged(id, node, type = 'node_content_updated') {
    if (!node.conflict) emit(type, id, { nodeId: node.id, ...(type === 'node_content_updated' ? nodeResult(id, node) : { node }) });
    return node;
  }
  const ops = {
    list_creations: () => ({ creations: store.listCreations() }),
    create_creation: (_, input) => {
      const prompt = input.prompt ?? '';
      const result = store.transaction(() => {
        const creation = store.createCreation({ ...input, mission: input.mission ?? prompt });
        const id = creation.id;
        if (creation.deduplicated) return { ...detail(id), deduplicated: true };
        boundedText(prompt, LIMITS.promptBytes, 'creation prompt');
        const sources = store.addSources(id, input, { copyToWorkspace: input.initializeFolder === true }).map(source => media(source, 'source'));
        const thread = store.getThread(id);
        const starter = input.starterNode;
        if (starter != null && starter !== false) store.createNode(id, starter === true ? {} : object(starter, 'starter node'));
        return { creation: store.getCreation(id), nodes: outlineNodes(id), sources, thread, threads: [thread] };
      });
      if (result.deduplicated) return result;
      const { id } = result.creation;
      emit('creation_upserted', id, { creation: result.creation });
      const autoPlan = input.initializeFolder === true ? input.autoPlan === true : input.autoPlan !== false;
      if (prompt.trim() && autoPlan) {
        try {
          result.initialTurn = runner.runThreadTurn({ creationId: id, threadId: result.thread.id, userText: prompt, attachedSourceIds: result.sources.map(source => source.id), model: input.model, effort: input.effort });
          result.creation = store.getCreation(id);
        } catch {
          // Creation is already durable. A retry must not create a duplicate.
          result.initialTurnError = 'Creation saved, but the planning turn could not start';
        }
      }
      return result;
    },
    get_creation: id => detail(id),
    ensure_workspace: (id, { rootDir }) => {
      const result = store.ensureWorkspace(id, { rootDir });
      if (result.materialized) emit('creation_upserted', id, { creation: result.creation });
      return result;
    },
    find_by_folder: (_, { rootDir }) => store.findByFolder(rootDir),
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
      if (sources.length) summaryChanged(id);
      return { sources, creation: store.getCreation(id) };
    },
    get_source: (id, p) => ({ source: media(store.getSource(id, p.sourceId), 'source') }),
    delete_source: (id, p) => {
      const result = store.deleteSource(id, p.sourceId);
      emit('source_deleted', id, { sourceId: p.sourceId });
      summaryChanged(id);
      return result;
    },
    get_canon: (id, p) => ({ canon: store.getCanon(id, p.canonId) ?? fail('NOT_FOUND', 'Canon item not found') }),
    upsert_canon: (id, p) => {
      const canon = store.upsertCanon(id, p.canon == null && p.item == null ? p : object(p.canon ?? p.item, 'canon item'));
      emit('canon_upserted', id, { canon });
      summaryChanged(id);
      return { canon };
    },
    delete_canon: (id, p) => {
      const result = store.deleteCanon(id, p.canonId);
      emit('canon_deleted', id, { canonId: p.canonId });
      summaryChanged(id);
      return result;
    },
    create_node: (id, p) => {
      const node = nodeChanged(id, store.createNode(id, p.node == null ? p : object(p.node, 'node')), 'node_upserted');
      summaryChanged(id);
      return { node };
    },
    get_node: (id, p) => {
      const node = store.getNode(id, p.nodeId);
      const { proposals: pendingProposals } = store.listProposals(id, { status: 'pending', nodeId: node.id, includeContent: true, limit: 50 });
      const result = { ...nodeResult(id, node), pendingProposals };
      if (p.revId != null) {
        const revision = store.getRevision(id, p.nodeId, p.revId);
        result.node = { ...result.node, revision };
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE_BYTES) {
          // The requested revision body takes precedence over a second copy of live prose.
          delete result.node.content;
          delete result.content;
        }
      }
      return result;
    },
    update_node: (id, p) => {
      const patch = p.patch == null ? p : { ...(Object.hasOwn(p, 'baseRevId') ? { baseRevId: p.baseRevId } : {}), ...object(p.patch, 'node patch') };
      const node = nodeChanged(id, store.updateNode(id, p.nodeId, patch), Object.hasOwn(patch, 'content') ? 'node_content_updated' : 'node_upserted');
      if (!node.conflict) summaryChanged(id);
      return nodeResult(id, node);
    },
    reorder_nodes: (id, p) => {
      store.reorderNodes(id, p.parentId, p.nodeIds ?? p.orderedNodeIds ?? p.orderedIds);
      const nodes = outlineNodes(id);
      emit('structure_updated', id, { nodes });
      summaryChanged(id);
      return { nodes };
    },
    delete_node: (id, p) => {
      const result = store.deleteNode(id, p.nodeId);
      emit('node_deleted', id, { nodeId: p.nodeId, nodeIds: result.nodeIds });
      summaryChanged(id);
      return result;
    },
    restore_revision: (id, p) => {
      const node = nodeChanged(id, store.restoreRevision(id, p.nodeId, p.revId ?? p.revisionId,
        Object.hasOwn(p, 'baseRevId') ? { baseRevId: p.baseRevId } : {}));
      if (!node.conflict) summaryChanged(id);
      return nodeResult(id, node);
    },
    get_proposal: (id, p) => ({ proposal: store.getProposal(id, p.proposalId) }),
    list_proposals: (id, p) => store.listProposals(id, { limit: 10, ...p }),
    resolve_proposal: (id, p) => {
      const result = store.resolveProposal(id, p.proposalId, { ...p, action: p.action ?? p.decision });
      if (!result.conflict && !result.unchanged) {
        if (result.node) nodeChanged(id, result.node);
        if (result.canon) emit('canon_upserted', id, { canon: result.canon });
        emit('proposal_resolved', id, { proposal: compactProposal(result.proposal) });
        summaryChanged(id);
      }
      if (result.node) {
        const revisions = store.listRevisions(id, result.node.id);
        const response = { ...result, revisions };
        return Buffer.byteLength(JSON.stringify(response)) <= MAX_RESPONSE_BYTES
          ? response : { ...response, proposal: compactProposal(result.proposal) };
      }
      return result;
    },
    get_thread: (id, p) => {
      const thread = store.getThread(id, p);
      const page = store.pageMessages(id, thread.id, p);
      const contextPreview = page.messages.findLast(message => message.contextMeta)?.contextMeta ?? null;
      return { thread, ...page, contextPreview };
    },
    send_message: (id, p) => runner.runThreadTurn({ ...p, creationId: id, userText: p.userText ?? p.text ?? '' }),
    start_batch_run: (id, p) => ({ run: runner.startBatchRun({ ...p, creationId: id }) }),
    control_run: (id, p) => ({ run: runner.controlRun({ ...p, creationId: id }) }),
    export_creation: (id, p) => {
      const format = p.format ?? 'markdown';
      if (!['markdown', 'md', 'json'].includes(format)) fail('INVALID_REQUEST', 'Invalid export format');
      const creation = store.getCreation(id);
      const sources = store.listSources(id).map(source => media(source, 'source'));
      const assets = store.listAssets(id).filter(asset => asset.id !== 'export-markdown' && asset.id !== 'export-json')
        .map(asset => media(asset, 'asset'));
      const canon = store.listCanon(id);
      const nodes = store.getStructure(id, { includeContent: true });
      const ext = format === 'json' ? 'json' : 'md';
      const content = ext === 'json' ? JSON.stringify({ version: 1, creation, nodes, canon, sources, assets }, null, 2)
        : exportMarkdown(creation, nodes);
      const meta = { format: ext === 'json' ? 'json' : 'markdown', filename: `${id}.${ext}`,
        mimeType: ext === 'json' ? 'application/json' : 'text/markdown' };
      const byteLength = Buffer.byteLength(content);
      const inline = { ...meta, content };
      const maxInlineBytes = 3 * 1024 * 1024;
      if (byteLength <= maxInlineBytes && Buffer.byteLength(JSON.stringify(inline)) <= maxInlineBytes) return inline;
      const asset = store.saveAsset(id, { ext, bytes: Buffer.from(content) }, { exportFile: true });
      return { ...meta, streamed: true, assetId: asset.id, downloadUrl: mediaUrlFor?.(id, 'asset', asset.id), byteLength };
    },
  };

  return {
    store, runner,
    hasActiveWork: () => runner.hasActiveWork(),
    request({ op, payload = {} }) {
      if (closing) fail('INVALID_STATE', 'Creations is closed');
      if (typeof op !== 'string' || !Object.hasOwn(ops, op)) fail('UNSUPPORTED', 'Unknown Creations operation');
      object(payload, 'Creations payload');
      return boundedResponse(ops[op](payload.creationId ?? (op === 'create_creation' ? undefined : payload.id), payload));
    },
    handleMediaRead(msg) {
      if (closing) fail('INVALID_STATE', 'Creations is closed');
      return readMediaChunk(store, msg);
    },
    close() { return closing ??= runner.close().finally(() => store.close()); },
  };
}

// Leave room for the WebSocket envelope and optional transport encryption.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const responseBytes = value => Buffer.byteLength(JSON.stringify(value));
function previewText(record, key, flag, limit = 512) {
  const value = record[key];
  return typeof value === 'string' && value.length > limit
    ? { ...record, [key]: value.slice(0, limit).toWellFormed(), [flag]: true }
    : record;
}
function snapshotCanon(items) {
  if (responseBytes(items) <= 256 * 1024) return items;
  const previews = items.map(item => previewText(item, 'contentMd', 'contentTruncated'));
  if (responseBytes(previews) <= 1024 * 1024) return previews;
  return previews.map(({ state, ...item }) => ({
    ...previewText(previewText(item, 'contentMd', 'contentTruncated', 128), 'title', 'titleTruncated', 64),
    ...(state === undefined ? {} : { stateTruncated: true }),
  }));
}
function boundedResponse(value) {
  if (responseBytes(value) > MAX_RESPONSE_BYTES) {
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
