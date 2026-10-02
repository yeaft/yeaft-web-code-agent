import { bytes, digest, fail, identifier, object, page, text } from './contracts.js';
import { validateCreatedDefinition } from './created-capability-contract.js';
import { runPersonScript, scriptInput, testPersonScript } from './script-executor.js';

// Built-in cognition plus bounded pure-script creation, not the Agent's full registry.
// No shell/filesystem/network/VP authority is exposed to generated code.
const entries = [
  { id: 'Think', version: 1, domain: 'cognition', description: 'Intrinsic deliberate reflection, reorganization, association and reconsideration.', keywords: '思考 整理 反思 think reflection', useWhen: 'Think with the evidence already present, or rest when nothing warrants further work.', avoidWhen: 'Do not invent evidence or call a tool merely to appear thoughtful.', instructions: 'Revisit supplied experiences and current judgments; separate report from hypothesis, propose new concepts or associations, test a counterexample, and record the explicit finding with uncertainty. It is fine to rest. This is a method, not another model call or external action.', args: {} },
  { id: 'Recall', version: 1, domain: 'memory', description: 'Recall a bounded page of your own long-term messages or concepts.', keywords: '回忆 记忆 召回 历史 查找 搜索 memory recall history search', useWhen: 'Missing prior words, experiences or concepts could change your present understanding.', avoidWhen: 'Current evidence is sufficient; a similar memory cannot grant permission or establish truth.', instructions: 'args: {kind:"messages"|"concepts",query?:string,cursor?:string|null,limit?:1..5}. SQLite uses local hybrid keyword/semantic recall when available; inspect retrieval mode, coverage and degradation. Legacy storage may use literal matching. Results are not exhaustive or authorization. Preserve nextCursor for the same query; local ranking cursors expire after 5 minutes or restart.', args: { kind: 'messages|concepts', query: 'optional memory search text', cursor: 'optional opaque cursor', limit: '1..5' } },
  { id: 'Capability.create', version: 1, domain: 'creation', description: 'Create or revise a reusable pure JavaScript capability; execute tests before publishing to your private catalog.', keywords: '创造 创建 固化 脚本 编程 学会 create script learn capability', useWhen: 'A reusable JSON data transformation or calculation is missing. Write a small script and concrete examples, including edge cases; successful tests publish it automatically.', avoidWhen: 'Do not save one-off constants, secrets, unnecessary duplicates, external actions or assumptions as verified facts. Tests you wrote are limited evidence, not proof of general correctness.', instructions: 'args: {id:"Script.<slug>",expectedVersion:0 for new or current version,description,useWhen,avoidWhen,inputDescription,outputDescription,code,tests:[{input:JSON,expected:JSON}]}. slug: lowercase letter followed by up to 47 lowercase letters/digits/hyphens. Metadata <=400 UTF-8 bytes each; code <=8192; total args <=24576; 1..8 tests with each input/expected <=4096 bytes. code is a synchronous function body receiving input and returning JSON. QuickJS only: no Node, imports, filesystem, network, shell, credentials or host tools. Runtime runs each test in a fresh limited VM; failure returns diagnostics without publishing, so you may revise within the remaining calls. Passing tests atomically publish an immutable version, independently of final cognitive commit; cancelling later does not undo a completed publication. Result prepares the capability for next call. Invoke it via its ID with {input:JSON}; no model generates its result. Search for existing capabilities before creating duplicates when uncertain. To revise, catalog.view returns saved definition. Preserve useful tests. Up to 32 capabilities and 32 versions each.', args: { id: 'Script.<slug>', expectedVersion: 'integer >= 0', description: 'string', useWhen: 'string', avoidWhen: 'string', inputDescription: 'string', outputDescription: 'string', code: 'JavaScript function body', tests: 'array of {input,expected}' }, access: 'create-pure-capability' },
  { id: 'Skill.reconsider', version: 1, domain: 'method', description: 'Read-only method for revising a previous judgment.', keywords: '反思 复核 反例 修正 重新审视 reconsider revise counterexample', useWhen: 'A prior judgment meets conflicting evidence or may have overlooked an alternative.', avoidWhen: 'Do not force a revision or treat a hypothetical counterexample as observed evidence.', instructions: 'Identify one prior claim, list a concrete counterexample or missing evidence, and decide whether to retain, qualify or revise it. Mark what remains unresolved. Do not present the counterexample as an observed event without evidence.', args: {} },
  { id: 'Skill.associate', version: 1, domain: 'method', description: 'Read-only method for new conceptual associations.', keywords: '联想 关联 遐想 想象 associate association imagine dream', useWhen: 'Explore a possible relation between experiences or concepts and preserve it as a question or hypothesis.', avoidWhen: 'Do not equate similarity or co-occurrence with causation or verified experience.', instructions: 'Compare two recalled concepts or experiences. Propose a typed relation and a new question or hypothetical scenario. Co-occurrence is not causation; imagination is not an experience. Keep useful disagreement instead of forcing agreement.', args: {} },
];
const manifests = entries.map(entry => {
  const contract = { ...entry, access: entry.access ?? 'read-only', dependencies: [] };
  return { ...contract, revision: digest(contract) };
});
const foundationIds = new Set(['Think', 'Recall', 'Capability.create']);
export const CAPABILITY_LIMITS = Object.freeze({ familiar: 2, familiarMaxAgeMs: 30 * 24 * 60 * 60 * 1000, activeBytes: 8192, searchContractBytes: 4096 });
export const CAPABILITY_MAP = Object.freeze({
  domains: ['cognition', 'memory', 'method', 'creation', 'script'], total: entries.length,
  discover: { id: 'catalog.search', args: '{query?:string,cursor?:string|null,limit?:1..5}', description: 'Browse/search summaries with budgeted complete contracts. Returned contracts are prepared for the next call; omitted contracts require catalog.view. All entries remain reachable by pagination.' },
  inspect: { id: 'catalog.view', args: '{id:string}', description: 'Load a known ID directly, or a contract omitted by search. No search is required first.' },
  intrinsic: 'Think is always available as a cognitive activity; no tool call is required.',
});
export const catalogRevision = digest(manifests);
const copy = value => structuredClone(value);
const available = (manifest, layer, reason, experience) => ({ ...copy(manifest), availability: { layer, reason, ...(experience ? { experience } : {}) } });
export const foundationCapabilities = () => manifests.filter(m => foundationIds.has(m.id)).map(m => available(m, 'foundation', 'general-cognitive-ability'));

/** A bounded procedural familiarity projection, never a stored contract or authorization.
 * Only execution observations for this Person arrive from the fenced repository snapshot.
 * Trigger kind is a coarse preference, not a semantic classifier or a compulsory workflow. */
function familiarCapabilities(experience, triggerKind, now, byId) {
  const candidates = [];
  for (const item of Array.isArray(experience) ? experience.slice(0, 16) : []) {
    const manifest = byId.get(item?.id);
    if (!manifest || foundationIds.has(item.id) || item.version !== manifest.version || item.revision !== manifest.revision) continue;
    const observations = (Array.isArray(item.observations) ? item.observations.slice(0, 8) : [])
      .filter(o => ['succeeded', 'failed'].includes(o?.outcome) && ['send', 'think', 'dream'].includes(o.triggerKind) && Number.isFinite(Date.parse(o.usedAt)))
      .sort((a, b) => Date.parse(b.usedAt) - Date.parse(a.usedAt));
    const latest = observations[0], age = now - Date.parse(latest?.usedAt);
    if (!latest || latest.outcome !== 'succeeded' || age < 0 || age > CAPABILITY_LIMITS.familiarMaxAgeMs) continue;
    const matching = observations.filter(o => o.triggerKind === triggerKind && now - Date.parse(o.usedAt) >= 0 && now - Date.parse(o.usedAt) <= CAPABILITY_LIMITS.familiarMaxAgeMs);
    candidates.push({ manifest, latest, matching: matching.length, experience: {
      lastUsedAt: latest.usedAt, lastOutcome: latest.outcome,
      observedSuccesses: observations.filter(o => o.outcome === 'succeeded').length,
      observedFailures: observations.filter(o => o.outcome === 'failed').length,
      sameTriggerObservations: matching.length, usefulness: 'not-evaluated',
    } });
  }
  return candidates.sort((a, b) => b.matching - a.matching || Date.parse(b.latest.usedAt) - Date.parse(a.latest.usedAt) || a.manifest.id.localeCompare(b.manifest.id, 'en'))
    .slice(0, CAPABILITY_LIMITS.familiar).map(c => available(c.manifest, 'familiar', c.matching ? 'used-in-same-trigger-kind' : 'recently-used', c.experience));
}


/** Generated metadata is descriptive untrusted content, not executable authority.
 * Code stays in the owned repository and is never interpolated into host scripts. */
function scriptManifest(record) {
  return { id: record.id, version: record.version, revision: record.revision, domain: 'script',
    description: record.description, keywords: `${record.inputDescription} ${record.outputDescription}`,
    useWhen: record.useWhen, avoidWhen: record.avoidWhen,
    instructions: `Pure JSON computation in a fresh restricted QuickJS VM. args: {input:JSON} <=8192 bytes; output JSON <=8192 bytes. Input: ${record.inputDescription} Output: ${record.outputDescription} No external access. Generated description/tests are fallible; inspect via catalog.view before revision.`,
    args: { input: 'JSON value matching inputDescription' }, access: 'pure-computation', dependencies: [],
    origin: 'person-created', evidence: record.evidence };
}

export class PersonCapabilities {
  constructor(repository, ownerId, { experience = [], triggerKind = 'think', now = Date.now(), created = [], episode } = {}) {
    this.repository = repository; this.ownerId = ownerId; this.episode = episode;
    this.scripts = new Map(created.map(record => [record.id, record]));
    this.byId = new Map([...manifests, ...created.map(scriptManifest)].map(m => [m.id, m]));
    this.prepared = new Map(foundationCapabilities().map(m => [m.id, m]));
    for (const item of familiarCapabilities(experience, triggerKind, now, this.byId)) {
      if (bytes([...this.prepared.values(), item]) <= CAPABILITY_LIMITS.activeBytes) this.prepared.set(item.id, item);
    }
    this.active = new Map(this.prepared);
  }
  catalog() { return { ...CAPABILITY_MAP, total: this.byId.size, revision: digest([...this.byId.values()]) }; }
  context() { return copy([...this.prepared.values()]); }
  /** Freeze execution eligibility to the complete contracts actually rendered in this call. */
  activate(rendered) {
    this.active = new Map();
    for (const item of rendered) {
      const current = this.byId.get(item.id);
      if (current && current.revision === item.revision && this.prepared.has(item.id)) this.active.set(item.id, current);
    }
  }
  executionManifest(id) {
    const manifest = this.active.get(id), current = this.byId.get(id);
    if (!manifest || manifest.revision !== current?.revision) return null;
    return { id: current.id, version: current.version, revision: current.revision };
  }
  prepare(manifest) {
    // A bounded working set. Explicitly requested contracts precede older optional ones.
    const item = available(manifest, foundationIds.has(manifest.id) ? 'foundation' : 'discovered', 'explicitly-requested');
    const next = [item, ...this.prepared.values()].filter((m, i, all) => all.findIndex(n => n.id === m.id) === i);
    const kept = next.filter(m => foundationIds.has(m.id));
    for (const candidate of next.filter(m => !foundationIds.has(m.id))) {
      if (bytes([...kept, candidate]) <= CAPABILITY_LIMITS.activeBytes) kept.push(candidate);
    }
    this.prepared = new Map(kept.map(m => [m.id, m]));
    // Runtime replaces this with its rendered manifest before every cognitive dispatch.
    this.activate(kept);
  }
  async execute({ id, args }, { signal, callId } = {}) {
    signal?.throwIfAborted();
    if (id === 'catalog.search') {
      object(args, ['query', 'cursor', 'limit'], []);
      const query = text(args.query ?? '', 200, true).toLowerCase().trim();
      const limit = args.limit ?? 3;
      if (!Number.isInteger(limit) || limit < 1 || limit > 5) fail('INVALID_REQUEST');
      if (args.cursor != null) identifier(args.cursor);
      const terms = query.split(/\s+/u).filter(Boolean);
      const matches = [...this.byId.values()].filter(e => terms.every(term => `${e.id} ${e.domain} ${e.description} ${e.keywords} ${e.useWhen}`.toLowerCase().includes(term))).sort((a, b) => a.id.localeCompare(b.id, 'en'));
      const start = args.cursor == null ? 0 : matches.findIndex(e => e.id === args.cursor) + 1;
      if (args.cursor != null && start === 0) fail('INVALID_REQUEST');
      const contracts = [], omittedContracts = [];
      const items = matches.slice(start, start + limit).map(manifest => {
        if (bytes([...contracts, manifest]) <= CAPABILITY_LIMITS.searchContractBytes) { contracts.push(copy(manifest)); this.prepare(manifest); }
        else omittedContracts.push({ id: manifest.id, reason: 'contract-budget', inspect: 'catalog.view' });
        const { instructions, args: schema, dependencies, keywords, ...summary } = manifest;
        return summary;
      });
      return { items, contracts, omittedContracts, nextCursor: start + limit < matches.length ? items.at(-1).id : null, catalogRevision: this.catalog().revision };
    }
    if (id === 'catalog.view') {
      object(args, ['id']); identifier(args.id);
      const entry = this.byId.get(args.id);
      if (!entry) fail('UNSUPPORTED');
      this.prepare(entry);
      return { ...copy(entry), catalogRevision: this.catalog().revision, ...(this.scripts.has(args.id) ? { definition: copy(this.scripts.get(args.id)) } : {}) };
    }
    const entry = this.byId.get(id);
    if (!entry || !this.executionManifest(id)) fail('UNSUPPORTED');
    if (id === 'Capability.create') {
      if (!this.episode || !callId) fail('UNSUPPORTED');
      const definition = validateCreatedDefinition(args);
      const current = this.scripts.get(definition.id);
      if ((current?.version ?? 0) !== definition.expectedVersion) return { ok: false, code: 'SCRIPT_VERSION', currentVersion: current?.version ?? 0 };
      const tested = await testPersonScript(definition, { signal });
      if (!tested.ok) return tested;
      signal?.throwIfAborted();
      const record = await this.repository.saveCreatedCapability(this.episode, { definition, evidence: tested.evidence, callId });
      this.scripts.set(record.id, record);
      const manifest = scriptManifest(record);
      this.byId.set(record.id, manifest); this.prepare(manifest);
      return { ok: true, published: true, contract: copy(manifest), evidence: record.evidence, notice: 'Only the supplied tests passed. This publication is durable even if the later cognitive proposal is not committed.' };
    }
    if (this.scripts.has(id)) {
      object(args, ['input']); scriptInput(args.input);
      return { ...await runPersonScript(this.scripts.get(id).code, args.input, { signal }), id, version: entry.version, revision: entry.revision, access: 'pure-computation' };
    }
    if (id === 'Recall') {
      object(args, ['kind', 'query', 'cursor', 'limit'], ['kind']);
      if (!['messages', 'concepts'].includes(args.kind)) fail('INVALID_REQUEST');
      text(args.query ?? '', 200, true);
      const limit = args.limit ?? 3;
      if (!Number.isInteger(limit) || limit < 1 || limit > 5) fail('INVALID_REQUEST');
      const localCursor = typeof args.cursor === 'string' && /^lm:[a-f0-9]{32}:\d{1,6}$/.test(args.cursor);
      const cursor = args.kind === 'messages' && !localCursor ? page({ cursor: args.cursor, limit }).cursor : args.cursor;
      if (cursor != null && (localCursor || args.kind === 'concepts')) identifier(cursor);
      const result = await this.repository.recall(this.ownerId, { ...args, cursor, limit }, { signal });
      signal?.throwIfAborted();
      if (bytes(result) > 60000) fail('CONTEXT_LIMIT');
      return { ...result, kind: args.kind, version: entry.version };
    }
    object(args, []);
    return { id, version: entry.version, instructions: entry.instructions, access: 'method-only' };
  }
}
