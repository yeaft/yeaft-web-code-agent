// Browser form projection only. The Agent owns persisted recurrence and dispatch.
export function scheduleTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function dateInZone(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const get = type => parts.find(part => part.type === type)?.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

export function normalizeScheduleTime(value) {
  return /^\d{4}$/.test(value) ? `${value.slice(0, 2)}:${value.slice(2)}` : value;
}

export function scheduleDraft(now = Date.now()) {
  const timeZone = scheduleTimeZone();
  const { date, time } = dateInZone(now + 3600000, timeZone);
  return { date, time, timeZone, frequency: 'once', weekdays: [1], dayOfMonth: Number(date.slice(-2)), end: 'never', endDate: '', maxRuns: 10 };
}

export function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  const stamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === date;
}

// Choose the earlier occurrence at a DST fold; a nonexistent wall time is invalid.
export function wallTimeToEpoch(date, time, timeZone) {
  if (!validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')) return null;
  try {
    const wall = Date.parse(`${date}T${time}:00Z`);
    const offsets = new Set();
    for (const hours of [-36, 0, 36]) {
      const sample = wall + hours * 3600000;
      const local = dateInZone(sample, timeZone);
      offsets.add(Date.parse(`${local.date}T${local.time}:00Z`) - sample);
    }
    const candidates = [...offsets].map(offset => wall - offset).filter(candidate => {
      const local = dateInZone(candidate, timeZone);
      return local.date === date && local.time === time;
    });
    return candidates.length ? Math.min(...candidates) : null;
  } catch { return null; }
}

export function scheduleFormResult(draft, now = Date.now()) {
  if (!draft || !validDate(draft.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time || '')) return { error: 'invalidDateTime' };
  const supported = ['once', 'daily', 'weekdays', 'weekly', 'monthly'];
  if (!supported.includes(draft.frequency)) return { error: 'invalidDateTime' };
  try { new Intl.DateTimeFormat('en', { timeZone: draft.timeZone }).format(); }
  catch { return { error: 'invalidTimeZone' }; }
  if (draft.frequency === 'weekly' && (!draft.weekdays?.length || draft.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6))) return { error: 'chooseWeekdays' };
  if (draft.frequency === 'monthly' && (!Number.isInteger(Number(draft.dayOfMonth)) || draft.dayOfMonth < 1 || draft.dayOfMonth > 31)) return { error: 'invalidMonthDay' };
  let scheduledFor = null;
  const start = Date.parse(`${draft.date}T00:00:00Z`);
  for (let offset = 0; offset < (draft.frequency === 'once' ? 1 : 370); offset++) {
    const day = new Date(start + offset * 86400000);
    const weekday = day.getUTCDay();
    if (draft.frequency === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
    if (draft.frequency === 'weekly' && !draft.weekdays.includes(weekday)) continue;
    const lastDay = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
    if (draft.frequency === 'monthly' && day.getUTCDate() !== Math.min(Number(draft.dayOfMonth), lastDay)) continue;
    scheduledFor = wallTimeToEpoch(day.toISOString().slice(0, 10), draft.time, draft.timeZone);
    if (scheduledFor != null) break;
  }
  if (scheduledFor == null) return { error: 'nonexistentTime' };
  if (scheduledFor <= now) return { error: 'futureTime' };
  if (scheduledFor > now + 5 * 366 * 86400000) return { error: 'tooFar' };
  if (draft.frequency === 'once') return { scheduledFor, recurrence: null };
  let endsAt = null;
  let maxRuns = null;
  if (draft.end === 'date') {
    endsAt = wallTimeToEpoch(draft.endDate, '23:59', draft.timeZone);
    if (endsAt == null || endsAt < scheduledFor) return { error: 'invalidEndDate' };
    endsAt += 59999;
  } else if (draft.end === 'count') {
    maxRuns = Number(draft.maxRuns);
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 1000) return { error: 'invalidRunCount' };
  }
  return { scheduledFor, recurrence: {
    frequency: draft.frequency, timeZone: draft.timeZone, time: draft.time,
    ...(draft.frequency === 'weekly' ? { weekdays: [...new Set(draft.weekdays)].sort() } : {}),
    ...(draft.frequency === 'monthly' ? { dayOfMonth: Number(draft.dayOfMonth) } : {}),
    endsAt, maxRuns,
  } };
}
