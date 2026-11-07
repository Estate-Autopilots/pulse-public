// AGENT-API (owner, 4 Nov 2026: "the major thing Pulse needs now is the strongest possible API, MCP and CLI"): the
// small shared kit of the work and money operations (v1-work.ts, v1-money.ts). Schemas are closed, writes land in
// pulse_priv.app_change (who, which app, the value before) and money or destructive writes ask for confirm: true.
import type { PoolClient } from 'pg';
import type { Viewer } from './routes.js';
import { v1Fail, type Closed, type V1Context } from './v1.js';

export const object = (properties: Closed['properties'], required = Object.keys(properties)): Closed =>
  ({ type: 'object', additionalProperties: false, properties, required });
export const uuid = { type: 'string', pattern: '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' };
export const str = { type: 'string' }, maybe = { type: ['string', 'null'] }, bool = { type: 'boolean' }, int = { type: 'integer' };
export const num = { type: 'number' }, maybeNum = { type: ['number', 'null'] }, maybeId = { type: ['string', 'null'], pattern: uuid.pattern };
export const day = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
export const text = (max: number, min = 1) => ({ type: 'string', minLength: min, maxLength: max });
/** Query values arrive as strings. */
export const qText = (max = 120) => ({ type: 'string', minLength: 1, maxLength: max });
export const qBool = { enum: ['true', 'false'] };
export const list = (item: Closed): Closed => object({ items: { type: 'array', items: item } });
/** Money is integer paise (₹1 = 100), as on every Pulse billing screen and the service API. */
export const paise = { type: 'integer', minimum: 0, maximum: 100_000_000_000 };
export const confirm = { type: 'boolean', description: 'Must be true. Pulse refuses money and destructive actions without it and says what would happen, so you can ask the person first.' };

export const one = async <T = unknown>(ctx: V1Context, sql: string, args: unknown[] = []): Promise<T> => (await ctx.client.query(sql, args)).rows[0]?.v as T;
export const rows = async <T = Record<string, unknown>>(ctx: V1Context, sql: string, args: unknown[] = []): Promise<T[]> => (await ctx.client.query(sql, args)).rows as T[];
export const viewerIs = (ctx: V1Context, ...roles: string[]) => one<boolean>(ctx, 'select pulse.viewer_is(variadic $1::text[]) v', [roles]);
/** One ledger row per write, shown in list_my_changes; undo_change reverses the kinds 1510 knows for 7 days. */
export const change = (ctx: V1Context, action: string, subject: string, detail: unknown) =>
  one<string>(ctx, 'select pulse.app_change_add($1,$2,$3) v', [action, subject, JSON.stringify(detail ?? {})]);
export const undoUntil = () => new Date(Date.now() + 7 * 864e5).toISOString();

/** Money and destructive writes: without confirm true nothing changes and the refusal says what would happen. */
export function confirmed(body: unknown, what: string) {
  if ((body as { confirm?: unknown } | undefined)?.confirm !== true) v1Fail(409, `Confirm first: ${what}. Ask the person, then send the same call with confirm true.`);
}

/** Staff and AI members act; a client, freelancer or contact token reaches none of the work and money operations. */
export async function member(ctx: V1Context) {
  const side = await one<string>(ctx, 'select side v from pulse.person where id=pulse.current_viewer()');
  if (side !== 'staff' && side !== 'agent') v1Fail(403, 'Only staff and AI members of this company use these operations');
}

/** The screens' helpers (work.ts, erp.ts) take the signed-in Viewer: the same one, built from the database for the
 *  principal (an OAuth person, a personal or bot token, or an AI member's key). Roles come from the database only. */
export async function viewerOf(ctx: V1Context): Promise<Viewer> {
  const r = (await ctx.client.query(`select p.id person,p.display_name name,p.side,pp.pod,pp.username,pulse.is_accountant(p.id) accountant,
      coalesce((select array_agg(case when x.is_manager_of_unit then 'manager' else x.role_key end) from pulse.role_assignment x where x.person_id=p.id
        and current_date between x.valid_from and coalesce(x.valid_to,'infinity')),'{}') roles
    from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=pulse.current_viewer()`)).rows[0] ?? v1Fail(401, 'No person');
  const roles: string[] = r.roles ?? [];
  const role = r.accountant ? 'accountant' : roles.includes('admin') ? 'admin' : roles.includes('hr') ? 'hr' : roles.includes('leadership') ? 'leadership'
    : roles.includes('finance') ? 'finance' : roles.includes('manager') ? 'manager' : roles.some(x => ['pgs', 'head_pgs'].includes(x)) ? 'pgs' : 'person';
  return { email: r.username ? `pulse:${r.username}` : '', org: ctx.tenantId, person: r.person, role, name: r.name, pod: r.pod ?? null, via: 'password',
    username: r.username ?? null, mustChange: false, side: r.side ?? undefined, ...(role === 'hr' && roles.includes('leadership') ? { lead: true } : {}) };
}

/** An AI member's task needs an active reviewer: its owner (the person who answers for it), as on its profile. */
export const aiReviewer = async (ctx: V1Context): Promise<string | null> => ctx.principal.kind === 'person' ? null
  : (await one<string | null>(ctx, `select m.owner_person_id v from pulse.agent_member m join pulse.person p on p.id=m.owner_person_id
      where m.person_id=pulse.current_viewer() and p.status='active'`)) ?? null;

/** Forgiving words: case, spaces and punctuation ignored ("purepower 5" finds "Pure Power 5.0"), as Akabod asked. */
export const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, '');
export const digits = (s: string) => s.replace(/\D/g, '');
/** SQL for "this column, squashed, contains $n" (the same squash as above). */
export const squashed = (col: string, n: number) => `regexp_replace(lower(coalesce(${col},'')),'[^a-z0-9\\u0900-\\u097f]+','','g') like '%'||$${n}||'%'`;

export type Row = Record<string, unknown>;
export const isoOrNull = (v: unknown) => v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);
export const client = (ctx: V1Context): PoolClient => ctx.client;
