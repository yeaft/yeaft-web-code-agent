import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { seedDefaultVps } from '../../../agent/yeaft/vp/seed-defaults.js';
import { topUpDefaultVps } from '../../../agent/yeaft/vp/seed-topup.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import {
  addMember, createSessionFromSpec, ensureDefaultSessionIfEmpty, removeMember,
  renameSession, setSessionDefaultVp, snapshotSessions, updateSessionAnnouncement,
  updateSessionConfig, updateSessionWorkDir,
} from '../../../agent/yeaft/sessions/session-crud.js';
import { resolveFallbackVp, resolveMemberId } from '../../../agent/yeaft/sessions/roster.js';

const roots = [];
function temp(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await closeConversationHistoryIndexes();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('VP catalog and durable Session compatibility', () => {
  it('starts fresh with one generalist but never rebuilds an existing legacy roster on restart', () => {
    const yeaftDir = temp('yeaft-vp-session-');
    const libDir = join(yeaftDir, 'virtual-persons');
    expect(seedDefaultVps(libDir).errors).toEqual([]);
    expect(ensureDefaultSessionIfEmpty(yeaftDir, { libDir })).toMatchObject({
      seeded: true, defaultVpId: 'omni', rosterSize: 1,
    });
    const initial = snapshotSessions(yeaftDir)[0];
    expect(initial.roster).toEqual(['omni']);
    expect(topUpDefaultVps(libDir).errors).toEqual([]);
    expect(ensureDefaultSessionIfEmpty(yeaftDir, { libDir }).seeded).toBe(false);
    expect(snapshotSessions(yeaftDir)[0].roster).toEqual(['omni']);

    const oldRoot = temp('yeaft-legacy-vp-session-');
    const old = createSessionFromSpec(oldRoot, {
      name: 'Old team', roster: ['linus', 'martin', 'missing-custom'], defaultVpId: 'linus',
    });
    const metadata = join(oldRoot, 'sessions', old.id, 'session.json');
    const before = readFileSync(metadata, 'utf8');
    expect(ensureDefaultSessionIfEmpty(oldRoot, { libDir }).seeded).toBe(false);
    expect(readFileSync(metadata, 'utf8')).toBe(before);
    expect(snapshotSessions(oldRoot)[0]).toMatchObject({ roster: old.roster, defaultVpId: 'linus' });
  });

  it('preserves legacy routing and history across ordinary settings; only explicit membership operations change the roster', () => {
    const yeaftDir = temp('yeaft-vp-settings-');
    const session = createSessionFromSpec(yeaftDir, {
      name: 'Legacy team', roster: ['linus', 'martin', 'missing-custom'], defaultVpId: 'linus',
    });
    const conversation = new ConversationStore(yeaftDir);
    conversation.append({ sessionId: session.id, role: 'user', content: '@Linus inspect the system', turnId: 'prior' });
    conversation.append({ sessionId: session.id, role: 'assistant', content: 'Historical answer',
      speakerVpId: 'linus', turnId: 'prior', stopReason: 'end_turn' });
    const history = conversation.loadAllBySession(session.id);
    const current = () => snapshotSessions(yeaftDir).find(row => row.id === session.id);
    const expectLegacy = () => {
      const meta = current();
      expect(meta.roster).toEqual(session.roster);
      expect(meta.defaultVpId).toBe('linus');
      expect(resolveFallbackVp(meta)).toBe('linus');
      expect(resolveMemberId(meta, 'vp-martin')).toBe('martin');
      expect(conversation.loadAllBySession(session.id)).toEqual(history);
    };
    renameSession(yeaftDir, session.id, 'Renamed'); expectLegacy();
    updateSessionAnnouncement(yeaftDir, session.id, 'New guidance'); expectLegacy();
    updateSessionWorkDir(yeaftDir, session.id, temp('yeaft-vp-project-')); expectLegacy();
    updateSessionConfig(yeaftDir, session.id, { model: 'test/research-model' }); expectLegacy();
    expect(current().config.model).toBe('test/research-model');

    addMember(yeaftDir, session.id, 'software-omni');
    expect(current()).toMatchObject({ roster: [...session.roster, 'software-omni'], defaultVpId: 'linus' });
    removeMember(yeaftDir, session.id, 'linus');
    expect(current()).toMatchObject({ roster: ['martin', 'missing-custom', 'software-omni'], defaultVpId: 'martin' });
    expect(resolveMemberId(current(), 'linus')).toBeNull();
    addMember(yeaftDir, session.id, 'linus');
    setSessionDefaultVp(yeaftDir, session.id, 'linus');
    expect(resolveFallbackVp(current())).toBe('linus');
    for (const vpId of current().roster) removeMember(yeaftDir, session.id, vpId);
    expect(current()).toMatchObject({ roster: [], defaultVpId: null });
    expect(conversation.loadAllBySession(session.id)).toEqual(history);
    expect(history[1].speakerVpId).toBe('linus');
  });
});
