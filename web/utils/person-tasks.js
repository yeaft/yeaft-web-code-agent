/** Match the task API keyset: newest creation first, then binary native ID.
 * Updated activity and locale collation never change history boundaries. */
export function comparePersonTasks(a, b) {
  const time = value => {
    const stamp = value == null ? NaN : new Date(value).getTime();
    return Number.isSafeInteger(stamp) && stamp >= 0 ? stamp : 0;
  };
  const left = String(a.recordId ?? a.id), right = String(b.recordId ?? b.id);
  return time(b.createdAt) - time(a.createdAt) || (left < right ? -1 : left > right ? 1 : 0);
}
