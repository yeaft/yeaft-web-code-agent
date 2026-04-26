/**
 * R6 G1a — Sidebar task subtree (already wired) + TaskDetailView summary
 * timeline + relatedTaskIds folded section + abort_vp / kick_vp menu
 * entries.
 *
 * Static source-level acceptance:
 *   S1 web/stores/tasks.js exposes useTasksStore with summariesByTask state,
 *      summaryFor / isSummaryLoading getters, and taskCrudRequest /
 *      fetchSummaryHistory / applySummaryHistory / applyCrudResult actions.
 *   S2 web/app.js registers useTasksStore on window.Pinia.
 *   S3 chat.js dispatch table forwards unify_summary_history and
 *      unify_task_crud_result events into the store.
 *   S4 UnifyTaskDetailView pulls summary timeline via
 *      tasksStore.summaryFor(taskId) and renders the revisions list.
 *   S5 UnifyTaskDetailView exposes "Show archived" affordance that calls
 *      fetchSummaryHistory(id, true).
 *   S6 UnifyTaskDetailView renders relatedTaskIds folded section with
 *      "Unlink" buttons that issue unrelate via taskCrudRequest.
 *   S7 UnifyTaskDetailView renders per-VP abort/kick entries that issue
 *      abort_vp / kick_vp via taskCrudRequest.
 *   S8 Backend agent/unify/web-bridge.js exports
 *      handleUnifyFetchSummaryHistory and handleUnifyTaskCrud.
 *   S9 message-router.js dispatches the new message types.
 *   S10 i18n (en + zh-CN) carry all unify.taskDetail.summary.* /
 *      unify.taskDetail.related.* / unify.taskDetail.members.* keys.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const tasksStoreSrc = read('web/stores/tasks.js');
const appSrc        = read('web/app.js');
const chatStoreSrc  = read('web/stores/chat.js');
const detailViewSrc = read('web/components/UnifyTaskDetailView.js');
const webBridgeSrc  = read('agent/unify/web-bridge.js');
const routerSrc     = read('agent/connection/message-router.js');
const enI18nSrc     = read('web/i18n/en.js');
const zhI18nSrc     = read('web/i18n/zh-CN.js');

describe('R6 G1a — tasks Pinia store surface', () => {
  it('defines useTasksStore with expected state + getters', () => {
    expect(tasksStoreSrc).toMatch(/defineStore\('tasks'/);
    expect(tasksStoreSrc).toMatch(/summariesByTask:\s*\{\}/);
    expect(tasksStoreSrc).toMatch(/pendingSummaryFetch:\s*\{\}/);
    expect(tasksStoreSrc).toMatch(/summaryFor:\s*\(state\)/);
    expect(tasksStoreSrc).toMatch(/isSummaryLoading:\s*\(state\)/);
  });

  it('exposes taskCrudRequest / fetchSummaryHistory / applySummaryHistory / applyCrudResult', () => {
    expect(tasksStoreSrc).toMatch(/taskCrudRequest\s*\(\s*op\s*,\s*payload/);
    expect(tasksStoreSrc).toMatch(/fetchSummaryHistory\s*\(\s*taskId\s*,\s*includeArchived/);
    expect(tasksStoreSrc).toMatch(/applySummaryHistory\s*\(\s*event\s*\)/);
    expect(tasksStoreSrc).toMatch(/applyCrudResult\s*\(\s*event\s*\)/);
  });

  it('taskCrudRequest sends unify_task_crud over WS', () => {
    expect(tasksStoreSrc).toMatch(/type:\s*'unify_task_crud'/);
  });

  it('fetchSummaryHistory sends unify_fetch_summary_history over WS', () => {
    expect(tasksStoreSrc).toMatch(/type:\s*'unify_fetch_summary_history'/);
  });
});

describe('R6 G1a — Pinia + dispatch wiring', () => {
  it('app.js registers useTasksStore on window.Pinia', () => {
    expect(appSrc).toMatch(/useTasksStore/);
    expect(appSrc).toMatch(/window\.Pinia\.useTasksStore\s*=/);
  });

  it('chat.js dispatch handles unify_summary_history', () => {
    expect(chatStoreSrc).toMatch(/case 'unify_summary_history'/);
    expect(chatStoreSrc).toMatch(/applySummaryHistory\s*\(\s*event\s*\)/);
  });

  it('chat.js dispatch handles unify_task_crud_result', () => {
    expect(chatStoreSrc).toMatch(/case 'unify_task_crud_result'/);
    expect(chatStoreSrc).toMatch(/applyCrudResult\s*\(\s*event\s*\)/);
  });
});

describe('R6 G1a — UnifyTaskDetailView summary timeline + relatedTaskIds + members', () => {
  it('reads summary via tasksStore.summaryFor + isSummaryLoading', () => {
    expect(detailViewSrc).toMatch(/tasksStore\.summaryFor\(/);
    expect(detailViewSrc).toMatch(/tasksStore\.isSummaryLoading\(/);
  });

  it('auto-fetches summary on active task change', () => {
    expect(detailViewSrc).toMatch(/tasksStore\.fetchSummaryHistory\s*\(\s*id\s*,\s*false\s*\)/);
  });

  it('exposes "Show archived" affordance that re-fetches with true', () => {
    expect(detailViewSrc).toMatch(/onShowArchived/);
    expect(detailViewSrc).toMatch(/fetchSummaryHistory\s*\(\s*id\s*,\s*true\s*\)/);
  });

  it('renders summary list with revisions + archived sections', () => {
    expect(detailViewSrc).toMatch(/unify-task-detail-summary-list/);
    expect(detailViewSrc).toMatch(/unify-task-detail-summary-archived/);
  });

  it('renders relatedTaskIds folded section with Unlink button', () => {
    expect(detailViewSrc).toMatch(/relatedTaskIds/);
    expect(detailViewSrc).toMatch(/unify-task-detail-related/);
    expect(detailViewSrc).toMatch(/onUnrelate/);
  });

  it('emits switch-to-task when a related task chip is clicked', () => {
    expect(detailViewSrc).toMatch(/emits:\s*\['back',\s*'switch-to-thread',\s*'switch-to-task'\]/);
    expect(detailViewSrc).toMatch(/\$emit\('switch-to-task'/);
  });

  it('renders per-VP abort + kick action entries', () => {
    expect(detailViewSrc).toMatch(/onAbortVp/);
    expect(detailViewSrc).toMatch(/onKickVp/);
    expect(detailViewSrc).toMatch(/taskCrudRequest\(\s*'abort_vp'/);
    expect(detailViewSrc).toMatch(/taskCrudRequest\(\s*'kick_vp'/);
    expect(detailViewSrc).toMatch(/taskCrudRequest\(\s*'unrelate'/);
  });
});

describe('R6 G1a — backend handlers + dispatch', () => {
  it('web-bridge exports handleUnifyFetchSummaryHistory + handleUnifyTaskCrud', () => {
    expect(webBridgeSrc).toMatch(/export async function handleUnifyFetchSummaryHistory/);
    expect(webBridgeSrc).toMatch(/export async function handleUnifyTaskCrud/);
  });

  it('summary history reply uses unify_summary_history', () => {
    expect(webBridgeSrc).toMatch(/type:\s*'unify_summary_history'/);
  });

  it('task CRUD reply uses unify_task_crud_result', () => {
    expect(webBridgeSrc).toMatch(/type:\s*'unify_task_crud_result'/);
  });

  it('CRUD branches cover relate / unrelate / kick_vp / abort_vp', () => {
    expect(webBridgeSrc).toMatch(/op === 'relate'/);
    expect(webBridgeSrc).toMatch(/op === 'unrelate'/);
    expect(webBridgeSrc).toMatch(/op === 'kick_vp'/);
    expect(webBridgeSrc).toMatch(/op === 'abort_vp'/);
  });

  it('relate/unrelate updates relatedTaskIds bidirectionally', () => {
    expect(webBridgeSrc).toMatch(/relatedTaskIds/);
    expect(webBridgeSrc).toMatch(/taskStore\.update/);
  });

  it('kick_vp routes through taskStore.removeMember', () => {
    expect(webBridgeSrc).toMatch(/taskStore\.removeMember\(\s*taskId\s*,\s*vpId\s*\)/);
  });

  it('summary history streams group log filtered by taskId + summary kind', () => {
    expect(webBridgeSrc).toMatch(/groupHandle\.streamMessages/);
    expect(webBridgeSrc).toMatch(/meta\.kind === 'summary'/);
  });

  it('summary history honours §Δ31.5 current-10 cap and includeArchived flag', () => {
    expect(webBridgeSrc).toMatch(/includeArchived/);
    expect(webBridgeSrc).toMatch(/current\.slice\(0,\s*10\)/);
  });

  it('message-router dispatches both new message types', () => {
    expect(routerSrc).toMatch(/case 'unify_fetch_summary_history':/);
    expect(routerSrc).toMatch(/case 'unify_task_crud':/);
    expect(routerSrc).toMatch(/handleUnifyFetchSummaryHistory\(msg\)/);
    expect(routerSrc).toMatch(/handleUnifyTaskCrud\(msg\)/);
  });
});

describe('R6 G1a — i18n keys present in en + zh', () => {
  const requiredKeys = [
    'unify.taskDetail.summary.title',
    'unify.taskDetail.summary.loading',
    'unify.taskDetail.summary.empty',
    'unify.taskDetail.summary.error',
    'unify.taskDetail.summary.showArchived',
    'unify.taskDetail.related.title',
    'unify.taskDetail.related.unlink',
    'unify.taskDetail.members.title',
    'unify.taskDetail.members.abort',
    'unify.taskDetail.members.kick',
  ];
  for (const key of requiredKeys) {
    it(`en carries ${key}`, () => { expect(enI18nSrc).toContain(`'${key}'`); });
    it(`zh-CN carries ${key}`, () => { expect(zhI18nSrc).toContain(`'${key}'`); });
  }
});
