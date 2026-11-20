// RELEASE-COMMS (owner, 7 Nov 2026): what each production release changed, in plain words for each kind of person.
//   GET /api/v0/whats-new[?limit=1..20]          the latest releases of the product, only the parts for this person
//   GET /api/v0/whats-new/:id/card/:audience     a release's share card picture for one of this person's audiences
// The notes (pulse.release_note, 1844) are written by the release-notes generator on the server after each production
// release; people read them only through pulse.release_notes / pulse.release_note_card (SECURITY DEFINER). A card is
// stored as a data: address; the list names it by address only and this route serves its bytes.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { admin, fail, leadership, type Tx, type Viewer } from './routes.js';

export const PRODUCT = 'vitals';
/** The audiences a release note speaks to, in the order a person's main one is chosen. */
export const AUDIENCES = ['owner', 'managers', 'salespeople', 'hr', 'clients', 'everyone'] as const;
export type Audience = (typeof AUDIENCES)[number];
export type AudienceFacts = { role: string; side?: string; lead?: boolean; workRoles: string[]; headsTeam: boolean };

/** Sides that are not the company's staff: a client seat (the client portal and its links), a channel partner, a guest. */
const OUTSIDE = new Set(['client', 'channel_partner', 'guest']);
const MANAGER_ROLES = new Set(['manager', 'pgs', 'head_pgs', 'sales_head']);
const SALES_ROLES = new Set(['sales', 'sales_head']);

/** Who reads which part of a release note, from the roles Pulse already has (Viewer.role, the person's role
 *  assignments in their current company and whether they head a team, pulse.work_head_pods):
 *  - a client or guest seat (side client, channel_partner or guest)                         → clients only;
 *  - an organisation admin or leadership (owner, founders; HR who also holds leadership)     → every audience;
 *  - a manager: access role manager or PGS, a role manager / pgs / head_pgs / sales_head, or the head of a team
 *                                                                                           → managers + everyone;
 *  - sales: a role sales or sales_head                                                      → salespeople + everyone;
 *  - HR: access role hr or a role hr                                                        → hr + everyone;
 *  - anyone else on the staff side (members, Finance, accountants, AI employees)            → everyone.
 *  A person can be several of these (a sales head is managers + salespeople + everyone). The first audience is their
 *  main one: "For you" on the page, and the share card they see. */
export function audiencesFor(f: AudienceFacts): Audience[] {
  if (f.side && OUTSIDE.has(f.side)) return ['clients'];
  const roles = new Set(f.workRoles);
  if (f.role === 'admin' || f.role === 'leadership' || f.lead || roles.has('admin') || roles.has('leadership')) return [...AUDIENCES];
  const out = new Set<Audience>();
  if (['manager', 'pgs'].includes(f.role) || f.headsTeam || [...roles].some((r) => MANAGER_ROLES.has(r))) out.add('managers');
  if ([...roles].some((r) => SALES_ROLES.has(r))) out.add('salespeople');
  if (f.role === 'hr' || roles.has('hr')) out.add('hr');
  out.add('everyone');
  return AUDIENCES.filter((a) => out.has(a));
}

type Share = { text?: string; image?: string | null };
type Note = { id: number; sha: string; share?: Record<string, Share> } & Record<string, unknown>;

/** A note as the web reads it: each share card's text and its picture's address (never the picture itself). */
export function shapeNote(n: Note) {
  const share: Record<string, { text: string; imageUrl: string | null }> = {};
  for (const [audience, s] of Object.entries(n.share ?? {})) {
    if (!(AUDIENCES as readonly string[]).includes(audience)) continue;
    const text = typeof s?.text === 'string' ? s.text.trim() : '';
    const imageUrl = typeof s?.image === 'string' && /^[0-9a-f]{6,32}$/.test(s.image) ? `/api/v0/whats-new/${n.id}/card/${audience}?v=${s.image}` : null;
    if (text || imageUrl) share[audience] = { text, imageUrl };
  }
  return { ...n, share };
}

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
/** A card's bytes from its data: address, only when they are the picture type they claim (else null). */
export function cardBytes(dataUrl: string | null | undefined): { type: string; bytes: Buffer } | null {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl ?? '');
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length < 12 || bytes.length > 8_000_000 || !MAGIC[m[1]](bytes)) return null;
  return { type: m[1], bytes };
}

/** This person's audiences in their current company (also NEW-DOTS' unseen list, new-dots.ts). */
export async function viewerAudiences(c: PoolClient, v: Viewer): Promise<Audience[]> {
  if (!v.person) return ['everyone'];
  if (v.side && OUTSIDE.has(v.side)) return ['clients'];
  if (admin(v) || leadership(v)) return [...AUDIENCES];
  const r = (await c.query<{ roles: string[]; heads: boolean }>(`select
      coalesce((select array_agg(distinct r.role_key) from pulse.role_assignment r where r.org_id = pulse.current_org() and r.person_id = $1
                 and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')), '{}') roles,
      cardinality(pulse.work_head_pods()) > 0 heads`, [v.person])).rows[0];
  return audiencesFor({ role: v.role, side: v.side, lead: v.lead, workRoles: r?.roles ?? [], headsTeam: !!r?.heads });
}

export function registerWhatsNewRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Querystring: { limit?: string } }>('/api/v0/whats-new', (req) => tx(req, async (c, v) => {
    const audiences = await viewerAudiences(c, v);
    const limit = Math.min(20, Math.max(1, Number.parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const notes = v.person ? (await c.query<{ r: Note[] }>('select pulse.release_notes($1, $2, $3) r', [PRODUCT, audiences, limit])).rows[0].r : [];
    return { audiences, main: audiences[0], notes: notes.map(shapeNote) };
  }));
  app.get<{ Params: { id: string; audience: string } }>('/api/v0/whats-new/:id/card/:audience', (req, reply) => tx(req, async (c, v) => {
    const id = /^[1-9]\d{0,17}$/.test(req.params.id) ? req.params.id : fail(404, 'This picture is not available');
    const audiences = await viewerAudiences(c, v);
    if (!v.person || !(audiences as string[]).includes(req.params.audience)) fail(404, 'This picture is not available');
    const card = cardBytes((await c.query<{ d: string | null }>('select pulse.release_note_card($1::bigint, $2) d', [id, req.params.audience])).rows[0]?.d);
    if (!card) return fail(404, 'This picture is not available');
    // The picture of a release never changes for its address (?v= is its tag): the web proxy keeps it for a month.
    return reply.header('content-type', card.type).header('x-content-type-options', 'nosniff').send(card.bytes);
  }));
}
