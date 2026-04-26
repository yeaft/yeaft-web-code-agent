/**
 * R6 G2 — VP/Task memory browser (v1 time-sorted) + MemoryCard +
 * MemoryTraceModal.
 *
 * Per ruling §5 (TASTE-5): this is a READ-ONLY UI surface. System-prompt
 * memory composition lives in the agent process (recall-r6.js +
 * shard-store.js), independent of this Pinia store.
 *
 * Static source-level acceptance:
 *   S1 web/stores/memory.js exposes useMemoryStore with byScope state,
 *      entriesFor / isLoading / errorFor / traceFor getters,
 *      queryScope / applyQueryResult / requestTrace / applyTraceResult
 *      / invalidateScope actions.
 *   S2 web/app.js registers useMemoryStore on window.Pinia (same wiring
 *      pattern as useVpStore / useUserMemoryStore).
 *   S3 chat.js dispatch table forwards unify_memory_query_result and
 *      unify_memory_trace_result events into the store.
 *   S4 web/components/MemoryCard.js renders body/tags/importance/time
 *      and emits open-trace.
 *   S5 web/components/MemoryTraceModal.js mounts when entryId is set,
 *      reads memoryStore.traceFor(entryId), shows entry + sourceRef,
 *      emits jump-to-message + close.
 *   S6 VpDetailView wires the Memory section + MemoryTraceModal —
 *      auto-fetches on vpId change.
 *   S7 Backend agent/unify/web-bridge.js exports handleUnifyMemoryQuery
 *      and handleUnifyMemoryTrace; message-router.js dispatches the new
 *      message types.
 *   S8 i18n (en + zh-CN) carry all unify.vp.detail.memory* and
 *      unify.memory.card.* / unify.memory.trace.* keys.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const memoryStoreSrc   = read('web/stores/memory.js');
const appSrc           = read('web/app.js');
const chatStoreSrc     = read('web/stores/chat.js');
const memoryCardSrc    = read('web/components/MemoryCard.js');
const traceModalSrc    = read('web/components/MemoryTraceModal.js');
const detailViewSrc    = read('web/components/VpDetailView.js');
const webBridgeSrc     = read('agent/unify/web-bridge.js');
const routerSrc        = read('agent/connection/message-router.js');
const enI18nSrc        = read('web/i18n/en.js');
const zhI18nSrc        = read('web/i18n/zh-CN.js');

describe('R6 G2 — memory Pinia store surface', () => {
  it('defines useMemoryStore with expected state + getters', () => {
    expect(memoryStoreSrc).toMatch(/defineStore\('memory'/);
    expect(memoryStoreSrc).toMatch(/byScope:\s*\{\}/);
    expect(memoryStoreSrc).toMatch(/traces:\s*\{\}/);
    expect(memoryStoreSrc).toMatch(/entriesFor:\s*\(state\)/);
    expect(memoryStoreSrc).toMatch(/isLoading:\s*\(state\)/);
    expect(memoryStoreSrc).toMatch(/errorFor:\s*\(state\)/);
    expect(memoryStoreSrc).toMatch(/traceFor:\s*\(state\)/);
  });

  it('exposes queryScope / applyQueryResult / requestTrace / applyTraceResult', () => {
    expect(memoryStoreSrc).toMatch(/queryScope\s*\(\s*scope\s*\)/);
    expect(memoryStoreSrc).toMatch(/applyQueryResult\s*\(\s*event\s*\)/);
    expect(memoryStoreSrc).toMatch(/requestTrace\s*\(\s*entryId\s*\)/);
    expect(memoryStoreSrc).toMatch(/applyTraceResult\s*\(\s*event\s*\)/);
    expect(memoryStoreSrc).toMatch(/invalidateScope\s*\(\s*scope\s*\)/);
  });

  it('queryScope sends unify_memory_query over WS', () => {
    expect(memoryStoreSrc).toMatch(/type:\s*'unify_memory_query'/);
  });

  it('requestTrace sends unify_memory_trace over WS', () => {
    expect(memoryStoreSrc).toMatch(/type:\s*'unify_memory_trace'/);
  });
});

describe('R6 G2 — Pinia + dispatch wiring', () => {
  it('app.js registers useMemoryStore on window.Pinia', () => {
    expect(appSrc).toMatch(/useMemoryStore/);
    expect(appSrc).toMatch(/window\.Pinia\.useMemoryStore\s*=/);
  });

  it('chat.js dispatch handles unify_memory_query_result', () => {
    expect(chatStoreSrc).toMatch(/case 'unify_memory_query_result'/);
    expect(chatStoreSrc).toMatch(/applyQueryResult\s*\(\s*event\s*\)/);
  });

  it('chat.js dispatch handles unify_memory_trace_result', () => {
    expect(chatStoreSrc).toMatch(/case 'unify_memory_trace_result'/);
    expect(chatStoreSrc).toMatch(/applyTraceResult\s*\(\s*event\s*\)/);
  });
});

describe('R6 G2 — MemoryCard component', () => {
  it('declares the component and emits open-trace', () => {
    expect(memoryCardSrc).toMatch(/name:\s*'MemoryCard'/);
    expect(memoryCardSrc).toMatch(/emits:\s*\['open-trace'\]/);
  });

  it('renders body, tags and importance', () => {
    expect(memoryCardSrc).toMatch(/memory-card-body/);
    expect(memoryCardSrc).toMatch(/memory-card-tags/);
    expect(memoryCardSrc).toMatch(/memory-card-importance/);
  });

  it('disables the trace button when sourceRef is missing', () => {
    expect(memoryCardSrc).toMatch(/:disabled="!entry\.sourceRef"/);
  });

  it('marks superseded entries visibly', () => {
    expect(memoryCardSrc).toMatch(/memory-card-superseded/);
    expect(memoryCardSrc).toMatch(/supersededBy/);
  });
});

describe('R6 G2 — MemoryTraceModal component', () => {
  it('declares the component, requires entryId prop, emits close + jump', () => {
    expect(traceModalSrc).toMatch(/name:\s*'MemoryTraceModal'/);
    expect(traceModalSrc).toMatch(/entryId:/);
    expect(traceModalSrc).toMatch(/emits:\s*\['close',\s*'jump-to-message'\]/);
  });

  it('triggers requestTrace when entryId becomes non-null', () => {
    expect(traceModalSrc).toMatch(/memStore\.requestTrace\s*\(\s*id\s*\)/);
  });

  it('reads trace via memoryStore.traceFor', () => {
    expect(traceModalSrc).toMatch(/memStore\.traceFor\s*\(\s*props\.entryId\s*\)/);
  });

  it('shows entry + sourceRef sections', () => {
    expect(traceModalSrc).toMatch(/memory-trace-entry/);
    expect(traceModalSrc).toMatch(/memory-trace-source/);
  });
});

describe('R6 G2 — VpDetailView Memory section integration', () => {
  it('imports MemoryCard + MemoryTraceModal', () => {
    expect(detailViewSrc).toMatch(/import MemoryCard/);
    expect(detailViewSrc).toMatch(/import MemoryTraceModal/);
  });

  it('auto-fetches memory on vpId change', () => {
    expect(detailViewSrc).toMatch(/queryScope\(\s*\{\s*vpId:\s*id\s*\}\s*\)/);
  });

  it('renders the MemoryTraceModal with traceEntryId binding', () => {
    expect(detailViewSrc).toMatch(/<MemoryTraceModal/);
    expect(detailViewSrc).toMatch(/:entry-id="traceEntryId"/);
  });
});

describe('R6 G2 — backend handlers + dispatch', () => {
  it('web-bridge exports handleUnifyMemoryQuery + handleUnifyMemoryTrace', () => {
    expect(webBridgeSrc).toMatch(/export function handleUnifyMemoryQuery/);
    expect(webBridgeSrc).toMatch(/export function handleUnifyMemoryTrace/);
  });

  it('memory query reads from session.memoryShardStore.query', () => {
    expect(webBridgeSrc).toMatch(/session\.memoryShardStore\.query\(/);
  });

  it('memory trace returns entry.sourceRef', () => {
    expect(webBridgeSrc).toMatch(/sourceRef:\s*entry\.sourceRef/);
  });

  it('replies use unify_memory_query_result + unify_memory_trace_result', () => {
    expect(webBridgeSrc).toMatch(/type:\s*'unify_memory_query_result'/);
    expect(webBridgeSrc).toMatch(/type:\s*'unify_memory_trace_result'/);
  });

  it('message-router dispatches both new message types', () => {
    expect(routerSrc).toMatch(/case 'unify_memory_query':/);
    expect(routerSrc).toMatch(/case 'unify_memory_trace':/);
    expect(routerSrc).toMatch(/handleUnifyMemoryQuery\(msg\)/);
    expect(routerSrc).toMatch(/handleUnifyMemoryTrace\(msg\)/);
  });
});

describe('R6 G2 — i18n keys present in en + zh', () => {
  const requiredKeys = [
    'unify.vp.detail.memory',
    'unify.vp.detail.memoryLoading',
    'unify.vp.detail.memoryEmpty',
    'unify.vp.detail.memoryError',
    'unify.memory.card.trace',
    'unify.memory.card.traceUnavailable',
    'unify.memory.trace.title',
    'unify.memory.trace.entry',
    'unify.memory.trace.source',
    'unify.memory.trace.jump',
  ];
  for (const key of requiredKeys) {
    it(`en carries ${key}`, () => { expect(enI18nSrc).toContain(`'${key}'`); });
    it(`zh-CN carries ${key}`, () => { expect(zhI18nSrc).toContain(`'${key}'`); });
  }
});
