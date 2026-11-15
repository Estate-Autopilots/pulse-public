import type { PoolClient } from 'pg';

/** Older installs have attendance with no opt-in column. Honour an explicit tenant flag when present;
 * otherwise preserve that install's existing policy. Read under the caller's tenant context for every role. */
export async function companionAttendanceEnabled(c: PoolClient): Promise<boolean> {
  const row = (await c.query(`select coalesce((to_jsonb(p)->>'attendance_enabled')::boolean,true) enabled
    from pulse.hr_policy p where org_id=pulse.current_org()`)).rows[0];
  return row?.enabled === true;
}
