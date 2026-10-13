// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { acceptPersonResponse, createPersonController, personState } from '../../web/stores/helpers/digital-person.js';
import { createPersonOutputs, outputState, staticOutputHtml } from '../../web/stores/helpers/person-outputs.js';

const file = { id: 'file', title: 'report.md', kind: 'file', mimeType: 'text/markdown', size: 4, episodeId: 'episode' };
const chunk = (text, offset = 0, eof = true, totalBytes = 4) => ({ outputId: 'file', data: btoa(text), offset, nextOffset: offset + text.length, eof, totalBytes, mimeType: 'text/markdown' });
function harness(request = vi.fn(async () => chunk('done'))) {
  const state = outputState();
  let identity = 'owner/agent/person/1';
  const urls = { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() };
  const controller = createPersonOutputs({ state, request, identity: () => identity, urls });
  return { state, controller, urls, switchIdentity: () => { identity = 'owner/other/person/2'; controller.reset(); } };
}

describe('Digital Person output boundaries', () => {
  it('builds inert static HTML with a first CSP and no active/navigation elements', () => {
    const html = staticOutputHtml('<meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test"><script>alert(1)</script><form action="https://evil.test"><input></form><iframe src="https://evil.test"></iframe><h1 onclick="alert(1)">Report</h1><a href="https://evil.test" target="_top">Go</a><img src="https://evil.test/track"><style>p { color: red }</style>');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.head.firstElementChild.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(doc.head.firstElementChild.content).toContain("default-src 'none'");
    expect(doc.head.firstElementChild.content).toContain("form-action 'none'");
    expect(doc.querySelector('script,form,iframe,base,input,meta[http-equiv="refresh"]')).toBeNull();
    expect(doc.querySelector('[onclick],[href],[target],img[src]')).toBeNull();
    expect(doc.querySelector('h1').textContent).toBe('Report');
    expect(doc.querySelector('style').textContent).toContain('color: red');
  });

  it('fences a delayed old selection and revokes only the newer Blob on reset', async () => {
    let reply;
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }))
      .mockResolvedValueOnce({ ...chunk('new!'), outputId: 'new' });
    const { state, controller, urls } = harness(request);
    const old = controller.select(file);
    await controller.select({ ...file, id: 'new' });
    reply(chunk('old!'));
    await old;
    expect(state.selected.id).toBe('new');
    expect(state.preview.text).toBe('new!');
    expect(urls.createObjectURL).toHaveBeenCalledTimes(1);
    controller.reset();
    expect(urls.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('fences a delayed chunk on identity change without retaining private bytes', async () => {
    let reply;
    const request = vi.fn(() => new Promise(resolve => { reply = resolve; }));
    const { controller, state, urls, switchIdentity } = harness(request);
    const reading = controller.select(file);
    const signal = request.mock.calls[0][2].signal;
    switchIdentity();
    expect(signal.aborted).toBe(true);
    reply(chunk('secret', 0, true, 6));
    await reading;
    expect(state.selected).toBeNull();
    expect(state.tabs).toEqual([]);
    expect(state.preview.text).toBe('');
    expect(urls.createObjectURL).not.toHaveBeenCalled();
  });

  it('fences output pagination on identity change and never selects new snapshot outputs', async () => {
    let reply;
    const { controller, state, switchIdentity } = harness(() => new Promise(resolve => { reply = resolve; }));
    controller.snapshot({ items: [file], nextCursor: 'older' });
    expect(state.selected).toBeNull();
    const paging = controller.list(true);
    switchIdentity();
    reply({ items: [{ ...file, id: 'private' }], nextCursor: null });
    await paging;
    expect(state.items).toEqual([]);
  });

  it('retains paged history and its cursor on snapshot refresh', () => {
    const { controller, state } = harness();
    controller.snapshot({ items: [file], nextCursor: 'older' });
    state.items.push({ ...file, id: 'old' });
    state.historyPaged = true;
    state.nextCursor = 'oldest';
    controller.snapshot({ items: [{ ...file, id: 'new' }, file], nextCursor: 'recent' });
    expect(state.items.map(item => item.id)).toEqual(['new', 'file', 'old']);
    expect(state.nextCursor).toBe('oldest');
    expect(state.selected).toBeNull();
  });
  it.each(['older', null])('restarts a disconnected latest page after partially/exhausted history (%s), preserving selection', async cursor => {
    const rows = Array.from({ length: 61 }, (_, i) => ({ ...file, id: String(61 - i) }));
    const request = vi.fn(async (_, { cursor: from }) => {
      const start = rows.findIndex(row => row.id === from) + 1;
      return { items: rows.slice(start, start + 20), nextCursor: start + 20 < rows.length ? rows[start + 19].id : null };
    });
    const { controller, state } = harness(request);
    controller.snapshot({ items: rows.slice(21, 41), nextCursor: 'older' });
    state.items.push(...rows.slice(41));
    state.historyPaged = true; state.nextCursor = cursor;
    state.selected = rows.at(-1);
    controller.snapshot({ items: rows.slice(0, 20), nextCursor: rows[19].id });
    expect(state.items).toEqual(rows.slice(0, 20));
    expect(state.nextCursor).toBe(rows[19].id);
    expect(state.selected).toBe(rows.at(-1));
    while (state.nextCursor !== null) await controller.list(true);
    expect(state.items).toEqual(rows); // includes the previously missing 21st new output
    expect(state.selected).toBe(rows.at(-1));
  });
});

describe('Digital Person output relay integration', () => {

  it('aborts and removes the pending read channel on owner/Agent change', async () => {
    let owner = 'one';
    let read;
    const requests = [];
    const state = personState();
    const chat = { connectionState: 'connected', authenticated: true, digitalPersonUiEnabledByAgent: { a: true, b: true },
      agents: ['a', 'b'].map(id => ({ id, online: true, capabilities: ['digital_person'] })),
      sendWsMessage(request) {
        requests.push(request);
        if (request.op === 'output_read') { read = request; return true; }
        const data = { status: { configured: true, outputsSupported: true }, open: {},
          snapshot: { person: { id: 'person-' + request.agentId }, outputs: { items: [file], nextCursor: null } },
          messages: { items: [] }, traces: { items: [] } };
        queueMicrotask(() => acceptPersonResponse(chat, { ...request, ok: true, data: data[request.op] }));
        return true;
      },
    };
    const controller = createPersonController({ chat, state, scope: () => owner });
    try {
      await controller.open('a');
      expect(state.outputsSupported).toBe(true);
      expect(state.outputs.items).toEqual([file]);
      expect(state.outputs.selected).toBeNull();
      const reading = controller.selectOutput(file);
      owner = 'two';
      await controller.open('b');
      expect(acceptPersonResponse(chat, { ...read, ok: true, data: chunk('done') })).toBe(false);
      await reading;
      expect(state.outputs.selected).toBeNull();
      expect(state.outputs.preview.text).toBe('');
      expect(requests.filter(row => row.op === 'output_read')).toHaveLength(1);
    } finally { controller.dispose(); }
  });
});
