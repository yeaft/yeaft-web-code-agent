import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../../agent/yeaft/prompts.js';
import { renderSessionScene } from '../../../agent/yeaft/sessions/scene-prompts.js';
import { LEGACY_SCENE_PROFILES, SESSION_SCENE_IDS } from '../../../agent/yeaft/sessions/scene-ids.js';
import { DEFAULT_VPS } from '../../../agent/yeaft/vp/seed-defaults.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import {
  copySession,
  mergeSessions,
  createSessionFromSpec,
  renameSession,
  snapshotSessions,
  updateSessionAnnouncement,
  updateSessionConfig,
} from '../../../agent/yeaft/sessions/session-crud.js';

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
  it('renders only the chosen localized practices, shared with the stock VP but without its identity', () => {
    const cues = {
      general: ['standard of care', '注意标准'], software: ['expand, migrate, contract', '扩展、迁移、收缩'],
      frontend: ['design system', '设计系统'], writing: ['inverted pyramid', '倒金字塔'],
      'short-video': ['content pillars', '内容支柱'], 'video-editing': ['picture lock', '定剪'],
      'primary-education': ['double reduction', '双减'], investment: ['point-in-time data', '时点数据'],
    };
    expect(Object.keys(cues)).toEqual(SESSION_SCENE_IDS);
    const lensLayout = text => text.split('\n\n').map(part => part.match(/\*\*[^*\n]+\*\*/g)?.length ?? 0);
    for (const id of SESSION_SCENE_IDS) {
      // Only the original scenes ship a stock VP; later scenes are Session-only.
      const stock = DEFAULT_VPS.find(vp => vp.vpId === LEGACY_SCENE_PROFILES[id]);
      expect(lensLayout(renderSessionScene(id, 'zh'))).toEqual(lensLayout(renderSessionScene(id, 'en')));
      for (const [locale, lang, i] of [['en-US', 'en', 0], ['zh-CN', 'zh', 1]]) {
        const block = renderSessionScene(id, lang);
        // The same per-turn budget as a stock VP soul.
        expect(block.length).toBeLessThanOrEqual(i ? 2800 : 8500);
        const system = buildSystemPrompt({ language: locale, vpPersona: {
          sceneId: id, displayName: 'Private VP', persona: 'private-soul', runtimePreamble: 'session-preamble',
        } });
        expect(system.startsWith(`${block}\n\nsession-preamble`)).toBe(true);
        expect(system).not.toContain('private-soul');
        const stockSystem = stock ? buildSystemPrompt({ language: locale, vpPersona: stock }) : null;
        for (const prompt of [system, stockSystem].filter(Boolean)) {
          expect(prompt).not.toMatch(/Changes \/ Validation \/ Risks|Conclusion \/ Findings \/ Validation|改动 \/ 验证 \/ 风险|结论 \/ Findings \/ 验证/);
          expect(prompt).toContain(i ? '在相关的那句话里点明' : 'beside the answer');
        }
        if (stock) {
          const body = i ? stock.personaZh : stock.personaEn;
          expect(stockSystem).toContain(body);
          expect(block).not.toContain(body.split('\n')[0]);
          expect(block).toContain(body.slice(body.indexOf('\n\n') + 2));
        }
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
    const b = createSessionFromSpec(root, { name: 'Lessons', sceneId: 'primary-education' });
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
    expect(rows.get(b.id).config.sceneId).toBe('primary-education');
  });

});
