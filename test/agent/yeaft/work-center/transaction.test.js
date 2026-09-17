import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { migrateDurableWorkCenterModel } from '../../../../agent/yeaft/work-center/durable-model.js';
import { withTransaction } from '../../../../agent/yeaft/work-center/transaction.js';

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
  it('commits outermost work and isolates failed nested savepoints', () => {
    const native = new DatabaseSync(':memory:');
    databases.push(native);
    const db = withoutTransactionState(native);
    db.exec('CREATE TABLE entries (id INTEGER)');
    const failure = new Error('nested failure');
    expect(withTransaction(db, () => {
      db.exec('INSERT INTO entries VALUES (1)');
      expect(() => withTransaction(db, () => {
        db.exec('INSERT INTO entries VALUES (2)');
        throw failure;
      })).toThrow(failure);
      return withTransaction(db, () => {
        db.exec('INSERT INTO entries VALUES (3)');
        return 'committed';
      });
    })).toBe('committed');
    expect(db.prepare('SELECT id FROM entries').all().map(row => row.id)).toEqual([1, 3]);
    db.exec('BEGIN IMMEDIATE'); // The wrapper left no transaction open.
    db.exec('ROLLBACK');
  });

  it.each(['BEGIN IMMEDIATE', 'SAVEPOINT external_owner'])('never commits or rolls back a caller-owned %s', boundary => {
    const { store, controller } = fixture();
    store.db.exec(boundary);
    const item = controller.create({ title: 'Caller-owned work', goal: 'Caller-owned work', workDir: '/tmp', start: false });
    expect(() => withTransaction(store.db, () => {
      controller.start(item.id);
      store.enqueueCoordinatorMailbox(item.id, 'test', {}, 'rolled-back-mailbox');
      throw new Error('rollback inner work');
    })).toThrow('rollback inner work');
    expect(store.getWorkItemDetail(item.id)).toMatchObject({ status: 'draft', actions: [] });
    expect(store.db.prepare('SELECT * FROM coordinator_mailbox_entries WHERE source_key = ?').get('rolled-back-mailbox')).toBeUndefined();
    controller.start(item.id);
    expect(store.getWorkItem(item.id).status).toBe('ready');
    store.db.exec('ROLLBACK');
    expect(store.getWorkItem(item.id)).toBeNull();
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM work_item_execution_controls').get().n).toBe(0);
  });

  it.each([null, { frequency: 'daily', timeZone: 'UTC', time: '09:00' }])('dispatches and rolls back nested schedules without isTransaction: %j', recurrence => {
    const { store, controller } = fixture();
    const scheduledFor = Date.parse('2026-03-06T09:00:00Z');
    const plan = controller.create({ title: 'Compatible schedule', goal: 'Compatible schedule', workDir: '/tmp', start: false,
      schedule: { status: 'scheduled', scheduledFor, recurrence } });
    store.db.exec(`CREATE TRIGGER fail_start BEFORE UPDATE OF status ON work_items
      WHEN NEW.status = 'ready' BEGIN SELECT RAISE(ABORT, 'injected start failure'); END`);
    expect(() => controller.startScheduled(plan.id, scheduledFor)).toThrow('injected start failure');
    expect(store.listWorkItems()).toHaveLength(1);
    expect(store.getWorkItemDetail(plan.id)).toMatchObject({ status: 'draft', actions: [],
      schedule: { status: 'scheduled', runCount: 0 } });
    store.db.exec('DROP TRIGGER fail_start');
    const started = controller.startScheduled(plan.id, scheduledFor);
    expect(started.status).toBe('ready');
    expect(controller.startScheduled(plan.id, scheduledFor)).toBeNull();
    expect(store.getExecutionControl(started.id)).toBeTruthy();
  });

  it('keeps migrations and resource-control writes inside an external transaction', () => {
    const { store } = fixture();
    store.db.exec("DELETE FROM schema_migrations WHERE name = '41-recurring-schedules'");
    store.db.exec('BEGIN IMMEDIATE');
    migrateDurableWorkCenterModel(store.db, 2_000, 40);
    expect(store.db.prepare("SELECT name FROM schema_migrations WHERE name = '41-recurring-schedules'").get()).toBeTruthy();
    store.resourceControl.atomic(() => store.createWorkItem({ id: 'external', title: 'External', goal: 'External', workDir: '/tmp' }));
    store.db.exec('ROLLBACK');
    expect(store.getWorkItem('external')).toBeNull();
    expect(store.db.prepare("SELECT name FROM schema_migrations WHERE name = '41-recurring-schedules'").get()).toBeUndefined();
  });
});
