import { describe, expect, it } from 'vitest';
import { scheduleFormResult, wallTimeToEpoch, validDate, normalizeScheduleTime, scheduleDateBounds } from '../../web/utils/work-center-schedule.js';

const now = Date.parse('2026-09-17T00:00:00Z');
const draft = overrides => ({ date: '2026-09-18', time: '09:30', timeZone: 'Asia/Shanghai', frequency: 'once', weekdays: [1, 3], dayOfMonth: 31, end: 'never', maxRuns: 10, ...overrides });

describe('Work Center schedule form projection', () => {
  it('normalizes mobile numeric entry without accepting invalid hours', () => {
    expect(normalizeScheduleTime('0930')).toBe('09:30');
    expect(normalizeScheduleTime('09:30')).toBe('09:30');
    expect(normalizeScheduleTime('09')).toBe('09');
    expect(scheduleFormResult(draft({ time: normalizeScheduleTime('2599') }), now).error).toBe('invalidDateTime');
  });
  it('keeps wall time in the selected zone, not the browser or Agent zone', () => {
    expect(scheduleFormResult(draft(), now)).toEqual({ scheduledFor: Date.parse('2026-09-18T01:30:00Z'), recurrence: null });
    expect(scheduleFormResult(draft({ timeZone: 'America/New_York' }), now).scheduledFor).toBe(Date.parse('2026-09-18T13:30:00Z'));
  });
  it('validates real dates, 24-hour time, zones and bounded futures', () => {
    expect(validDate('2026-02-30')).toBe(false);
    expect(scheduleFormResult(draft({ time: '24:00' }), now).error).toBe('invalidDateTime');
    expect(scheduleFormResult(draft({ timeZone: 'Not/A_Zone' }), now).error).toBe('invalidTimeZone');
    expect(scheduleFormResult(draft({ date: '2026-09-16' }), now).error).toBe('futureTime');
    expect(scheduleFormResult(draft({ date: '2040-09-18' }), now).error).toBe('tooFar');
  });
  it('skips weekends and respects chosen weekdays for the first run', () => {
    expect(scheduleFormResult(draft({ date: '2026-09-19', frequency: 'weekdays' }), now).scheduledFor).toBe(Date.parse('2026-09-21T01:30:00Z'));
    expect(scheduleFormResult(draft({ frequency: 'weekly' }), now).scheduledFor).toBe(Date.parse('2026-09-21T01:30:00Z'));
    expect(scheduleFormResult(draft({ frequency: 'weekly', weekdays: [] }), now).error).toBe('chooseWeekdays');
  });
  it('clamps monthly day and validates inclusive end limits', () => {
    expect(scheduleFormResult(draft({ frequency: 'monthly' }), now).scheduledFor).toBe(Date.parse('2026-09-30T01:30:00Z'));
    const result = scheduleFormResult(draft({ frequency: 'daily', end: 'date', endDate: '2026-09-18' }), now);
    expect(result.recurrence.endsAt).toBe(Date.parse('2026-09-18T15:59:59.999Z'));
    expect(scheduleFormResult(draft({ frequency: 'daily', end: 'date', endDate: '2026-09-17' }), now).error).toBe('invalidEndDate');
    expect(scheduleFormResult(draft({ frequency: 'daily', end: 'count', maxRuns: 0 }), now).error).toBe('invalidRunCount');
    expect(scheduleFormResult(draft({ frequency: 'daily', end: 'count', maxRuns: 4 }), now).recurrence.maxRuns).toBe(4);
  });
  it('matches API epoch limits including end-of-day in negative offset zones', () => {
    expect(scheduleFormResult(draft({ frequency: 'daily', end: 'date', endDate: '2100-01-01', timeZone: 'UTC' }), now).error).toBe('supportedRange');
    expect(scheduleFormResult(draft({ frequency: 'daily', end: 'date', endDate: '2099-12-31', timeZone: 'America/Los_Angeles' }), now).error).toBe('supportedRange');
    expect(scheduleFormResult(draft({ frequency: 'daily', end: 'date', endDate: '2099-12-31', timeZone: 'UTC' }), now).recurrence.endsAt).toBe(Date.UTC(2100, 0, 1) - 1);
    expect(scheduleDateBounds('America/Los_Angeles', now).maxEndDate).toBe('2099-12-30');
    expect(scheduleDateBounds('Asia/Shanghai', now).maxEndDate).toBe('2099-12-31');
    expect(scheduleDateBounds('UTC', now).maxStartDate).toBe(new Date(now + 5 * 366 * 86400000).toISOString().slice(0, 10));
    expect(scheduleFormResult(draft({ date: '2100-01-01', timeZone: 'UTC' }), Date.UTC(2099, 0, 1)).error).toBe('supportedRange');
  });
  it('rejects DST gaps for one-shot and resolves folds once to the earlier instant', () => {
    expect(wallTimeToEpoch('2026-03-08', '02:30', 'America/New_York')).toBeNull();
    expect(wallTimeToEpoch('2026-11-01', '01:30', 'America/New_York')).toBe(Date.parse('2026-11-01T05:30:00Z'));
    const result = scheduleFormResult(draft({ date: '2026-03-08', time: '02:30', timeZone: 'America/New_York', frequency: 'daily' }), Date.parse('2026-03-01T00:00:00Z'));
    expect(result.scheduledFor).toBe(Date.parse('2026-03-09T06:30:00Z'));
  });
});
