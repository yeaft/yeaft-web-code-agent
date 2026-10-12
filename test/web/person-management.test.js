// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { acceptPersonResponse, createPersonController, personState } from '../../web/stores/helpers/digital-person.js';
import { projectPersonFeedback } from '../../web/utils/person-activity.js';
import PersonManagement from '../../web/components/PersonManagement.js';
import en from '../../web/i18n/en.js';
import zh from '../../web/i18n/zh-CN.js';

const active = (status = 'running') => ({ episodeId: 'live', status, phase: 'model', model: 'provider/long-model-name', startedAt: 1000, elapsedMs: 4000, loopCount: 2,
  models: [{ model: 'provider/long-model-name', durationMs: 2500, usage: { inputTokens: 50, outputTokens: null, totalTokens: null, complete: false } }],
  calls: [{ callId: 'call', index: 2, model: 'provider/long-model-name', status: 'running', durationMs: 2500, usage: null, reasoning: 'PRIVATE', reason: 'PRIVATE' }],
});
let wrapper;
const controllers = [];
beforeEach(() => { vi.stubGlobal('Vue', Vue); });
afterEach(() => { wrapper?.unmount(); wrapper = null; controllers.splice(0).forEach(c => c.dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });
function fixture({ timeoutMs = 30_000 } = {}) {
  const requests = [], held = [];
  let owner = 'owner', hold = false, foreground = true, execution = active();
  let snapshot = { person: { id: 'p' }, messages: [], busy: true, episodeId: 'live' };
  const state = personState();
  const chat = { digitalPersonUiEnabledByAgent: { a: true, b: true }, connectionState: 'connected', authenticated: true,
    agents: ['a', 'b'].map(id => ({ id, online: true, capabilities: ['digital_person'] })),
    sendWsMessage(request) {
      requests.push(request);
      if (hold && ['executions', 'pause', 'resume', 'cancel'].includes(request.op)) { held.push(request); return true; }
      const defaults = { status: { configured: true }, open: {}, snapshot,
        messages: { items: [] }, traces: { items: [] }, tasks: { tasks: [], agents: [], active: { tasks: [], agents: [] } }, executions: { active: execution }, pause: {}, resume: {}, cancel: {} };
      queueMicrotask(() => respond(request, defaults[request.op])); return true;
    },
  };
  const respond = (request, data) => acceptPersonResponse(chat, { ...request, ok: true, data });
  const controller = createPersonController({ chat, state, scope: () => owner, timeoutMs, pollMs: 100, foreground: () => foreground });
  controllers.push(controller);
  return { state, chat, controller, requests, held, respond, owner: value => { owner = value; }, hold: value => { hold = value; }, foreground: value => { foreground = value; }, execution: value => { execution = value; }, snapshot: value => { snapshot = value; } };
}

describe('Person Management read and control fences', () => {
  it('polls executions and tasks read-only while visible and main is busy, suspends while hidden', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.controller.open('a');
    f.controller.showManagement(true); await flushPromises();
    expect(f.state.executions.active.episodeId).toBe('live');
    await vi.advanceTimersByTimeAsync(350);
    expect(f.requests.filter(r => r.op === 'executions').length).toBeGreaterThan(2);
    expect(f.requests.filter(r => r.op === 'tasks').length).toBeGreaterThan(2);
    f.foreground(false); f.controller.visibilityChanged();
    const count = f.requests.filter(r => ['executions', 'tasks'].includes(r.op)).length;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.requests.filter(r => ['executions', 'tasks'].includes(r.op))).toHaveLength(count);
    f.foreground(true); f.controller.visibilityChanged(); await flushPromises();
    expect(f.requests.filter(r => r.op === 'executions')).toHaveLength(count / 2 + 1);
    f.controller.showManagement(false); await vi.advanceTimersByTimeAsync(400);
    expect(f.requests.filter(r => r.op === 'executions')).toHaveLength(count / 2 + 1);
    expect(f.requests.some(r => ['think', 'send', 'dream', 'settings'].includes(r.op))).toBe(false);
  });
  it('fences superseded execution reads and owner/Agent/reconnect responses', async () => {
    const f = fixture(); await f.controller.open('a'); f.hold(true);
    const older = f.controller.readExecutions(); const old = f.held.at(-1);
    const newer = f.controller.readExecutions(); const next = f.held.at(-1);
    f.respond(next, { active: active('paused') }); await newer;
    f.respond(old, { active: active() }); await older;
    expect(f.state.executions.active.status).toBe('paused');
    const pending = f.controller.readExecutions(); const stale = f.held.at(-1);
    await f.controller.open('b'); await pending;
    expect(f.respond(stale, { active: active() })).toBe(false);
    expect(f.state.executions.active).toBeNull();
    const ownerRead = f.controller.readExecutions(); const ownerRequest = f.held.at(-1);
    f.owner('other'); expect(f.respond(ownerRequest, { active: active() })).toBe(false);
    await f.controller.open('a'); await ownerRead;
    expect(f.state.executions.active).toBeNull();
  });
  it('invalidates reads on disconnect and only observes fresh state after reconnect', async () => {
    const f = fixture(); await f.controller.open('a'); await f.controller.readExecutions(); f.hold(true);
    const reading = f.controller.readExecutions(), request = f.held.at(-1);
    f.chat.connectionState = 'reconnecting'; await f.controller.open('a'); await reading;
    expect(f.respond(request, { active: active('paused') })).toBe(false);
    expect(f.state.executions.active).toBeNull();
    f.hold(false); f.chat.connectionState = 'connected'; f.execution(active('paused'));
    await f.controller.open('a'); f.controller.showManagement(true); await flushPromises();
    expect(f.state.executions.active.status).toBe('paused');
    expect(f.requests.some(r => ['pause', 'resume', 'send', 'think', 'dream'].includes(r.op))).toBe(false);
  });
  it('keeps cancel mutually exclusive with pause/resume and clears pending after rejection', async () => {
    const f = fixture(); await f.controller.open('a'); await f.controller.readExecutions(); f.hold(true);
    const cancelling = f.controller.controlExecution('cancel', 'live'), request = f.held.at(-1);
    expect(request.payload).toEqual({ episodeId: 'live' });
    expect(f.state.executions.pending).toBe('cancel');
    expect(await f.controller.controlExecution('pause', 'live')).toBe(false);
    acceptPersonResponse(f.chat, { ...request, ok: false, error: 'Rejected', errorCode: 'STALE' });
    expect(await cancelling).toBe(false);
    expect(f.state.executions.pending).toBeNull(); expect(f.state.cancelPending).toBe(false);
    expect(f.state.executions.stale).toBe(true);
    expect(await f.controller.controlExecution('pause', 'live')).toBe(false);
    f.hold(false); await f.controller.readExecutions();
    expect(f.state.executions.stale).toBe(false);
    expect(await f.controller.controlExecution('pause', 'live')).toBe(true);
  });
  it.each(['pause', 'resume', 'cancel'].flatMap(op => ['STALE', 'outcome_unknown', 'timeout'].map(code => [op, code])))('%s failure (%s) fences pre-control reads and resumes only post-result polling', async (op, code) => {
    vi.useFakeTimers(); const f = fixture();
    const initial = active(op === 'resume' ? 'paused' : 'running'); f.execution(initial);
    await f.controller.open('a'); f.controller.showManagement(true); await flushPromises(); f.hold(true);
    const firstRead = f.controller.readExecutions(), firstRequest = f.held.at(-1);
    const lastRead = f.controller.readExecutions(), lastRequest = f.held.at(-1);
    const controlling = f.controller.controlExecution(op, 'live'), controlRequest = f.held.at(-1);
    expect(controlRequest.op).toBe(op);
    expect(f.state.executions).toMatchObject({ pending: op, stale: true, loading: false });
    const reads = f.requests.filter(r => r.op === 'executions').length;
    // Manual/visibility reads and previously scheduled polls must not observe a
    // control whose outcome is still unknown, even while the drawer stays open.
    await f.controller.readExecutions(); f.controller.visibilityChanged(); f.controller.showManagement(true);
    await vi.advanceTimersByTimeAsync(350);
    expect(f.requests.filter(r => r.op === 'executions')).toHaveLength(reads);
    f.respond(firstRequest, { active: active(op === 'resume' ? 'running' : 'paused') }); await firstRead;
    expect(f.state.executions.active.status).toBe(initial.status);
    expect(f.state.executions.stale).toBe(true);
    acceptPersonResponse(f.chat, { ...controlRequest, ok: false, error: 'Unconfirmed control', errorCode: code });
    expect(await controlling).toBe(false);
    // This was the latest read before control, so only the control fence (not
    // another read superseding it) can stop its late response clearing stale.
    f.respond(lastRequest, { active: active(op === 'resume' ? 'running' : 'paused') }); await lastRead;
    expect(f.state.executions).toMatchObject({ pending: null, stale: true, loading: false });
    expect(f.state.executions.active.status).toBe(initial.status);
    expect(f.state.cancelPending).toBe(false);
    expect(await f.controller.controlExecution(op, 'live')).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    const fresh = f.held.at(-1);
    expect(fresh.op).toBe('executions'); expect(fresh).not.toBe(firstRequest); expect(fresh).not.toBe(lastRequest);
    expect(f.state.executions.stale).toBe(true);
    f.respond(fresh, { active: active('paused') }); await flushPromises();
    expect(f.state.executions).toMatchObject({ pending: null, stale: false, loading: false });
    expect(f.state.executions.active.status).toBe('paused');
    await vi.advanceTimersByTimeAsync(100);
    expect(f.requests.filter(r => r.op === 'executions')).toHaveLength(reads + 2);
    expect(f.requests.some(r => ['send', 'think', 'dream'].includes(r.op))).toBe(false);
  });
  it.each(['pause', 'resume', 'cancel'])('%s start fences the latest read even before acknowledgement', async op => {
    const f = fixture(); const initial = active(op === 'resume' ? 'paused' : 'running'); f.execution(initial);
    await f.controller.open('a'); await f.controller.readExecutions(); f.hold(true);
    const reading = f.controller.readExecutions(), readRequest = f.held.at(-1);
    const controlling = f.controller.controlExecution(op, 'live'), controlRequest = f.held.at(-1);
    f.respond(readRequest, { active: active(op === 'resume' ? 'running' : 'paused') }); await reading;
    expect(f.state.executions).toMatchObject({ pending: op, stale: true, loading: false });
    expect(f.state.executions.active.status).toBe(initial.status);
    acceptPersonResponse(f.chat, { ...controlRequest, ok: false, errorCode: 'outcome_unknown' });
    expect(await controlling).toBe(false);
    expect(f.state.executions.stale).toBe(true);
  });
  it.each(['pause', 'resume', 'cancel'])('%s deadline keeps stale until a settled foreground read and rejects late acknowledgement', async op => {
    vi.useFakeTimers(); const f = fixture({ timeoutMs: 1000 });
    f.execution(active(op === 'resume' ? 'paused' : 'running'));
    await f.controller.open('a'); f.controller.showManagement(true); await flushPromises(); f.hold(true);
    const older = f.controller.readExecutions(), oldRequest = f.held.at(-1);
    const controlling = f.controller.controlExecution(op, 'live'), controlRequest = f.held.at(-1);
    await vi.advanceTimersByTimeAsync(900);
    f.respond(oldRequest, { active: active() }); await older;
    expect(f.state.executions.stale).toBe(true);
    f.foreground(false); f.controller.visibilityChanged();
    await vi.advanceTimersByTimeAsync(100);
    expect(await controlling).toBe(false);
    expect(f.state.executions).toMatchObject({ pending: null, stale: true, loading: false });
    expect(op === 'cancel' ? f.state.error.code : f.state.executions.error.code).toBe('timeout');
    expect(f.respond(controlRequest, {})).toBe(false);
    const reads = f.requests.filter(r => r.op === 'executions').length;
    await vi.advanceTimersByTimeAsync(200);
    expect(f.requests.filter(r => r.op === 'executions')).toHaveLength(reads);
    f.foreground(true); f.controller.visibilityChanged();
    const fresh = f.held.at(-1); expect(fresh.op).toBe('executions');
    f.respond(fresh, { active: null }); await flushPromises();
    expect(f.state.executions).toMatchObject({ active: null, stale: false, loading: false });
    expect(f.requests.some(r => ['send', 'think', 'dream'].includes(r.op))).toBe(false);
  });
  it('an existing composer cancel supersedes a pending pause acknowledgement', async () => {
    const f = fixture(); await f.controller.open('a'); await f.controller.readExecutions(); f.hold(true);
    const pausing = f.controller.controlExecution('pause', 'live'), pauseRequest = f.held.at(-1);
    const cancelling = f.controller.cancel(), cancelRequest = f.held.at(-1);
    expect(cancelRequest.op).toBe('cancel');
    f.respond(pauseRequest, {}); await flushPromises();
    expect(f.state.executions.pending).toBe('cancel');
    expect(f.held.at(-1)).toBe(cancelRequest);
    expect(await pausing).toBe(false);
    f.respond(cancelRequest, {}); expect(await cancelling).toBe(true);
    expect(f.state.executions.active.status).toBe('cancelling');
    expect(f.state.executions.pending).toBeNull();
  });
  it.each(['pause', 'resume'])('late %s acknowledgement cannot restore executions after composer cancel settles', async op => {
    vi.useFakeTimers(); const f = fixture(); f.execution(active(op === 'resume' ? 'paused' : 'running'));
    await f.controller.open('a'); f.controller.showManagement(true); await flushPromises(); f.hold(true);
    const controlling = f.controller.controlExecution(op, 'live'), controlRequest = f.held.at(-1);
    const cancelling = f.controller.cancel(), cancelRequest = f.held.at(-1);
    f.respond(cancelRequest, {}); await flushPromises();
    const fresh = f.held.at(-1); expect(fresh.op).toBe('executions');
    f.respond(fresh, { active: null }); expect(await cancelling).toBe(true);
    f.respond(controlRequest, {}); expect(await controlling).toBe(false);
    expect(f.state.executions).toMatchObject({ active: null, pending: null, stale: false });
    expect(f.state.feedbackSuppressedEpisodeId).toBe('live');
    expect(f.held.at(-1)).toBe(fresh);
  });
  it('does not stall recovery polling when the next read overlaps a Person refresh', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.controller.open('a');
    f.controller.showManagement(true); await flushPromises(); f.hold(true);
    const pausing = f.controller.controlExecution('pause', 'live'), request = f.held.at(-1);
    acceptPersonResponse(f.chat, { ...request, ok: false, errorCode: 'outcome_unknown' }); expect(await pausing).toBe(false);
    f.state.loading = true; const reads = f.requests.filter(r => r.op === 'executions').length;
    await vi.advanceTimersByTimeAsync(200);
    expect(f.requests.filter(r => r.op === 'executions')).toHaveLength(reads);
    expect(f.state.executions.stale).toBe(true);
    f.state.loading = false; await vi.advanceTimersByTimeAsync(100);
    expect(f.held.at(-1).op).toBe('executions');
    f.respond(f.held.at(-1), { active: active('paused') }); await flushPromises();
    expect(f.state.executions.stale).toBe(false);
  });
  it('pause snapshots do not suppress fresh backend waiting feedback after resume', async () => {
    const f = fixture();
    const snapshot = status => ({ person: { id: 'p' }, messages: [], busy: true, episodeId: 'live', latestEpisode: {
      id: 'live', status, createdAt: 1000, feedback: { at: 61000, phase: 'model' },
    } });
    f.snapshot(snapshot('running')); await f.controller.open('a'); await f.controller.readExecutions();
    expect(projectPersonFeedback(f.state)).not.toBeNull();
    f.execution(active('pausing')); expect(await f.controller.controlExecution('pause', 'live')).toBe(true);
    for (const status of ['pausing', 'paused']) {
      f.snapshot(snapshot(status)); await f.controller.refresh();
      expect(f.state.feedbackSuppressedEpisodeId).toBeNull();
      expect(projectPersonFeedback(f.state)).toBeNull();
    }
    f.execution(active('paused')); await f.controller.readExecutions();
    f.execution(active()); expect(await f.controller.controlExecution('resume', 'live')).toBe(true);
    f.snapshot(snapshot('running')); await f.controller.refresh();
    expect(projectPersonFeedback(f.state)).toEqual({ at: new Date(61000).toISOString(), label: 'person.feedback.model' });
    // Paused/running snapshots must not clear cancellation's independent fence.
    await f.controller.cancel();
    for (const status of ['paused', 'running']) {
      f.snapshot(snapshot(status)); await f.controller.refresh();
      expect(f.state.feedbackSuppressedEpisodeId).toBe('live');
      expect(projectPersonFeedback(f.state)).toBeNull();
    }
    expect(f.requests.some(r => ['send', 'think', 'dream'].includes(r.op))).toBe(false);
  });
  it('does not transfer a pending control acknowledgement to a new owner', async () => {
    const f = fixture(); await f.controller.open('a'); await f.controller.readExecutions(); f.hold(true);
    const pausing = f.controller.controlExecution('pause', 'live'), request = f.held.at(-1);
    f.owner('other'); f.hold(false); await f.controller.open('a');
    expect(await pausing).toBe(false);
    expect(f.respond(request, {})).toBe(false);
    expect(f.state.executions.pending).toBeNull(); expect(f.state.executions.active).toBeNull();
  });
  it('projects the production main/items contract without carrying raw deliberation', async () => {
    const f = fixture(); await f.controller.open('a'); f.hold(true);
    const reading = f.controller.readExecutions();
    f.respond(f.held.at(-1), { main: { ...active(), loops: 3, loopCount: undefined, capability: 'Bash', capabilityId: undefined,
      models: [{ model: 'm', elapsedMs: 1234, usage: null }], calls: undefined },
      items: [{ id: 'live', calls: [{ callId: 'safe', index: 1, elapsedMs: 100, requested: { model: 'm' }, reason: 'SECRET', usage: null }] }] });
    await reading;
    expect(f.state.executions.active.loopCount).toBe(3);
    expect(f.state.executions.active.capabilityId).toBe('Bash');
    expect(f.state.executions.active.models[0].durationMs).toBe(1234);
    expect(f.state.executions.active.calls[0].durationMs).toBe(100);
    expect(JSON.stringify(f.state.executions)).not.toContain('SECRET');
  });
  it('uses live cumulative totals independently from the bounded recent call window', async () => {
    const f = fixture(); await f.controller.open('a'); f.hold(true);
    const reading = f.controller.readExecutions();
    f.respond(f.held.at(-1), { main: { episodeId: 'live', status: 'paused', loops: 60, resumable: false,
      models: [{ model: 'm', elapsedMs: 12345, usage: { inputTokens: 1000, outputTokens: 500, complete: true } }] },
      items: [{ id: 'live', callsTruncated: true, usageScope: 'latest-call-window', calls: Array.from({ length: 32 }, (_, i) => ({ callId: `call-${i}`, index: 29 + i, usage: null })) }], nextCursor: 5 });
    await reading;
    expect(f.state.executions.active.loopCount).toBe(60);
    expect(f.state.executions.active.models[0].usage.inputTokens).toBe(1000);
    expect(f.state.executions.active.calls).toHaveLength(10);
    expect(f.state.executions.active.calls[0].index).toBe(51);
    expect(f.state.executions.active.callsTruncated).toBe(true);
    expect(f.state.executions.active.resumable).toBe(false);
    expect(await f.controller.controlExecution('resume', 'live')).toBe(false);
    expect(f.requests.some(r => r.op === 'resume')).toBe(false);
  });
  it('pause acknowledgement fences a running read; pausing cannot resume before the boundary', async () => {
    const f = fixture(); await f.controller.open('a'); await f.controller.readExecutions(); f.hold(true);
    const oldRead = f.controller.readExecutions(); const old = f.held.at(-1);
    const pause = f.controller.controlExecution('pause', 'live'); const request = f.held.at(-1);
    expect(request.op).toBe('pause'); expect(request.payload).toEqual({ episodeId: 'live' });
    expect(await f.controller.controlExecution('resume', 'live')).toBe(false);
    f.respond(request, {}); await flushPromises(); const post = f.held.at(-1);
    f.respond(post, { active: active('pausing') }); await pause;
    f.respond(old, { active: active() }); await oldRead;
    expect(f.state.executions.active.status).toBe('pausing');
    expect(await f.controller.controlExecution('resume', 'live')).toBe(false);
    f.hold(false); f.execution(active('paused')); await f.controller.readExecutions();
    f.execution(active()); expect(await f.controller.controlExecution('resume', 'live')).toBe(true);
    expect(f.requests.filter(r => r.op === 'resume')[0].payload).toEqual({ episodeId: 'live' });
    expect(f.requests.some(r => ['send', 'think', 'dream'].includes(r.op))).toBe(false);
    expect(await f.controller.controlExecution('pause', 'wrong-episode')).toBe(false);
  });
});

describe('Person Management presentation', () => {
  const render = (messages = en, status = 'running') => {
    const t = (key, params = {}) => (messages[key] || key).replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match));
    wrapper = mount(PersonManagement, { attachTo: document.body, props: {
      execution: { active: active(status), loaded: true }, page: { tasks: [], agents: [], active: { tasks: [{ id: 'shell', title: 'Build', status: 'running' }], agents: [{ id: 'child', name: 'Research', status: 'running', taskId: 'child-log' }] }, loaded: true }, log: {}, identityKey: 'owner:a:p',
    }, global: { config: { globalProperties: { $t: t } } } });
    return t;
  };
  it.each([['light', en], ['dark', zh]])('renders compact %s management at 320px without raw deliberation or invented usage', async (theme, messages) => {
    document.documentElement.dataset.theme = theme; vi.stubGlobal('innerWidth', 320); const t = render(messages);
    expect(wrapper.get('.person-main-execution').text()).toContain(t('person.management.main'));
    expect(wrapper.text()).toContain('Build'); expect(wrapper.text()).toContain('Research');
    expect(wrapper.text()).toContain(t('person.management.scope'));
    expect(wrapper.get('.person-execution-models').text()).toContain('—');
    expect(wrapper.get('.person-execution-models').text()).toContain('2.5s');
    expect(wrapper.text()).not.toContain('PRIVATE');
    expect(wrapper.findAll('.person-task-item')).toHaveLength(2);
    expect(wrapper.get('.person-main-execution').element.compareDocumentPosition(wrapper.get('.person-task-item').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await wrapper.get('[data-execution-control="pause"]').trigger('click');
    expect(wrapper.emitted('pause')[0]).toEqual(['live']);
    await wrapper.get('[data-execution-control="cancel"]').trigger('click');
    expect(wrapper.emitted('cancel')).toBeUndefined();
    await wrapper.get('[data-execution-control="confirm-cancel"]').trigger('click');
    expect(wrapper.emitted('cancel')[0]).toEqual(['live']);
    expect(wrapper.find('.btn-secondary').exists()).toBe(false);
  });
  it('preserves cancel confirmation across read-only polls and resets it across episodes', async () => {
    render(); await wrapper.get('[data-execution-control="cancel"]').trigger('click');
    const confirm = wrapper.get('[data-execution-control="confirm-cancel"]').element;
    confirm.focus();
    for (let i = 0; i < 3; i++) {
      await wrapper.setProps({ execution: { active: { ...active(), elapsedMs: 5000 + i * 1000 }, loaded: true, loading: true } });
      expect(wrapper.get('[data-execution-control="confirm-cancel"]').element).toBe(confirm);
      expect(document.activeElement).toBe(confirm);
      await wrapper.setProps({ execution: { active: { ...active(), elapsedMs: 6000 + i * 1000 }, loaded: true, loading: false } });
      expect(wrapper.get('[data-execution-control="confirm-cancel"]').element).toBe(confirm);
    }
    await wrapper.setProps({ execution: { active: { ...active(), episodeId: 'next' }, loaded: true } });
    expect(wrapper.find('[data-execution-control="confirm-cancel"]').exists()).toBe(false);
  });
  it.each([en, zh])('labels recent calls as a window but keeps live model totals cumulative', async messages => {
    const t = render(messages, 'paused');
    await wrapper.setProps({ execution: { active: { ...active('paused'), callsTruncated: true, resumable: false }, loaded: true } });
    expect(wrapper.get('.person-execution-calls').text()).toContain(t('person.management.callWindow', { n: '1' }));
    expect(wrapper.get('[data-execution-control="resume"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-execution-control="resume"]').trigger('click');
    expect(wrapper.emitted('resume')).toBeUndefined();
  });
  it('ticks elapsed time without metadata/model requests and freezes stale projections', async () => {
    vi.useFakeTimers(); render();
    expect(wrapper.get('.person-main-execution').text()).toContain('4.0s');
    await vi.advanceTimersByTimeAsync(2000);
    expect(wrapper.get('.person-main-execution').text()).toContain('6.0s');
    await wrapper.setProps({ execution: { active: active('paused'), loaded: true, stale: true } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(wrapper.get('.person-main-execution').text()).toContain('4.0s');
    expect(wrapper.emitted('refresh')).toBeUndefined();
  });
  it('keeps pausing distinct from paused, clears confirmation and disables controls when stale', async () => {
    const t = render(en, 'pausing');
    expect(wrapper.text()).toContain(t('person.management.pauseBoundary'));
    expect(wrapper.find('[data-execution-control="resume"]').exists()).toBe(false);
    expect(wrapper.find('[data-execution-control="pause"]').exists()).toBe(false);
    await wrapper.setProps({ execution: { active: active('paused'), loaded: true } });
    await wrapper.get('[data-execution-control="resume"]').trigger('click');
    expect(wrapper.emitted('resume')[0]).toEqual(['live']);
    await wrapper.get('[data-execution-control="cancel"]').trigger('click');
    await wrapper.setProps({ execution: { active: active('paused'), loaded: true, stale: true } });
    expect(wrapper.find('[data-execution-control="confirm-cancel"]').exists()).toBe(false);
    expect(wrapper.get('[data-execution-control="resume"]').attributes('disabled')).toBeDefined();
  });
});
