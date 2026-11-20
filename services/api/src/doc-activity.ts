// DOCS-ACTIVITY (owner, 17 Nov 2026: "Docs, folders: there is no last editor and no trail. Last activity should be
// visible, and whatever activity happened in a folder, that folder should pop up at the top, so I can find everything"):
//   * each doc's last editor (person or AI employee, with their photo) and its latest activity: an edit, a comment, a
//     move, a share, an archive or restore (doc_version, doc_comment and doc_event, 2320). Views are not activity: they
//     only show in the trail, to the doc's owner and admins (reading receipts);
//   * each folder's latest activity rolled up from everything under it that the viewer can see (docs, files, folders),
//     so a busy folder rises to the top. A private doc's activity never reaches someone who cannot see the doc: the
//     roll-up is read under the viewer's own row security;
//   * a compact trail for a doc (made, edited, commented, shared, moved, viewed) and for a folder (the latest across it).
// Folder and person names are read under the viewer's row security too, so a trail never names a private folder to
// someone outside it ("a private folder").
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx } from './routes.js';
import { docId, getDoc, listFolders, type FolderOut } from './docs.js';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHOTO = (a: string) => `(select ph.updated_at::text from pulse.person_photo ph where ph.person_id=${a}.id)`;

export type Who = { id: string; name: string; agent: boolean; photoAt: string | null };
export type Via = 'ai' | 'api' | 'script' | null;
/** What happened. Edits keep their reason: made, imported, edited, restored (an older version), enriched. */
export type ActivityKind = 'created' | 'imported' | 'edited' | 'restored' | 'enriched' | 'commented' | 'resolved' | 'moved' | 'shared' | 'unshared' | 'access'
  | 'archived' | 'unarchived' | 'renamed' | 'added' | 'viewed';
export type Activity = { at: string; kind: ActivityKind; by: Who | null; via: Via; viaLabel: string | null };
export type DocActivity = { last: Activity | null; editedBy: Who | null; editedAt: string | null; editVia: Via; editViaLabel: string | null; madeVia: Via; madeViaLabel: string | null };
export type FolderActivity = Activity & { doc: { id: string; title: string } | null; folder: { id: string; name: string } | null };
export type TrailItem = Activity & { times?: number; doc?: { id: string; title: string } | null; folder?: { id: string; name: string } | null; words?: string | null;
  from?: string | null; to?: string | null; person?: string | null; role?: string | null; note?: string | null; readPct?: number | null };

const REASON_KIND: Record<string, ActivityKind> = { create: 'created', import: 'imported', edit: 'edited', restore: 'restored', enrich: 'enriched' };
const EVENT_KIND: Record<string, ActivityKind> = { created: 'created', moved: 'moved', shared: 'shared', unshared: 'unshared', access: 'access', archived: 'archived', restored: 'unarchived', renamed: 'renamed' };
const isVia = (v: unknown): Via => v === 'ai' || v === 'api' || v === 'script' ? v : null;
const ts = (v: unknown) => v instanceof Date ? v.toISOString() : String(v ?? '');
const time = (iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isNaN(t) ? -Infinity : t; };
const whoOut = (r: Row | null | undefined): Who | null => r && r.id ? { id: String(r.id), name: String(r.name ?? 'Someone'), agent: r.agent === true, photoAt: (r.photoAt as string) ?? null } : null;

// ------------------------------------------------------------------------------------------------ rules (tested)
/** The newest of several activities (ties: the first given wins, so pass the most telling first). */
export function latest<T extends { at: string } | null | undefined>(...xs: T[]): NonNullable<T> | null {
  let best: NonNullable<T> | null = null;
  for (const x of xs) if (x && time(x.at) > time(best?.at)) best = x as NonNullable<T>;
  return best;
}

/** Each folder's newest activity, its own or anything under it (sub-folders at any depth). `own` holds what happened
 *  directly in a folder (its docs, files and the folder itself); folders not in the list are ignored. */
export function rollUp<A extends { at: string }>(folders: readonly { id: string; parentId: string | null }[], own: ReadonlyMap<string, A>): Map<string, A> {
  const ids = new Set(folders.map((f) => f.id));
  const parent = new Map(folders.map((f) => [f.id, f.parentId && ids.has(f.parentId) ? f.parentId : null]));
  const out = new Map<string, A>();
  for (const [id, a] of own) {
    // Walk up from where it happened; a loop (never stored, but cheap to guard) stops after 16 steps.
    for (let f: string | null | undefined = ids.has(id) ? id : null, hops = 0; f && hops < 16; f = parent.get(f), hops++) {
      const cur = out.get(f);
      if (!cur || time(a.at) > time(cur.at)) out.set(f, a);
    }
  }
  return out;
}

/** Newest first; folders by their newest activity (no activity last), then by name. */
export function byActivity<T extends { name?: string; title?: string; activity?: { at: string } | null }>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => time(b.activity?.at) - time(a.activity?.at) || String(a.name ?? a.title ?? '').localeCompare(String(b.name ?? b.title ?? ''), undefined, { numeric: true }));
}

/** The trail: newest first, at most `limit`. A doc's 'created' version and its 'created' event are one item (the
 *  event knows how it was made). Edits by the same person in a row (newest first) fold into one item that says how many
 *  times; so do views. */
export function mergeTrail(items: readonly TrailItem[], limit = 30, { oneDoc = true }: { oneDoc?: boolean } = {}): TrailItem[] {
  const sorted = [...items].sort((a, b) => time(b.at) - time(a.at));
  const created = oneDoc ? sorted.filter((x) => x.kind === 'created' && !x.folder) : [];
  const keepCreated = created.find((x) => x.via) ?? created[created.length - 1];
  const madeVia = created.find((x) => x.via);
  const out: TrailItem[] = [];
  for (const x of sorted) {
    if (oneDoc && x.kind === 'created' && !x.folder && x !== keepCreated) continue;
    const item = x === keepCreated && madeVia && !x.via ? { ...x, via: madeVia.via, viaLabel: madeVia.viaLabel } : x;
    const prev = out[out.length - 1];
    if (prev && (item.kind === 'edited' || item.kind === 'viewed') && prev.kind === item.kind && prev.by?.id === item.by?.id && (prev.doc?.id ?? null) === (item.doc?.id ?? null)
      && prev.via === item.via) {
      prev.times = (prev.times ?? 1) + (item.times ?? 1);
      continue;
    }
    out.push({ ...item });
    if (out.length >= limit) break;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ reading
/** Last editor, latest activity and how each doc was made, for docs the viewer can see (row security). */
export async function docActivity(c: PoolClient, ids: readonly string[]): Promise<Map<string, DocActivity>> {
  const list = [...new Set(ids.filter((x) => UUID.test(x)))];
  const out = new Map<string, DocActivity>();
  if (!list.length) return out;
  const r = await c.query(`select d.id::text id,
      (select json_build_object('at',v.saved_at,'reason',v.reason,'via',v.via,'viaLabel',v.via_label,'by',(select json_build_object('id',p.id,'name',p.display_name,'agent',p.side='agent','photoAt',${PHOTO('p')}) from pulse.person p where p.id=v.saved_by))
        from pulse.doc_version v where v.org_id=d.org_id and v.doc_id=d.id order by v.saved_at desc limit 1) ver,
      (select json_build_object('at',k.created_at,'by',(select json_build_object('id',p.id,'name',p.display_name,'agent',p.side='agent','photoAt',${PHOTO('p')}) from pulse.person p where p.id=k.person_id))
        from pulse.doc_comment k where k.org_id=d.org_id and k.doc_id=d.id and k.removed_at is null order by k.created_at desc limit 1) com,
      (select json_build_object('at',e.at,'kind',e.kind,'via',e.via,'viaLabel',e.via_label,'by',(select json_build_object('id',p.id,'name',p.display_name,'agent',p.side='agent','photoAt',${PHOTO('p')}) from pulse.person p where p.id=e.actor))
        from pulse.doc_event e where e.org_id=d.org_id and e.doc_id=d.id and e.kind<>'created' order by e.at desc limit 1) ev,
      (select json_build_object('via',e.via,'viaLabel',e.via_label) from pulse.doc_event e where e.org_id=d.org_id and e.doc_id=d.id and e.kind='created' order by e.at limit 1) made,
      d.updated_at::text "updatedAt",(select json_build_object('id',p.id,'name',p.display_name,'agent',p.side='agent','photoAt',${PHOTO('p')}) from pulse.person p where p.id=d.updated_by) upd
    from pulse.doc d where d.id=any($1::uuid[])`, [list]);
  for (const x of r.rows) {
    const ver = x.ver as Row | null, com = x.com as Row | null, ev = x.ev as Row | null, made = x.made as Row | null;
    const editedBy = whoOut((ver?.by as Row) ?? null) ?? whoOut(x.upd as Row);
    const edit: Activity | null = ver ? { at: ts(ver.at), kind: REASON_KIND[String(ver.reason)] ?? 'edited', by: whoOut(ver.by as Row), via: isVia(ver.via) ?? (ver.reason === 'create' || ver.reason === 'import' ? isVia(made?.via) : null),
      viaLabel: (ver.viaLabel as string) ?? (ver.reason === 'create' || ver.reason === 'import' ? (made?.viaLabel as string) ?? null : null) }
      : { at: String(x.updatedAt), kind: 'edited', by: whoOut(x.upd as Row), via: null, viaLabel: null };
    const comment: Activity | null = com ? { at: ts(com.at), kind: 'commented', by: whoOut(com.by as Row), via: null, viaLabel: null } : null;
    const event: Activity | null = ev ? { at: ts(ev.at), kind: EVENT_KIND[String(ev.kind)] ?? 'edited', by: whoOut(ev.by as Row), via: isVia(ev.via), viaLabel: (ev.viaLabel as string) ?? null } : null;
    out.set(String(x.id), { last: latest(edit, comment, event), editedBy, editedAt: ver ? ts(ver.at) : String(x.updatedAt), editVia: edit?.via ?? null, editViaLabel: edit?.viaLabel ?? null,
      madeVia: isVia(made?.via), madeViaLabel: (made?.viaLabel as string) ?? null });
  }
  return out;
}

/** Each visible folder's newest activity, rolled up from everything under it that the viewer can see. */
export async function folderActivity(c: PoolClient, folders: readonly FolderOut[]): Promise<Map<string, FolderActivity>> {
  if (!folders.length) return new Map();
  const [docs, files, own, made] = await Promise.all([
    c.query(`select distinct on (d.folder_id) d.folder_id::text "folderId",d.id::text id,d.title,a.at,a.kind,a.via,a.via_label "viaLabel",a.who
      from pulse.doc d cross join lateral (
        select x.* from (
          (select v.saved_at at,v.reason kind,v.via,v.via_label,v.saved_by who from pulse.doc_version v where v.org_id=d.org_id and v.doc_id=d.id order by v.saved_at desc limit 1)
          union all (select k.created_at,'commented',null,null,k.person_id from pulse.doc_comment k where k.org_id=d.org_id and k.doc_id=d.id and k.removed_at is null order by k.created_at desc limit 1)
          union all (select e.at,'event:'||e.kind,e.via,e.via_label,e.actor from pulse.doc_event e where e.org_id=d.org_id and e.doc_id=d.id and e.kind<>'created' order by e.at desc limit 1)
        ) x order by x.at desc limit 1) a
      where d.folder_id is not null and d.archived_at is null order by d.folder_id,a.at desc`),
    c.query(`select distinct on (f.folder_id) f.folder_id::text "folderId",f.id::text id,f.name,f.added_at at,f.added_by who from pulse.doc_file f
      where f.folder_id is not null and f.doc_id is null and f.archived_at is null order by f.folder_id,f.added_at desc`),
    c.query(`select distinct on (e.folder_id) e.folder_id::text "folderId",e.at,e.kind,e.via,e.via_label "viaLabel",e.actor who from pulse.doc_event e
      where e.folder_id is not null order by e.folder_id,e.at desc`),
    // When each folder was made (list_doc_folders' closed shape has no such field, so it is read here).
    c.query(`select f.id::text id,f.created_at::text at from pulse.doc_folder f where f.archived_at is null`)]);
  const people = await whoMap(c, [...docs.rows, ...files.rows, ...own.rows].map((x) => x.who as string).concat(folders.map((f) => f.createdBy)));
  const madeAt = new Map(made.rows.map((x) => [String(x.id), String(x.at)]));
  const byId = new Map(folders.map((f) => [f.id, f]));
  const direct = new Map<string, FolderActivity>();
  const put = (fid: string, a: FolderActivity) => { const cur = direct.get(fid); if (!cur || time(a.at) > time(cur.at)) direct.set(fid, a); };
  for (const f of folders) {
    // Made: the folder's own start (its creation), so a new empty folder is not last.
    const at = madeAt.get(f.id);
    if (at) put(f.id, { at, kind: 'created', by: people.get(f.createdBy) ?? null, via: null, viaLabel: null, doc: null, folder: { id: f.id, name: f.name } });
  }
  for (const x of own.rows) if (byId.has(String(x.folderId))) {
    const f = byId.get(String(x.folderId))!;
    put(f.id, { at: ts(x.at), kind: EVENT_KIND[String(x.kind)] ?? 'created', by: people.get(String(x.who)) ?? null, via: isVia(x.via), viaLabel: (x.viaLabel as string) ?? null, doc: null, folder: { id: f.id, name: f.name } });
  }
  for (const x of docs.rows) if (byId.has(String(x.folderId))) {
    const k = String(x.kind);
    put(String(x.folderId), { at: ts(x.at), kind: k.startsWith('event:') ? EVENT_KIND[k.slice(6)] ?? 'edited' : k === 'commented' ? 'commented' : REASON_KIND[k] ?? 'edited',
      by: people.get(String(x.who)) ?? null, via: isVia(x.via), viaLabel: (x.viaLabel as string) ?? null, doc: { id: String(x.id), title: String(x.title) }, folder: null });
  }
  for (const x of files.rows) if (byId.has(String(x.folderId))) {
    put(String(x.folderId), { at: ts(x.at), kind: 'added', by: people.get(String(x.who)) ?? null, via: null, viaLabel: null, doc: { id: String(x.id), title: String(x.name) }, folder: null });
  }
  return rollUp(folders, direct);
}

async function whoMap(c: PoolClient, ids: (string | null | undefined)[]): Promise<Map<string, Who>> {
  const list = [...new Set(ids.filter((x): x is string => !!x && UUID.test(x)))];
  if (!list.length) return new Map();
  const r = await c.query(`select p.id::text id,p.display_name name,p.side='agent' agent,${PHOTO('p')} "photoAt" from pulse.person p where p.id=any($1::uuid[])`, [list]);
  return new Map(r.rows.map((x) => [String(x.id), whoOut(x)!]));
}

const ROLE_WORDS: Record<string, string> = { edit: 'can edit', comment: 'can comment', view: 'can view' };
/** A doc's trail: made, edits (by reason), comments and their resolving, shares, access, moves, archive, and (for its
 *  owner and admins, when reading receipts are kept) who read it. */
export async function docTrail(c: PoolClient, id: string, limit = 30): Promise<{ items: TrailItem[]; views: boolean }> {
  const d = await getDoc(c, docId(id));
  const member = (await c.query('select pulse.doc_member_ok() v')).rows[0]?.v === true;
  if (!member) return { items: [], views: false };
  const views = d.canShare; // the owner or an admin (doc_id_can_share); doc_read's own rule decides each row (2320)
  const [vers, coms, evs, reads, folders] = await Promise.all([
    c.query(`select v.saved_at::text at,v.reason,v.via,v.via_label "viaLabel",v.saved_by::text who from pulse.doc_version v where v.doc_id=$1 order by v.saved_at desc limit 200`, [d.id]),
    c.query(`select k.created_at::text at,k.person_id::text who,left(regexp_replace(k.body,'\\s+',' ','g'),90) words,k.resolved_at::text "resolvedAt",k.resolved_by::text "resolvedBy"
      from pulse.doc_comment k where k.doc_id=$1 and k.removed_at is null order by k.created_at desc limit 100`, [d.id]),
    c.query(`select e.at::text at,e.kind,e.via,e.via_label "viaLabel",e.actor::text who,e.detail from pulse.doc_event e where e.doc_id=$1 order by e.at desc limit 100`, [d.id]),
    views ? c.query(`select r.person_id::text who,max(r.last_at)::text at,round(100*max(r.depth))::int pct from pulse.doc_read r where r.doc_id=$1 and r.person_id<>pulse.current_viewer()
      group by r.person_id order by max(r.last_at) desc limit 30`, [d.id]) : Promise.resolve({ rows: [] as Row[] }),
    listFolders(c)]);
  const people = await whoMap(c, [...vers.rows, ...coms.rows, ...evs.rows, ...reads.rows].flatMap((x) => [x.who as string, x.resolvedBy as string,
    ((x.detail as Row | undefined)?.person as string) ?? null]));
  const folderName = folderNamer(folders);
  const items: TrailItem[] = [];
  for (const v of vers.rows) items.push({ at: String(v.at), kind: REASON_KIND[String(v.reason)] ?? 'edited', by: people.get(String(v.who)) ?? null, via: isVia(v.via), viaLabel: (v.viaLabel as string) ?? null });
  for (const k of coms.rows) {
    items.push({ at: String(k.at), kind: 'commented', by: people.get(String(k.who)) ?? null, via: null, viaLabel: null, words: String(k.words ?? '') });
    if (k.resolvedAt) items.push({ at: String(k.resolvedAt), kind: 'resolved', by: people.get(String(k.resolvedBy)) ?? null, via: null, viaLabel: null, words: String(k.words ?? '') });
  }
  for (const e of evs.rows) {
    const x = (e.detail ?? {}) as Row;
    items.push({ at: String(e.at), kind: EVENT_KIND[String(e.kind)] ?? 'edited', by: people.get(String(e.who)) ?? null, via: isVia(e.via), viaLabel: (e.viaLabel as string) ?? null,
      ...(e.kind === 'moved' ? { from: folderName(x.from), to: folderName(x.to) } : {}),
      ...(e.kind === 'access' ? { from: String(x.from ?? ''), to: String(x.to ?? '') } : {}),
      ...(e.kind === 'shared' || e.kind === 'unshared' ? { person: people.get(String(x.person))?.name ?? 'someone', role: ROLE_WORDS[String(x.role)] ?? null } : {}),
      note: typeof x.note === 'string' ? x.note : null });
  }
  for (const r of reads.rows) items.push({ at: String(r.at), kind: 'viewed', by: people.get(String(r.who)) ?? null, via: null, viaLabel: null, readPct: Number(r.pct ?? 0) });
  return { items: mergeTrail(items, limit), views };
}

/** A folder id as the viewer may name it: its name, "My Docs" for the top, "a private folder" for one they cannot see. */
function folderNamer(folders: readonly FolderOut[]) {
  const names = new Map(folders.map((f) => [f.id, f.name]));
  return (v: unknown): string => v === null || v === undefined || v === '' ? 'My Docs' : names.get(String(v)) ?? 'a private folder';
}

/** A folder's trail: the latest across it and everything under it that the viewer can see (docs' edits, comments, moves
 *  and shares, files added, folders made, moved and renamed). */
export async function folderTrail(c: PoolClient, id: string, limit = 30): Promise<{ items: TrailItem[] }> {
  if (!UUID.test(id)) fail(404, 'That folder is not one you can see');
  if (!(await c.query('select pulse.doc_member_ok() v')).rows[0]?.v) fail(403, 'Docs are for the company\'s staff and AI employees');
  const folders = await listFolders(c);
  if (!folders.some((f) => f.id === id)) fail(404, 'That folder is not one you can see');
  const under = new Set([id]);
  for (let grew = true; grew;) { grew = false; for (const f of folders) if (f.parentId && under.has(f.parentId) && !under.has(f.id)) { under.add(f.id); grew = true; } }
  const ids = [...under];
  const [vers, coms, evs, files] = await Promise.all([
    c.query(`select v.saved_at::text at,v.reason,v.via,v.via_label "viaLabel",v.saved_by::text who,d.id::text doc,d.title from pulse.doc_version v join pulse.doc d on d.id=v.doc_id
      where d.folder_id=any($1::uuid[]) and d.archived_at is null order by v.saved_at desc limit 120`, [ids]),
    c.query(`select k.created_at::text at,k.person_id::text who,d.id::text doc,d.title from pulse.doc_comment k join pulse.doc d on d.id=k.doc_id
      where d.folder_id=any($1::uuid[]) and d.archived_at is null and k.removed_at is null order by k.created_at desc limit 60`, [ids]),
    c.query(`select e.at::text at,e.kind,e.via,e.via_label "viaLabel",e.actor::text who,e.detail,e.doc_id::text doc,d.title,e.folder_id::text folder from pulse.doc_event e
      left join pulse.doc d on d.id=e.doc_id where (e.folder_id=any($1::uuid[]) or (d.folder_id=any($1::uuid[]) and d.archived_at is null)) order by e.at desc limit 120`, [ids]),
    c.query(`select f.added_at::text at,f.added_by::text who,f.id::text id,f.name from pulse.doc_file f where f.folder_id=any($1::uuid[]) and f.doc_id is null and f.archived_at is null
      order by f.added_at desc limit 40`, [ids])]);
  const people = await whoMap(c, [...vers.rows, ...coms.rows, ...evs.rows, ...files.rows].flatMap((x) => [x.who as string, ((x.detail as Row | undefined)?.person as string) ?? null]));
  const folderName = folderNamer(folders);
  const items: TrailItem[] = [];
  for (const v of vers.rows) items.push({ at: String(v.at), kind: REASON_KIND[String(v.reason)] ?? 'edited', by: people.get(String(v.who)) ?? null, via: isVia(v.via), viaLabel: (v.viaLabel as string) ?? null,
    doc: { id: String(v.doc), title: String(v.title) } });
  for (const k of coms.rows) items.push({ at: String(k.at), kind: 'commented', by: people.get(String(k.who)) ?? null, via: null, viaLabel: null, doc: { id: String(k.doc), title: String(k.title) } });
  for (const e of evs.rows) {
    const x = (e.detail ?? {}) as Row;
    // A doc's 'created' is already its first version; a folder's is its own line.
    if (e.kind === 'created' && e.doc) continue;
    items.push({ at: String(e.at), kind: EVENT_KIND[String(e.kind)] ?? 'edited', by: people.get(String(e.who)) ?? null, via: isVia(e.via), viaLabel: (e.viaLabel as string) ?? null,
      doc: e.doc ? { id: String(e.doc), title: String(e.title ?? 'a doc') } : null, folder: e.folder ? { id: String(e.folder), name: folderName(e.folder) } : null,
      ...(e.kind === 'moved' ? { from: folderName(x.from), to: folderName(x.to) } : {}),
      ...(e.kind === 'renamed' ? { from: String(x.from ?? ''), to: String(x.to ?? '') } : {}),
      ...(e.kind === 'shared' || e.kind === 'unshared' ? { person: people.get(String(x.person))?.name ?? 'someone', role: ROLE_WORDS[String(x.role)] ?? null } : {}),
      note: typeof x.note === 'string' ? x.note : null });
  }
  for (const f of files.rows) items.push({ at: String(f.at), kind: 'added', by: people.get(String(f.who)) ?? null, via: null, viaLabel: null, doc: { id: String(f.id), title: String(f.name) } });
  // Each doc's first version and its 'created' event are the same thing here: keep the version (one line per doc made).
  return { items: mergeTrail(items, limit, { oneDoc: false }) };
}

// ------------------------------------------------------------------------------------------------ screens
export function registerDocActivityRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Params: { id: string } }>('/api/v0/docs/:id/activity', req => tx(req, async c => docTrail(c, req.params.id)));
  app.get<{ Params: { id: string } }>('/api/v0/docs/folders/:id/activity', req => tx(req, async c => folderTrail(c, req.params.id)));
}
