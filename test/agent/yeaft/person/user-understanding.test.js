import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { PROPOSAL_INSTRUCTIONS, validateProposal } from '../../../../agent/yeaft/person/contracts.js';
import { stateView } from '../../../../agent/yeaft/person/inspection.js';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { finalProposal } from './fixtures.js';

const ref = 'message:user:1';
const understanding = (more = {}) => ({ kind: 'goal', statement: 'Learn how futures markets work.', epistemicState: 'reported', sourceRefs: [ref], ...more });
const proposal = (items, version = 0) => ({ ...finalProposal(version), concepts: [], state: { summary: 'Learning interests, not trading authority.', appraisal: '', focusConceptIds: [], understanding: items }, reply: null });
const validation = (more = {}) => ({ stateVersion: 0, sourceRefs: new Set([ref, 'concept:reported:2', 'tool:result']), concepts: new Map(),
  sources: new Map([[ref, { kind: 'message', role: 'user', reportedSourceRefs: [ref] }],
    ['concept:reported:2', { kind: 'concept', reportedSourceRefs: [ref] }], ['tool:result', { reportedSourceRefs: [] }]]), ...more });
const resources = [];
afterEach(async () => { for (const { repository, dir } of resources) { await repository.close(); await rm(dir, { recursive: true, force: true }); } resources.length = 0; });

describe('persistent user understanding', () => {
  it('accepts attributed goals, preferences and constraints without treating inferred outcomes as reported', () => {
    const items = [understanding(), understanding({ kind: 'preference', statement: 'May value learning over returns.', epistemicState: 'hypothesis', sourceRefs: ['tool:result'] }),
      understanding({ kind: 'constraint', statement: 'No trades authorized.', epistemicState: 'uncertain' })];
    expect(validateProposal(proposal(items), validation()).state.understanding).toEqual(items);
    expect(validateProposal(proposal([understanding({ sourceRefs: ['concept:reported:2'] })]), validation()).state.understanding).toHaveLength(1);
    for (const change of [
      { kind: 'interest' }, { epistemicState: 'imagined' }, { statement: 'x'.repeat(1001) }, { sourceRefs: [] },
      { sourceRefs: ['unread'] }, { sourceRefs: ['message:user:2'] }, { sourceRefs: ['tool:result'] }, { hidden: 'not projected' },
      { sourceRefs: Array(25).fill(ref) }, { statement: '期'.repeat(334) },
    ]) expect(() => validateProposal(proposal([understanding(change)]), validation())).toThrow(expect.objectContaining({ code: 'INVALID_PROPOSAL' }));
    for (const items of [null, Array(13).fill(understanding()), Array(12).fill(understanding({ statement: 'x'.repeat(1000), sourceRefs: Array(24).fill(ref) }))])
      expect(() => validateProposal(proposal(items), validation())).toThrow(expect.objectContaining({ code: 'INVALID_PROPOSAL' }));
    expect(stateView({ understanding: [{ ...items[0], hidden: 'private' }] }).understanding).toEqual([items[0]]);
    expect(PROPOSAL_INSTRUCTIONS).toContain('state.understanding');
    expect(PROPOSAL_INSTRUCTIONS).toContain('explicit [] clears');
    expect(PROPOSAL_INSTRUCTIONS).toContain('futures');
  });

  it('Dream cannot independently turn user messages or reported concepts into new reported understanding', () => {
    const item = understanding();
    expect(() => validateProposal(proposal([item]), validation({ dream: true }))).toThrow(expect.objectContaining({ code: 'INVALID_PROPOSAL' }));
    expect(() => validateProposal(proposal([item]), validation({ dream: true, state: { understanding: [understanding({ statement: 'Earn money.' })] } })))
      .toThrow(expect.objectContaining({ code: 'INVALID_PROPOSAL' }));
    expect(validateProposal(proposal([item]), validation({ dream: true, state: { understanding: [item] } })).state.understanding).toEqual([item]);
    expect(validateProposal(proposal([understanding({ epistemicState: 'hypothesis' })]), validation({ dream: true })).state.understanding[0].epistemicState).toBe('hypothesis');
  });

  it('persists across reopen, projects into context/snapshot/history, preserves omission and clears explicit []', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'person-understanding-'));
    let repository = new SqlitePersonRepository({ yeaftDir: dir, namespace: 'understanding', leaseMs: 30000 });
    const resource = { repository, dir }; resources.push(resource);
    await repository.open('alice');
    const admit = id => repository.admit('alice', { kind: 'send', text: 'Learn about futures, do not trade.', clientMessageId: id, workerId: 'worker', budget: {} });
    const { episode } = await admit('first');
    const item = understanding({ sourceRefs: [`message:${episode.messageId}:1`] });
    await repository.commit(episode, proposal([item]), { model: 'test/first', effort: null }, 'first');
    await repository.close();
    repository = resource.repository = new SqlitePersonRepository({ yeaftDir: dir, namespace: 'understanding', leaseMs: 30000 });
    expect((await repository.snapshot('alice')).state.understanding).toEqual([item]);
    const second = await admit('second');
    expect((await repository.context(second.episode)).state.understanding).toEqual([item]);
    const omitted = proposal(undefined, 1); delete omitted.state.understanding;
    await repository.commit(second.episode, omitted, { model: 'test/first', effort: null }, 'second');
    expect((await repository.snapshot('alice')).state.understanding).toEqual([item]);
    const third = await admit('third');
    await repository.commit(third.episode, proposal([], 2), { model: 'test/first', effort: null }, 'third');
    expect((await repository.snapshot('alice')).state.understanding).toEqual([]);
    const db = new DatabaseSync(repository.dbPath, { readOnly: true });
    try {
      const history = db.prepare("SELECT record FROM state_commits WHERE ownerId = 'alice' ORDER BY version").all().map(row => JSON.parse(row.record).state.understanding);
      expect(history).toEqual([[item], [item], []]);
    } finally { db.close(); }
  });
});
