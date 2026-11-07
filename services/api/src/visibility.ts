/** PRIVACY (owner, 2 Nov 2026: "who sees what"): the words for who sees a project or a task. The rules themselves are
 *  row security in the database (1455_privacy_visibility.sql); these routes only set them and say them. */
import type { PoolClient } from 'pg';
import { fail } from './routes.js';

export const VISIBILITY = ['org', 'members', 'leadership'] as const;
export type Visibility = typeof VISIBILITY[number];
export const visibilityOf = (x: unknown): Visibility => VISIBILITY.includes(x as Visibility) ? x as Visibility : fail(400, 'Choose who sees the project: everyone, its members or leadership');

/** "Visible to: …" for a project. */
export function projectVisibleTo(v: unknown): string {
  return v === 'members' ? 'Its members and admins' : v === 'leadership' ? 'Leadership, admins and its members' : 'Everyone in the company';
}
/** "Visible to: …" for a task: a leadership-only task, else its project's rule, else the usual team. */
export function taskVisibleTo(leadershipOnly: unknown, projectVisibility: unknown): string {
  if (leadershipOnly === true) return 'Leadership, admins and the people on this task';
  if (projectVisibility === 'members') return 'The project’s members, admins and the people on this task';
  if (projectVisibility === 'leadership') return 'Leadership, admins, the project’s members and the people on this task';
  return 'The people on it, their pod and managers, HR and leadership';
}

export async function setProjectVisibility(c: PoolClient, project: string, value: unknown) {
  return (await c.query('select pulse.project_visibility_set($1,$2) r', [project, visibilityOf(value)])).rows[0].r as { visibility: Visibility };
}
export async function setTaskLeadershipOnly(c: PoolClient, task: string, on: unknown) {
  return (await c.query('select pulse.task_leadership_only_set($1,$2) r', [task, on === true])).rows[0].r as { leadershipOnly: boolean };
}
