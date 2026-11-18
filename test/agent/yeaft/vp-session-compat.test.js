import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../../agent/yeaft/prompts.js';
import { renderSessionScene } from '../../../agent/yeaft/sessions/scene-prompts.js';
import { LEGACY_SCENE_PROFILES } from '../../../agent/yeaft/sessions/scene-ids.js';
import { DEFAULT_VPS, seedDefaultVps } from '../../../agent/yeaft/vp/seed-defaults.js';
import { topUpDefaultVps } from '../../../agent/yeaft/vp/seed-topup.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { createCliSessionRunner } from '../../../agent/yeaft/cli-session-runner.js';
import { runStreamSessionTurn } from '../../../agent/yeaft/stdio-protocol.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import {
  addMember, copySession, mergeSessions, createSessionFromSpec, ensureDefaultSessionIfEmpty, removeMember,
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
  it('rejects missing new members at the real Agent create boundary without altering old Sessions or partial writes', async () => {
    const root = temp('yeaft-vp-create-boundary-');
    const { default: ctx } = await import('../../../agent/context.js');
    const bridge = await import('../../../agent/yeaft/web-bridge.js');
    const keys = ['CONFIG', 'ws', 'outboundSendQueue', 'outboundSendQueueActive', 'serverEncryptionRequired', 'messageBuffer', 'messageBufferBytes'];
    const previous = Object.fromEntries(keys.map(key => [key, ctx[key]]));
    ctx.CONFIG = { yeaftDir: root }; ctx.ws = { readyState: 1, send() {} };
    ctx.serverEncryptionRequired = false; ctx.outboundSendQueue = []; ctx.outboundSendQueueActive = true;
    ctx.messageBuffer = []; ctx.messageBufferBytes = 0;
    const result = requestId => ctx.outboundSendQueue.find(item => item.msg.event?.requestId === requestId)?.msg.event;
    try {
      bridge.handleYeaftCreateSession({ requestId: 'missing-vp', payload: { name: 'Missing', roster: ['missing-custom'], defaultVpId: 'missing-custom' } });
      expect(result('missing-vp')).toMatchObject({ ok: false, error: { code: 'vp_not_found', message: expect.stringContaining('missing-custom') } });
      expect(existsSync(join(root, 'sessions-manifest.json'))).toBe(false);
      expect(existsSync(join(root, 'sessions'))).toBe(false);
      seedDefaultVps(join(root, 'virtual-persons'));
      bridge.handleYeaftCreateSession({ requestId: 'partial-vp', payload: { name: 'Partial', roster: ['linus', 'missing-custom'], defaultVpId: 'linus' } });
      expect(result('partial-vp')).toMatchObject({ ok: false, error: { code: 'vp_not_found' } });
      expect(existsSync(join(root, 'sessions'))).toBe(false);
      bridge.handleYeaftCreateSession({ requestId: 'valid-vp', payload: { name: 'Legacy chosen', roster: ['linus', 'martin'], defaultVpId: 'linus' } });
      expect(result('valid-vp')).toMatchObject({ ok: true, session: { roster: ['linus', 'martin'], defaultVpId: 'linus' } });
      const metadata = join(root, 'sessions', result('valid-vp').session.id, 'session.json');
      const before = readFileSync(metadata, 'utf8');
      rmSync(join(root, 'virtual-persons', 'linus'), { recursive: true });
      bridge.handleYeaftCreateSession({ requestId: 'deleted-vp', payload: { name: 'Deleted', roster: ['linus'], defaultVpId: 'linus' } });
      expect(result('deleted-vp')).toMatchObject({ ok: false, error: { code: 'vp_not_found' } });
      expect(readFileSync(metadata, 'utf8')).toBe(before);
      expect(snapshotSessions(root)).toHaveLength(1);
    } finally { Object.assign(ctx, previous); }
  });

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

  it('renders only the chosen localized practices, shared with the stock VP but without its identity', () => {
    const cues = {
      general: ['hint', '提示'], software: ['read-only', '只读'], writing: ['Proofreading', '校对'],
      'short-video': ['shootable substitute', '能拍的替代方案'], investment: ['explicit scoped authorization and appropriate controls', '范围明确的授权和适当的风控措施'],
    };
    for (const [id, vpId] of Object.entries(LEGACY_SCENE_PROFILES)) {
      const stock = DEFAULT_VPS.find(vp => vp.vpId === vpId);
      for (const [locale, lang, i] of [['en-US', 'en', 0], ['zh-CN', 'zh', 1]]) {
        const block = renderSessionScene(id, lang);
        const system = buildSystemPrompt({ language: locale, vpPersona: {
          sceneId: id, displayName: 'Private VP', persona: 'private-soul', runtimePreamble: 'session-preamble',
        } });
        expect(system.startsWith(`${block}\n\nsession-preamble`)).toBe(true);
        expect(system).not.toContain('private-soul');
        const stockSystem = buildSystemPrompt({ language: locale, vpPersona: stock });
        for (const prompt of [system, stockSystem]) {
          expect(prompt).not.toMatch(/Changes \/ Validation \/ Risks|Conclusion \/ Findings \/ Validation|改动 \/ 验证 \/ 风险|结论 \/ Findings \/ 验证/);
          expect(prompt).toContain(i ? '在相关的那句话里点明' : 'beside the answer');
        }
        const body = i ? stock.personaZh : stock.personaEn;
        expect(stockSystem).toContain(body);
        expect(block).not.toContain(body.split('\n')[0]);
        expect(block).toContain(body.slice(body.indexOf('\n\n') + 2));
        for (const [other, phrases] of Object.entries(cues)) {
          expect(block.includes(phrases[i]), `${id}/${lang}: ${other}`).toBe(other === id);
        }
        expect(block).not.toContain(cues[id][1 - i]);
      }
    }
    expect(renderSessionScene('__proto__', 'en')).toBe('');
    expect(buildSystemPrompt({ vpPersona: { displayName: 'Private VP', persona: 'private-soul' } }))
      .toContain('## Soul\n\nprivate-soul');
  });

  it('stores scenes independently of roles and keeps them through metadata edits, fork and merge', () => {
    const root = temp('yeaft-scene-config-');
    const spec = { name: 'Research', sceneId: 'investment', config: { model: 'provider/model', modelEffort: 'xhigh' } };
    expect(() => createSessionFromSpec(root, { ...spec, sceneId: '__proto__' })).toThrow();
    expect(() => createSessionFromSpec(root, { name: 'Nested', config: { sceneId: 'investment' } })).toThrow();
    expect(existsSync(join(root, 'sessions'))).toBe(false);
    const a = createSessionFromSpec(root, spec, { libDir: join(root, 'no-role-library') });
    const b = createSessionFromSpec(root, { name: 'Write', sceneId: 'writing' });
    renameSession(root, a.id, 'Renamed');
    updateSessionAnnouncement(root, a.id, 'Shared constraints');
    updateSessionConfig(root, a.id, { modelEffort: 'medium' });
    expect(() => updateSessionConfig(root, a.id, { sceneId: null })).toThrow();
    const c = copySession(root, a.id);
    const d = mergeSessions(root, a.id, b.id);
    const rows = new Map(snapshotSessions(root).map(row => [row.id, row]));
    for (const id of [a.id, c.id, d.id]) expect(rows.get(id)).toMatchObject({
      config: { sceneId: 'investment', model: 'provider/model', modelEffort: 'medium' },
    });
    expect(rows.get(b.id).config.sceneId).toBe('writing');
  });

  it('continues a converted Session on CLI without a compatible roster and reenters with the original scene', async () => {
    const root = temp('yeaft-cli-scene-');
    const session = createSessionFromSpec(root, { name: 'Legacy', roster: ['linus'] });
    updateSessionConfig(root, session.id, { sceneId: 'writing' });
    const store = new ConversationStore(root);
    store.append({ sessionId: session.id, role: 'user', content: 'legacy question' });
    store.append({ sessionId: session.id, role: 'assistant', content: 'legacy finding', speakerVpId: 'linus' });
    const requests = [];
    const runner = createCliSessionRunner({ loaded: { yeaftDir: root, conversationStore: store }, sessionId: session.id,
      personaFactory: () => { throw new Error('scene must not look up VP'); },
      engineFactory: () => ({ async *query(options) {
        requests.push(options);
        yield { type: 'text_delta', text: 'result' };
        yield { type: 'stop', stopReason: 'end_turn' };
      } }),
    });
    try {
      expect((await runner.run('@all carry on')).report.dispatched).toEqual(['omni']);
      expect(JSON.stringify(requests[0].messages)).toContain('legacy finding');
      await expect(runner.run('invalid selector', { routingIntent: { targetVpIds: ['linus'], explicit: true } })).rejects.toThrow('do not accept explicit VP');
      updateSessionConfig(root, session.id, { sceneId: 'software' });
      const output = [];
      await runStreamSessionTurn({ runner, sessionId: session.id, prompt: 'background result', write: frame => output.push(frame),
        internal: true, sceneId: 'writing', meta: { injectedBy: 'task_result' }, routingIntent: { targetVpIds: ['omni'] },
      });
      expect(requests.map(options => options.vpPersona?.sceneId)).toEqual(['writing', 'writing']);
      expect(requests.every(options => !options.router)).toBe(true);
      expect(output.at(-1)).toMatchObject({ type: 'result', is_error: false });
    } finally { await runner.close(); }
  });

});
