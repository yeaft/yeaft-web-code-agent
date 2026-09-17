// Calendar computation is pure and independent of dispatch / Agent local timezone.
// Keep arithmetic and Intl in a bounded, supported date range (1970–2099).
export const MAX_SCHEDULE_TIMESTAMP = Date.UTC(2100, 0, 1) - 1;
const DAY = 86_400_000;

export function validateScheduleTimestamp(value, name = 'scheduledFor') {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SCHEDULE_TIMESTAMP) {
    throw new Error(`${name} must be epoch milliseconds between 1970 and 2099`);
  }
  return value;
}

export function normalizeRecurrence(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid recurrence');
  const allowed = ['frequency', 'timeZone', 'time', 'weekdays', 'dayOfMonth', 'endsAt', 'maxRuns'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown recurrence field');
  if (!['daily', 'weekdays', 'weekly', 'monthly'].includes(value.frequency)) throw new Error('Invalid recurrence frequency');
  if (typeof value.timeZone !== 'string' || value.timeZone.length > 100 || /^[+-]/.test(value.timeZone)) throw new Error('Invalid recurrence timeZone');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }); } catch { throw new Error('Invalid recurrence timeZone'); }
  if (typeof value.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new Error('Invalid recurrence time');
  if (value.weekdays !== undefined && (!Array.isArray(value.weekdays) || value.weekdays.length > 7
      || value.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)
      || new Set(value.weekdays).size !== value.weekdays.length)) throw new Error('Invalid recurrence weekdays');
  if (value.frequency === 'weekly' && !value.weekdays?.length) throw new Error('Weekly recurrence requires weekdays');
  if (value.dayOfMonth !== undefined && (!Number.isInteger(value.dayOfMonth) || value.dayOfMonth < 1 || value.dayOfMonth > 31)) throw new Error('Invalid recurrence dayOfMonth');
  if (value.frequency === 'monthly' && value.dayOfMonth === undefined) throw new Error('Monthly recurrence requires dayOfMonth');
  if (value.endsAt != null) validateScheduleTimestamp(value.endsAt, 'endsAt');
  if (value.maxRuns != null && (!Number.isInteger(value.maxRuns) || value.maxRuns < 1 || value.maxRuns > 1000)) throw new Error('Invalid recurrence maxRuns');
  return { frequency: value.frequency, timeZone: value.timeZone, time: value.time,
    ...(value.weekdays !== undefined ? { weekdays: [...value.weekdays].sort() } : {}),
    ...(value.dayOfMonth !== undefined ? { dayOfMonth: value.dayOfMonth } : {}),
    endsAt: value.endsAt ?? null, maxRuns: value.maxRuns ?? null };
}

function calendar(recurrence) {
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: recurrence.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const parts = timestamp => Object.fromEntries(formatter.formatToParts(timestamp)
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const localEpoch = timestamp => {
    const p = parts(timestamp);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  };
  return { parts, localEpoch };
}

// Resolve a wall time by trying nearby UTC offsets. Gaps have no matching instant;
// folds select the earlier instant, so a local date can never execute twice.
function wallInstant(date, recurrence, localEpoch) {
  const [hour, minute] = recurrence.time.split(':').map(Number);
  const wall = date + hour * 3_600_000 + minute * 60_000;
  const candidates = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = wall + hours * 3_600_000;
    const candidate = wall - (localEpoch(probe) - probe);
    if (localEpoch(candidate) === wall) candidates.add(candidate);
  }
  return candidates.size ? Math.min(...candidates) : null;
}

function matchesDate(date, recurrence) {
  const d = new Date(date);
  const weekday = d.getUTCDay();
  if (recurrence.frequency === 'weekdays') return weekday > 0 && weekday < 6;
  if (recurrence.frequency === 'weekly') return recurrence.weekdays.includes(weekday);
  if (recurrence.frequency === 'monthly') {
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return d.getUTCDate() === Math.min(recurrence.dayOfMonth, last);
  }
  return true;
}

function findOccurrence(recurrence, timestamp, direction) {
  validateScheduleTimestamp(timestamp);
  const { parts, localEpoch } = calendar(recurrence);
  const p = parts(timestamp);
  const date = Date.UTC(p.year, p.month - 1, p.day);
  // Monthly schedules need at most 62 days even around a skipped civil date.
  // A hard bound also protects dispatch from malformed persisted data.
  for (let day = 0; day < 370; day++) {
    const candidateDate = date + day * direction * DAY;
    if (!matchesDate(candidateDate, recurrence)) continue;
    const candidate = wallInstant(candidateDate, recurrence, localEpoch);
    if (candidate == null || candidate < 0 || candidate > MAX_SCHEDULE_TIMESTAMP) continue;
    if (direction > 0 ? candidate > timestamp : candidate <= timestamp) return candidate;
  }
  return null;
}

export function nextOccurrence(recurrence, after) {
  return findOccurrence(recurrence, after, 1);
}

export function latestOccurrence(recurrence, at) {
  return findOccurrence(recurrence, at, -1);
}

export function initialOccurrence(recurrence, scheduledFor) {
  validateScheduleTimestamp(scheduledFor);
  if (!recurrence || latestOccurrence(recurrence, scheduledFor) === scheduledFor) return scheduledFor;
  return nextOccurrence(recurrence, scheduledFor);
}
