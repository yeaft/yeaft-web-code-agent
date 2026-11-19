// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { acceptPersonResponse } from '../../web/stores/helpers/digital-person.js';
import { personTurn } from '../fixtures/person-turns.js';
import { personRecords } from '../fixtures/person-records.js';
import { personSearchSnippet } from '../../web/utils/person-search-snippet.js';

vi.mock('../../web/stores/auth.js', () => ({ useAuthStore: () => ({ userId: 'owner', authGeneration: 1 }) }));
let wrapper;
let chat;
let requests;
beforeEach(() => {
  requests = [];
  chat = Vue.reactive({
    digitalPersonUiEnabledByAgent: { a: true, b: true },
    currentAgent: 'a', connectionState: 'connected', authenticated: true, theme: 'light',
    agents: [{ id: 'a', online: true, capabilities: ['digital_person'] }],
    leaveDigitalPerson: vi.fn(), leaveWorkCenter: vi.fn(), closePluginCenter: vi.fn(), toggleTheme: vi.fn(),
    enterYeaft: vi.fn(() => { chat.currentView = 'yeaft'; chat.currentAgent = 'previous-session-agent'; }), openPluginCenter: vi.fn(),
    sendWsMessage(request) {
      requests.push(request);
      const data = {
        status: { configured: true, renameSupported: true, reason: 'Model unavailable', models: [{ id: 'provider/a' }, { id: 'provider/b' }] }, open: {},
        snapshot: { person: { id: 'p', name: 'Ada' }, state: { version: 4 }, messages: [{ id: 'm', role: 'assistant', text: '<img onerror=alert(1)>', createdAt: 1 }], busy: false },
        messages: { items: [{ id: 'm', role: 'assistant', text: '<img onerror=alert(1)>', createdAt: 1 }], nextCursor: null }, traces: { items: personRecords(), nextCursor: 'older' },
        think: { episodeId: 'e' }, send: { episodeId: 'e' }, settings: { settings: { modelCandidates: request.payload.modelCandidates || [] }, person: { id: 'p', name: request.payload.name || 'Ada', settings: { modelCandidates: request.payload.modelCandidates || [] } } },
        inspect: { items: request.payload.section === 'memory' ? [{ id: 'idea', kind: 'interest', statement: '<script>Keep uncertainty</script>', epistemicState: 'reported', revision: 2, sourceRefs: ['message:1'] }] : [{ id: 'Script.sum', domain: 'script', version: 1, description: 'Sum', code: 'return input' }], nextCursor: null },
        search: { items: [{ id: 'archive', role: 'user', text: '<img src=x> archived message', createdAt: 1 }], nextCursor: null },
        tasks: { tasks: [{ id: 'background', title: '<script>build</script>', status: 'running' }], agents: [{ id: 'child', taskId: 'child-log', name: 'Research', status: 'completed' }] },
        turns: { items: [personTurn()], nextCursor: null }, executions: { main: null, items: [] },
        task_log: { text: '<img onerror=alert(1)> shell output', nextOffset: 35 }, task_cancel: {}, agent_close: {},
      };
      queueMicrotask(() => acceptPersonResponse(chat, { ...request, type: 'person_response', ok: true, data: data[request.op] }));
      return true;
    },
  });
  vi.stubGlobal('Vue', Vue);
  vi.stubGlobal('Pinia', { useChatStore: () => chat });
});
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); });

describe('Digital Person surface', () => {
  it('creates bounded literal search snippets around matches in the original text', () => {
    const text = `${'before '.repeat(60)}İstanbul: 😀 C++ and c++ — 知识库. ${'after '.repeat(60)}`;
    const snippet = personSearchSnippet(text, ' C++ ');
    expect(snippet).toMatchObject({ leading: true, trailing: true });
    expect(snippet.parts.filter(part => part.match).map(part => part.text)).toEqual(['C++', 'c++']);
    expect(snippet.parts.map(part => part.text).join('')).toHaveLength(200);
    expect(personSearchSnippet('İstanbul and İstanbul', 'i\u0307STANBUL').parts.filter(part => part.match).map(part => part.text)).toEqual(['İstanbul', 'İstanbul']);
    expect(personSearchSnippet('İ — regular I', 'i').parts.filter(part => part.match).map(part => part.text)).toEqual(['İ', 'I']);
    expect(personSearchSnippet(text, '知识库').parts.some(part => part.match && part.text === '知识库')).toBe(true);
    expect(personSearchSnippet('ΣΟΣ', 'σος').parts).toEqual([{ text: 'ΣΟΣ', match: true }]);
    expect(personSearchSnippet('Short message', '[')).toEqual({ parts: [{ text: 'Short message', match: false }], leading: false, trailing: false });
    expect(personSearchSnippet(`prefix😀${'x'.repeat(31)}match`, 'MATCH').parts[0].text.startsWith('😀')).toBe(true);
    expect(personSearchSnippet(`${'x'.repeat(199)}😀suffix`, '')).toEqual({ parts: [{ text: `${'x'.repeat(199)}😀`, match: false }], leading: false, trailing: true });
    for (const cluster of ['e\u0301', '👍🏽', '👩‍💻']) {
      const sample = personSearchSnippet(`prefix ${cluster}${'x'.repeat(31)}match`, 'MATCH');
      expect(sample.parts[0].text.startsWith(cluster)).toBe(true);
      expect(personSearchSnippet(`${'x'.repeat(199)}${cluster}suffix`, '').parts[0].text).toBe(`${'x'.repeat(199)}${cluster}`);
    }
    expect(personSearchSnippet('e\u0301', '\u0301').parts).toEqual([{ text: 'e\u0301', match: true }]);
    const phrase = '接口变更顺序'.repeat(8);
    expect(personSearchSnippet(`preceding context ${phrase} after`, phrase)).toEqual({
      parts: [{ text: phrase, match: true }, { text: ' after', match: false }], leading: true, trailing: false,
    });
    expect(personSearchSnippet('x'.repeat(200), 'x'.repeat(200))).toEqual({ parts: [{ text: 'x'.repeat(200), match: true }], leading: false, trailing: false });
  });

});
