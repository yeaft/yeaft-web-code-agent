import { afterEach, describe, expect, it } from 'vitest';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { migrateDurableWorkCenterModel } from '../../../../agent/yeaft/work-center/durable-model.js';

// DatabaseSync's newer own accessor is non-configurable. A bound facade models
// the original Node 22.5 API without modifying the native database object.
function withoutTransactionState(db) {
  return { exec: db.exec.bind(db), prepare: db.prepare.bind(db), close: db.close.bind(db) };
}

const databases = [];
afterEach(() => { while (databases.length) databases.pop().close(); });

function fixture() {
  const store = new WorkItemStore(':memory:', { now: () => 1_000 });
  databases.push(store);
  store.db = withoutTransactionState(store.db);
  store.resourceControl.db = store.db;
  expect(store.db.isTransaction).toBeUndefined();
  return { store, controller: new WorkflowController(store) };
}

describe('Node 22.5-compatible synchronous transactions', () => {
  it('keeps migrations and resource-control writes inside an external transaction', () => {
    const { store } = fixture();
    store.db.exec("DELETE FROM schema_migrations WHERE name = '42-recurring-schedules'");
    store.db.exec('BEGIN IMMEDIATE');
    migrateDurableWorkCenterModel(store.db, 2_000, 40);
    expect(store.db.prepare("SELECT name FROM schema_migrations WHERE name = '42-recurring-schedules'").get()).toBeTruthy();
    store.resourceControl.atomic(() => store.createWorkItem({ id: 'external', title: 'External', goal: 'External', workDir: '/tmp' }));
    store.db.exec('ROLLBACK');
    expect(store.getWorkItem('external')).toBeNull();
    expect(store.db.prepare("SELECT name FROM schema_migrations WHERE name = '42-recurring-schedules'").get()).toBeUndefined();
  });
});
