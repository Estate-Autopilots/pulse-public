// CONNECT 2 (owner, 22 Oct 2026: "task assignment from them to this organisation or the points of contact of the org"):
// the other organisations' contacts with a seat here (pulse.connect_list's "theirs"), whom the team gives work like
// anyone else. A task for one goes through the connection (pulse.connect_task_give), so it lives here, is shared with
// them and its giver reviews it. Only staff give it (a client or a seat sees no one here).
import type { PoolClient } from 'pg';
import type { Viewer } from './routes.js';

export type ConnectedContact = { id: string; name: string; role: string | null; org: string; connectionId: string };

export async function connectedContacts(c: PoolClient, v: Viewer): Promise<ConnectedContact[]> {
  if (!v.person || (v.side && v.side !== 'staff')) return [];
  type Conn = { id: string; other: { name: string }; theirs: { person: string; name: string; role: string | null }[] | null };
  const list = ((await c.query('select pulse.connect_list() l')).rows[0]?.l ?? []) as Conn[];
  return list.flatMap((conn) => (conn.theirs ?? []).map((t) => ({ id: t.person, name: t.name, role: t.role, org: conn.other.name, connectionId: conn.id })));
}
