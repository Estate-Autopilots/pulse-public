// DOCS-DRIVE (owner, 8 Nov 2026: "make the UX like how we handle Drive … much nicer for folders, folders under folders,
// documents and so on"): what the Drive-style Docs page and an AI (API v1 / MCP) need on top of docs.ts:
//   * move docs, folders and files into a folder, one or many at once. A move that would let more people see something
//     (out of a private folder) is not made until the caller says so (allowWider), and the answer names who would see it;
//   * bulk actions on many items: archive, restore, add or take off tags, share. Each item is tried on its own, so one
//     refused item never stops the rest, and the answer lists what was refused and why;
//   * stars, each person's own (row security: doc_star, 1893; Recent is kept when a doc is opened, docs.ts);
//   * a doc's details for the side panel: preview, who can see it, versions, links, mentions, reads.
// Who may do what stays the database's rule (doc_can_see / doc_can_edit / doc_id_can_share / doc_folder_update).
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx } from './routes.js';
import { archiveDoc, cleanTags, docId, getDoc, listFolders, listVersions, saveDoc, saveFolder, shareDoc, sharesOf } from './docs.js';
import { docReads, linksOf } from './doc-interactive.js';
import { BULK_ACTIONS, SHARE_ROLES, type BulkAction, type ShareRole } from './doc-drive-lists.js';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ITEM_KINDS = ['doc', 'folder', 'file'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export type Item = { kind: ItemKind; id: string };
export type Refused = Item & { name: string; why: string };
export const MAX_ITEMS = 200;

/** The items sent ({kind, id} or docIds / folderIds / fileIds), checked, without repeats, at most 200. */
export function cleanItems(b: Row): Item[] {
  const raw: unknown[] = [...(Array.isArray(b.items) ? b.items : []),
    ...(['doc', 'folder', 'file'] as const).flatMap((k) => (Array.isArray(b[`${k}Ids`]) ? (b[`${k}Ids`] as unknown[]) : []).map((id) => ({ kind: k, id })))];
  const seen = new Set<string>(), out: Item[] = [];
  for (const x of raw) {
    const r = (x ?? {}) as Row;
    const kind = String(r.kind ?? ''), id = String(r.id ?? '');
    if (!(ITEM_KINDS as readonly string[]).includes(kind) || !UUID.test(id)) fail(400, 'Choose docs, folders or files to change');
    if (seen.has(`${kind}:${id}`)) continue;
    seen.add(`${kind}:${id}`); out.push({ kind: kind as ItemKind, id });
  }
  if (!out.length) fail(400, 'Choose at least one doc, folder or file');
  if (out.length > MAX_ITEMS) fail(413, `Change at most ${MAX_ITEMS} things at a time`);
  return out;
}

/** The private folders an item leaves by moving (its old chain minus its new one): the ones whose people lose the say. */
export const leftBehind = (from: readonly string[], to: readonly string[]) => from.filter((id) => !to.includes(id));

/** Every folder under these folders (not the folders themselves), from the folder list. */
export function foldersUnder(folders: { id: string; parentId: string | null }[], roots: string[]): Set<string> {
  const out = new Set<string>(), queue = [...roots];
  while (queue.length) {
    const id = queue.shift()!;
    for (const f of folders) if (f.parentId === id && !out.has(f.id)) { out.add(f.id); queue.push(f.id); }
  }
  return out;
}

const why = (e: unknown) => {
  const err = e as { statusCode?: number; code?: string; message?: string };
  if (err?.statusCode) return String(err.message);
  if (err?.code === '42501') return 'You can see it but not change it';
  if (err?.code === '22023' && err.message) return err.message;
  return 'It could not be changed. Try again.';
};

async function chainOf(c: PoolClient, cache: Map<string, string[]>, folder: string | null): Promise<string[]> {
  if (!folder) return [];
  if (!cache.has(folder)) cache.set(folder, ((await c.query('select pulse.doc_folder_private_chain($1) v', [folder])).rows[0]?.v as string[]) ?? []);
  return cache.get(folder)!;
}

type Located = Item & { name: string; from: string | null; mattersToOthers: boolean };
/** Where each item is now (what the viewer can see of it). Items not found are refused as not found. */
async function locate(c: PoolClient, items: Item[]): Promise<{ found: Located[]; missing: Refused[] }> {
  const ids = (k: ItemKind) => items.filter((i) => i.kind === k).map((i) => i.id);
  const [docs, folders, files] = await Promise.all([
    c.query('select id::text id,title name,folder_id::text "from",access from pulse.doc where id=any($1::uuid[])', [ids('doc')]),
    c.query('select id::text id,name,parent_id::text "from" from pulse.doc_folder where id=any($1::uuid[])', [ids('folder')]),
    c.query('select id::text id,name,folder_id::text "from" from pulse.doc_file where id=any($1::uuid[]) and doc_id is null', [ids('file')])]);
  const by = new Map<string, Row>();
  for (const [k, r] of [['doc', docs], ['folder', folders], ['file', files]] as const) for (const row of r.rows) by.set(`${k}:${row.id}`, row);
  const found: Located[] = [], missing: Refused[] = [];
  for (const it of items) {
    const r = by.get(`${it.kind}:${it.id}`);
    if (!r) { missing.push({ ...it, name: '', why: `That ${it.kind} is not one you can see` }); continue; }
    // A private doc is its owner's alone wherever it sits, so moving it widens nothing.
    found.push({ ...it, name: String(r.name), from: (r.from as string) ?? null, mattersToOthers: it.kind !== 'doc' || r.access !== 'private' });
  }
  return { found, missing };
}

export type MoveResult = { moved: Item[]; failed: Refused[]; to: { id: string | null; name: string; private: boolean };
  /** Nothing was moved: these would be seen by more people. Ask, then send allowWider true. */
  needsConfirm: null | { message: string; names: string[] } };

/** Move docs, folders and files into a folder (null: out of every folder, to the top of Docs). */
export async function moveItems(c: PoolClient, items: Item[], to: string | null, allowWider: boolean): Promise<MoveResult> {
  if (!(await c.query('select pulse.doc_member_ok() v')).rows[0]?.v) fail(403, 'Docs are for the company\'s staff and AI employees');
  const dest = to ? (await c.query('select id::text id,name,access from pulse.doc_folder where id=$1 and archived_at is null', [UUID.test(to) ? to : fail(400, 'Choose a folder')])).rows[0]
    ?? fail(404, 'That folder is not one you can see') : null;
  const cache = new Map<string, string[]>();
  const toChain = await chainOf(c, cache, to);
  const { found, missing } = await locate(c, items);
  const failed: Refused[] = [...missing], moved: Item[] = [];
  const all = await listFolders(c);
  const nameOf = (id: string) => all.find((f) => f.id === id)?.name ?? 'a private folder';
  const movingFolders = found.filter((i) => i.kind === 'folder').map((i) => i.id);
  const under = foldersUnder(all, movingFolders);
  const todo: Located[] = [];
  for (const it of found) {
    if (it.from === to) { moved.push({ kind: it.kind, id: it.id }); continue; }
    if (it.kind === 'folder' && to && (to === it.id || under.has(to))) { failed.push({ kind: it.kind, id: it.id, name: it.name, why: 'A folder cannot go inside itself' }); continue; }
    todo.push(it);
  }
  if (!allowWider) {
    const wider: { item: string; left: string[] }[] = [];
    for (const it of todo) {
      if (!it.mattersToOthers) continue;
      const left = leftBehind(await chainOf(c, cache, it.from), toChain);
      if (left.length) wider.push({ item: it.name, left: left.map(nameOf) });
    }
    if (wider.length) {
      const where = dest ? `“${dest.name}”` : 'the top of Docs';
      const who = dest && toChain.length ? `the people who can open ${where}` : 'everyone in the company';
      const first = wider[0];
      const message = wider.length === 1
        ? `“${first.item}” is in “${first.left[0]}”, which only some people can see. In ${where}, ${who} will be able to see it.`
        : `${wider.length} of these are in private folders (${[...new Set(wider.flatMap((w) => w.left))].slice(0, 3).map((n) => `“${n}”`).join(', ')}). In ${where}, ${who} will be able to see them.`;
      return { moved: [], failed, to: { id: to, name: dest?.name ?? 'My Docs', private: toChain.length > 0 }, needsConfirm: { message, names: wider.map((w) => w.item) } };
    }
  }
  for (const it of todo) {
    await c.query('savepoint doc_move');
    try {
      if (it.kind === 'doc') await saveDoc(c, it.id, { folderId: to });
      else if (it.kind === 'folder') await saveFolder(c, it.id, { parentId: to });
      else if (!(await c.query('update pulse.doc_file set folder_id=$2 where id=$1 and doc_id is null and archived_at is null returning id', [it.id, to])).rowCount) {
        fail(403, 'Files are moved by whoever added them, and admins');
      }
      await c.query('release savepoint doc_move');
      moved.push({ kind: it.kind, id: it.id });
    } catch (e) {
      await c.query('rollback to savepoint doc_move');
      failed.push({ kind: it.kind, id: it.id, name: it.name, why: why(e) });
    }
  }
  return { moved, failed, to: { id: to, name: dest?.name ?? 'My Docs', private: toChain.length > 0 }, needsConfirm: null };
}

export { BULK_ACTIONS, SHARE_ROLES, type BulkAction, type ShareRole };
/** view: reads only; comment: reads and comments; edit: changes it too. */
export const roleFlags = (role: unknown) => role === 'edit' ? { canEdit: true, canComment: true } : role === 'view' ? { canEdit: false, canComment: false } : { canEdit: false, canComment: true };

/** One action on many items. Each is tried alone; what was refused comes back with the reason in plain words. */
export async function bulkItems(c: PoolClient, items: Item[], action: BulkAction, b: Row): Promise<{ done: Item[]; failed: Refused[] }> {
  if (!(BULK_ACTIONS as readonly string[]).includes(action)) fail(400, `Choose what to do: ${BULK_ACTIONS.join(', ')}`);
  const tags = cleanTags(b.tags);
  if ((action === 'addTags' || action === 'removeTags') && !tags.length) fail(400, 'Write the tag first');
  const access = b.access === undefined ? undefined : ['private', 'company', 'people'].includes(String(b.access)) ? String(b.access) : fail(400, 'A doc is private, the company\'s or chosen people\'s');
  const people = Array.isArray(b.people) ? (b.people as Row[]).slice(0, 100).map((p) => ({ personId: UUID.test(String(p.personId)) ? String(p.personId) : fail(400, 'Choose a person'), role: p.role })) : [];
  if (action === 'share' && access === undefined && !people.length) fail(400, 'Choose who can see them');
  const { found, missing } = await locate(c, items);
  const done: Item[] = [], failed: Refused[] = [...missing];
  for (const it of found) {
    await c.query('savepoint doc_bulk');
    try {
      if (action === 'archive' || action === 'restore') {
        const on = action === 'archive';
        if (it.kind === 'doc') await archiveDoc(c, it.id, on);
        else if (it.kind === 'folder') await saveFolder(c, it.id, { archived: on });
        else if (!(await c.query(`update pulse.doc_file set archived_at=${on ? 'now()' : 'null'} where id=$1 returning id`, [it.id])).rowCount) fail(403, 'Files are archived by whoever added them, and admins');
      } else if (action === 'addTags' || action === 'removeTags') {
        if (it.kind !== 'doc') fail(400, 'Only docs have tags');
        await saveDoc(c, it.id, action === 'addTags' ? { addTags: tags } : { removeTags: tags });
      } else {
        if (it.kind !== 'doc') fail(400, 'Folders are shared from the folder itself (Who can see)');
        const now = people.length ? await sharesOf(c, it.id) : [];
        const merged = new Map(now.map((s) => [s.personId, { personId: s.personId, canEdit: s.canEdit, canComment: (s as { canComment?: boolean }).canComment !== false }]));
        for (const p of people) merged.set(p.personId, { personId: p.personId, ...roleFlags(p.role) });
        await shareDoc(c, it.id, { ...(access ? { access } : people.length ? { access: 'people' } : {}), ...(people.length ? { people: [...merged.values()] } : {}) });
      }
      await c.query('release savepoint doc_bulk');
      done.push({ kind: it.kind, id: it.id });
    } catch (e) {
      await c.query('rollback to savepoint doc_bulk');
      failed.push({ kind: it.kind, id: it.id, name: it.name, why: why(e) });
    }
  }
  return { done, failed };
}

/** A person's own star on a doc or folder (nobody else sees it). */
export async function setStar(c: PoolClient, kind: 'doc' | 'folder', id: string, on: boolean) {
  const col = kind === 'doc' ? 'doc_id' : 'folder_id';
  if (!UUID.test(id)) fail(404, 'Not found');
  if (on) {
    await c.query(`insert into pulse.doc_star(org_id,person_id,${col}) values(pulse.current_org(),pulse.current_viewer(),$1) on conflict do nothing`, [id])
      .catch(() => fail(404, kind === 'doc' ? 'Doc not found' : 'That folder is not one you can see'));
  } else await c.query(`delete from pulse.doc_star where ${col}=$1`, [id]);
  return starsOf(c);
}
export async function starsOf(c: PoolClient): Promise<{ docs: string[]; folders: string[] }> {
  const rows = (await c.query('select doc_id::text d,folder_id::text f from pulse.doc_star order by starred_at desc limit 500')).rows;
  return { docs: rows.filter((r) => r.d).map((r) => r.d), folders: rows.filter((r) => r.f).map((r) => r.f) };
}

/** The side panel: the doc's first words, who can see it, what changed it, what it links to and who read it. */
export async function docDetails(c: PoolClient, id: string) {
  const d = await getDoc(c, docId(id));
  const [shares, versions, links, mentions, reads, comments, folders, stars] = await Promise.all([
    sharesOf(c, d.id), listVersions(c, d.id), linksOf(c, d.id),
    c.query(`select kind,ref_id::text id,label from pulse.doc_mention where doc_id=$1 and kind in ('contract','client','task','project','goal') order by kind,label limit 30`, [d.id]).then((r) => r.rows),
    d.canShare ? docReads(c, d.id) : Promise.resolve([]),
    c.query('select count(*) filter (where resolved_at is null)::int open,count(*)::int total from pulse.doc_comment where doc_id=$1 and removed_at is null', [d.id]).then((r) => r.rows[0]),
    listFolders(c), starsOf(c)]);
  const path: { id: string; name: string; private: boolean }[] = [];
  for (let f = d.folderId, hops = 0; f && hops < 14; hops++) { const x = folders.find((y) => y.id === f); if (!x) break; path.unshift({ id: x.id, name: x.name, private: x.access === 'people' }); f = x.parentId; }
  const { html, ...doc } = d;
  return { doc, preview: html.slice(0, 24000), shares, versions: versions.slice(0, 6), links, mentions, reads: reads.map((r) => ({ name: r.name, summary: r.summary, readPct: r.readPct })),
    comments, path, starred: stars.docs.includes(d.id) };
}

// ------------------------------------------------------------------------------------------------ screens
type Body = Record<string, unknown>;
const body = { type: 'object' } as const;
export function registerDocDriveRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.post<{ Body: Body }>('/api/v0/docs/move', { schema: { body } }, req => tx(req, async c => {
    const b = req.body ?? {};
    return moveItems(c, cleanItems(b), b.to ? String(b.to) : null, b.allowWider === true);
  }));
  app.post<{ Body: Body }>('/api/v0/docs/bulk', { schema: { body } }, req => tx(req, async c => {
    const b = req.body ?? {};
    return bulkItems(c, cleanItems(b), String(b.action ?? '') as BulkAction, b);
  }));
  app.post<{ Body: Body }>('/api/v0/docs/star', { schema: { body } }, req => tx(req, async c => {
    const b = req.body ?? {};
    const kind = b.kind === 'folder' ? 'folder' : b.kind === 'doc' ? 'doc' : fail(400, 'Star a doc or a folder');
    return { starred: await setStar(c, kind, String(b.id ?? ''), b.on !== false) };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/docs/:id/details', req => tx(req, async c => docDetails(c, req.params.id)));
}
