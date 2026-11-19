import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createCliSessionRunner } from '../../../agent/yeaft/cli-session-runner.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { createSession, openSession, pruneDeletedCoordinatorMessages } from '../../../agent/yeaft/sessions/session-store.js';
import { tryAcquireSessionTurnDeletion } from '../../../agent/yeaft/sessions/session-turn-fence.js';

const sessionId = 'session_turn_fence';
const roots = [];
function session() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-session-fence-'));
  roots.push(root);
  const sessionsRoot = join(root, 'sessions');
  const handle = createSession(sessionsRoot, { id: sessionId, roster: ['alpha', 'beta'], defaultVpId: 'alpha' });
  return { root, sessionsRoot, handle };
}
afterEach(async () => {
  await closeConversationHistoryIndexes();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

it('keeps a second handle writable after the segment it used is physically pruned', () => {
  const { sessionsRoot, handle } = session();
  handle.appendMessage({ id: 'target', from: 'user', text: 'remove' });
  const second = openSession(sessionsRoot, sessionId);
  handle.close();
  pruneDeletedCoordinatorMessages(handle.dir, { clientMessageIds: ['target'], referenceIds: [] });
  second.appendMessage({ id: 'keep', from: 'user', text: 'preserve' });
  expect([...second.readMessageRange('keep', 'keep')].map(row => row.id)).toEqual(['keep']);
  second.close();
  const fresh = openSession(sessionsRoot, sessionId);
  expect([...fresh.streamMessages()].map(row => row.id)).toEqual(['keep']);
  fresh.close();
});

it('fences deletion against queued CLI work across processes and resumes from the committed projection', async () => {
  const { root, handle } = session();
  const store = new ConversationStore(root);
  const deletionStore = new ConversationStore(root);
  const old = store.append({ sessionId, role: 'user', content: 'remove me', clientMessageId: 'old', causalRootId: 'old' });
  handle.appendMessage({ id: 'old', from: 'user', text: 'remove me' });
  const { promise: paused, resolve: resume } = Promise.withResolvers();
  const requests = [];
  const runner = createCliSessionRunner({
    loaded: { yeaftDir: root, conversationStore: store }, sessionId, personaFactory: () => ({}),
    engineFactory: () => ({ async *query(options) {
      requests.push(options);
      if (options.prompt === 'active') await paused;
      yield { type: 'text_delta', text: 'done' };
    } }),
  });
  const moduleUrl = new URL('../../../agent/yeaft/sessions/session-turn-fence.js', import.meta.url).href;
  const childCanDelete = () => execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { tryAcquireSessionTurnDeletion } from ${JSON.stringify(moduleUrl)};
    const release = tryAcquireSessionTurnDeletion(process.argv[1]);
    console.log(release ? 'yes' : 'no');
    // Deliberately exit holding the lock; no stale PID cleanup is needed.
  `, handle.dir], { encoding: 'utf8', timeout: 5000 }).trim();
  try {
    const turn = runner.run('active');
    const queued = runner.run('queued');
    expect(childCanDelete()).toBe('no');
    resume();
    await Promise.all([turn, queued]);
    expect(childCanDelete()).toBe('yes');

    const release = tryAcquireSessionTurnDeletion(handle.dir);
    expect(release).toBeTypeOf('function');
    try {
      await expect(runner.run('not admitted')).rejects.toMatchObject({ code: 'session_running' });
      deletionStore.deleteSessionTurn(sessionId, old.id);
    } finally { release?.(); }
    await runner.run('after deletion');
    const history = requests.at(-1).messages.map(row => row.content);
    expect(history).toContain('queued');
    expect(history).not.toContain('remove me');
    expect(store.loadAllBySession(sessionId).map(row => row.content)).toEqual(['active', 'queued', 'after deletion']);
    expect([...handle.streamMessages()].map(row => row.text)).toEqual(['active', 'queued', 'after deletion']);
    // Logical deletion leaves the physical segment in place for older writers.
    expect(readFileSync(join(handle.dir, 'messages', '000001.jsonl'), 'utf8')).toContain('remove me');
  } finally {
    resume();
    await runner.close();
    handle.close();
  }
});
