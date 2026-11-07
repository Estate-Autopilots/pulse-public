import type { PoolClient } from 'pg';

export const ATTENDANCE_OFF_MESSAGE = 'Attendance is off for your organisation.';

/** Missing policy rows are off. Keep the check read-only so callers can gate before locks or writes. */
export async function attendanceEnabled(c: PoolClient): Promise<boolean> {
  const row = (await c.query(`select coalesce((select attendance_enabled from pulse.hr_policy
    where org_id=pulse.current_org()),false) enabled`)).rows[0];
  return row?.enabled === true;
}
