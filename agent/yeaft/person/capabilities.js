import { bytes, digest, fail, identifier, object, page, text } from './contracts.js';

// Versioned read-only methods, not the Agent's full registry. No shell/filesystem/VP side effects.
const entries = [
  { id: 'Think', version: 1, domain: 'cognition', description: 'Intrinsic deliberate reflection, reorganization, association and reconsideration.', instructions: 'Revisit supplied experiences and current judgments; separate report from hypothesis, propose new concepts or associations, test a counterexample, and record the explicit finding with uncertainty. It is fine to rest. This is a method, not another model call or external action.', args: {} },
  { id: 'Recall', version: 1, domain: 'memory', description: 'Read a bounded page of your own MongoDB messages or concepts.', instructions: 'args: {kind:"messages"|"concepts",query?:string,cursor?:string|null,limit?:1..5}. Literal text search, not a semantic or exhaustive search. Preserve nextCursor to reach older/lower-ranked records.', args: { kind: 'messages|concepts', query: 'optional literal search text', cursor: 'optional opaque cursor', limit: '1..5' } },
  { id: 'Skill.reconsider', version: 1, domain: 'method', description: 'Read-only method for revising a previous judgment.', instructions: 'Identify one prior claim, list a concrete counterexample or missing evidence, and decide whether to retain, qualify or revise it. Mark what remains unresolved. Do not present the counterexample as an observed event without evidence.', args: {} },
  { id: 'Skill.associate', version: 1, domain: 'method', description: 'Read-only method for new conceptual associations.', instructions: 'Compare two recalled concepts or experiences. Propose a typed relation and a new question or hypothetical scenario. Co-occurrence is not causation; imagination is not an experience. Keep useful disagreement instead of forcing agreement.', args: {} },
];
export const CAPABILITY_MAP = Object.freeze({
  domains: ['cognition', 'memory', 'method'], total: entries.length,
  discover: { id: 'catalog.search', args: '{query?:string,cursor?:string|null,limit?:1..5}', description: 'Browse/search bounded capability summaries. All entries are reachable by pagination.' },
  inspect: { id: 'catalog.view', args: '{id:string}', description: 'Load a selected versioned manifest; only then use that read-only capability.' },
  intrinsic: 'Think is always available as a cognitive activity; no tool call is required.',
});
export const catalogRevision = digest(entries);
export class PersonCapabilities {
  constructor(repository, ownerId) { this.repository = repository; this.ownerId = ownerId; this.loaded = new Set(['Think']); }
  async execute({ id, args }) {
    if (id === 'catalog.search') {
      object(args, ['query', 'cursor', 'limit'], []);
      const query = text(args.query ?? '', 200, true).toLowerCase();
      const limit = args.limit ?? 3;
      if (!Number.isInteger(limit) || limit < 1 || limit > 5) fail('INVALID_REQUEST');
      if (args.cursor != null) identifier(args.cursor);
      const matches = entries.filter(e => `${e.id} ${e.domain} ${e.description}`.toLowerCase().includes(query)).sort((a, b) => a.id.localeCompare(b.id, 'en'));
      const start = args.cursor == null ? 0 : matches.findIndex(e => e.id === args.cursor) + 1;
      if (args.cursor != null && start === 0) fail('INVALID_REQUEST');
      const items = matches.slice(start, start + limit).map(({ instructions, args: schema, ...entry }) => entry);
      return { items, nextCursor: start + limit < matches.length ? items.at(-1).id : null, catalogRevision };
    }
    if (id === 'catalog.view') {
      object(args, ['id']); identifier(args.id);
      const entry = entries.find(e => e.id === args.id);
      if (!entry) fail('UNSUPPORTED');
      this.loaded.add(entry.id);
      return { ...entry, catalogRevision, access: 'read-only', dependencies: [] };
    }
    const entry = entries.find(e => e.id === id);
    if (!entry || !this.loaded.has(id)) fail('UNSUPPORTED');
    if (id === 'Recall') {
      object(args, ['kind', 'query', 'cursor', 'limit'], ['kind']);
      if (!['messages', 'concepts'].includes(args.kind)) fail('INVALID_REQUEST');
      text(args.query ?? '', 200, true);
      const limit = args.limit ?? 3;
      if (!Number.isInteger(limit) || limit < 1 || limit > 5) fail('INVALID_REQUEST');
      const cursor = args.kind === 'messages' ? page({ cursor: args.cursor, limit }).cursor : args.cursor;
      if (args.kind === 'concepts' && cursor != null) identifier(cursor);
      const result = await this.repository.recall(this.ownerId, { ...args, cursor, limit });
      // Pages contain complete accepted records; context assembly may omit whole records later.
      if (bytes(result) > 60000) fail('CONTEXT_LIMIT');
      return { ...result, kind: args.kind, version: entry.version };
    }
    object(args, []);
    return { id, version: entry.version, instructions: entry.instructions, access: 'method-only' };
  }
}
