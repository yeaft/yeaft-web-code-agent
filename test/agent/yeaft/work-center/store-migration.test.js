import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';

describe('Work Center store migration', () => {
  let dir;
  let store;

  afterEach(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('adds dynamic coordination storage without changing legacy WorkItem ownership', () => {
    dir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-dynamic-schema-'));
    const dbPath = join(dir, 'work-center.db');
    store = new WorkItemStore(dbPath, { now: () => 1_000 });

    expect(store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get())
      .toEqual({ value: '42' });
    expect(store.db.prepare('PRAGMA table_info(work_items)').all().map(row => row.name))
      .toEqual(expect.arrayContaining(['coordination_mode', 'final_result', 'delivery_target', 'delivery_instructions', 'title_source', 'requirement']));
    expect(store.db.prepare('PRAGMA table_info(actions)').all().map(row => row.name))
      .toEqual(expect.arrayContaining(['source_action_ids', 'creation_source', 'close_reason', 'closed_at']));
    expect(store.db.prepare('PRAGMA table_info(runs)').all().map(row => row.name))
      .toEqual(expect.arrayContaining(['acceptance_checks', 'outputs']));

    const controller = new WorkflowController(store);
    const legacy = controller.create({
      id: 'legacy-stays-legacy',
      title: 'Legacy item',
      goal: 'Keep the existing execution path',
      acceptanceCriteria: ['Legacy path stays readable'],
      workflowTemplate: 'software-change',
      workDir: '/tmp',
      start: false,
    });
    expect(store.db.prepare('SELECT coordination_mode, final_result, title_source FROM work_items WHERE id = ?')
      .get(legacy.id)).toEqual({
        coordination_mode: 'legacy', final_result: null, title_source: 'explicit',
      });
    store.db.prepare("UPDATE schema_meta SET value = '38' WHERE key = 'schema_version'").run();
    store.db.exec('ALTER TABLE actions DROP COLUMN creation_source');
    store.db.exec('ALTER TABLE work_items DROP COLUMN requirement');
    store.db.exec('ALTER TABLE work_items DROP COLUMN title_source');
    expect(store.db.prepare('PRAGMA table_info(actions)').all().map(row => row.name))
      .not.toContain('creation_source');

    store.close();
    store = new WorkItemStore(dbPath, { now: () => 2_000 });
    expect(store.db.prepare(`SELECT COUNT(*) AS count FROM schema_migrations
      WHERE name IN ('36-dynamic-coordination', '37-run-acceptance-checks',
        '38-action-closure-and-outputs', '39-action-creation-source')`).get()).toEqual({ count: 4 });
    expect(store.db.prepare('PRAGMA table_info(actions)').all().map(row => row.name))
      .toContain('creation_source');
    expect(store.db.prepare('SELECT creation_source FROM actions WHERE work_item_id = ?').all(legacy.id))
      .toEqual([]);
    expect(store.getWorkItem(legacy.id)).toMatchObject({
      title: 'Legacy item', titleSource: 'explicit', requirement: 'Keep the existing execution path',
    });
    expect(store.createNextAction(legacy.id, {
      type: 'custom', stageId: 'legacy-action', instruction: 'Legacy action',
    }).creationSource).toBe('legacy');
  });

});
