import { createHash, randomUUID } from 'node:crypto';
import { initialOccurrence, nextOccurrence, normalizeRecurrence, validateScheduleTimestamp } from '../work-center/recurrence.js';

const FIELDS = ['prompt', 'enabled', 'notify', 'trigger'];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function configKey(task) {
  return JSON.stringify(canonical({ prompt: task.prompt, enabled: task.enabled,
    notify: task.notify !== false, trigger: task.trigger }));
}

/** Legacy definitions get a stable config-only revision without a read-time disk write. */
export function scheduledTaskRevision(task) {
  if (typeof task._revision === 'string' && task._revision) return task._revision;
  return `legacy:${createHash('sha256').update(configKey(task)).digest('hex')}`;
}

/** Validate external task definitions only; runtime fields are never writable over the wire. */
export function normalizeScheduledTask(value, previous = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('task must be an object');
  if (Object.keys(value).some(key => !FIELDS.includes(key))) throw new Error('Unknown or read-only task field');
  const input = previous ? { ...publicScheduledTask(previous), ...value } : value;
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 65536) {
    throw new Error('task.prompt must be non-empty text of at most 65536 characters');
  }
  if (typeof input.enabled !== 'boolean') throw new Error('task.enabled must be a boolean');
  if (input.notify !== undefined && typeof input.notify !== 'boolean') throw new Error('task.notify must be a boolean');
  const trigger = input.trigger;
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) throw new Error('Invalid task.trigger');
  let normalizedTrigger;
  if (trigger.type === 'manual') {
    if (Object.keys(trigger).some(key => key !== 'type')) throw new Error('Unknown manual trigger field');
    normalizedTrigger = { type: 'manual' };
  } else if (trigger.type === 'schedule') {
    if (Object.keys(trigger).some(key => !['type', 'scheduledFor', 'recurrence'].includes(key))) throw new Error('Unknown schedule trigger field');
    normalizedTrigger = { type: 'schedule', scheduledFor: validateScheduleTimestamp(trigger.scheduledFor),
      recurrence: normalizeRecurrence(trigger.recurrence) };
  } else throw new Error('Invalid task.trigger type');
  const next = { prompt: input.prompt.trim(), enabled: input.enabled, notify: input.notify ?? true,
    trigger: normalizedTrigger, nextRunAt: null, lastRun: previous?.lastRun ?? null };
  const sameTrigger = previous && JSON.stringify(previous.trigger) === JSON.stringify(next.trigger);
  if (sameTrigger) {
    next._scheduledRuns = previous._scheduledRuns || 0;
    next.nextRunAt = previous.nextRunAt;
  } else {
    next.nextRunAt = next.trigger.type === 'schedule'
      ? initialOccurrence(next.trigger.recurrence, next.trigger.scheduledFor) : null;
  }
  if (next.trigger.recurrence?.endsAt != null && next.nextRunAt > next.trigger.recurrence.endsAt) next.nextRunAt = null;
  next._revision = previous && configKey(previous) === configKey(next) ? scheduledTaskRevision(previous) : randomUUID();
  return next;
}

/** Explicit, idempotent projection keeps durable scheduler bookkeeping out of Session snapshots. */
export function publicScheduledTask(task) {
  return { prompt: task.prompt, enabled: task.enabled, notify: task.notify !== false,
    trigger: structuredClone(task.trigger), nextRunAt: task.nextRunAt ?? null,
    lastRun: task.lastRun ? structuredClone(task.lastRun) : null,
    revision: typeof task.revision === 'string' && !task._revision ? task.revision : scheduledTaskRevision(task) };
}

export function advanceScheduledTask(task, after) {
  const recurrence = task.trigger.recurrence;
  if (!recurrence || (recurrence.maxRuns != null && (task._scheduledRuns || 0) >= recurrence.maxRuns)) return null;
  const next = nextOccurrence(recurrence, after);
  return next != null && (recurrence.endsAt == null || next <= recurrence.endsAt) ? next : null;
}
