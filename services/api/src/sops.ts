import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, leadership, type Tx, type Viewer } from './routes.js';
import { edges, handoffs, normalizeDoc, timing, type SopDoc } from './sop-model.js';

/** A stored document read back through the model (roles and phases filled in from the steps). */
const readDoc = (raw: unknown): SopDoc => { const n = normalizeDoc(raw); return 'error' in n ? { steps: [], phases: [], roles: [], outputs: [], watch: [] } : n.doc; };
import { confidenceWords, parseSop, type ParsedSop } from './sop-parse.js';

/** SOP-WORKFLOW part 1: the SOP library. Leadership and admins make, import, edit and archive SOPs (pulse.sop_* in 0220);
 *  everyone on the team reads active ones. The Drive refresh captures SOP-like documents (pulse.sop_source) and this
 *  module reads each into steps with sop-parse (with a confidence and its evidence) for leadership to confirm or edit.
 *  The visual view needs the people behind each role: `lanes` lists who holds it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const optId = (x: unknown) => x === undefined || x === null || x === '' ? null : id(x);
const body = { type: 'object' } as const;
const editor = (v: Viewer) => leadership(v);
const str = (x: unknown, max = 200) => typeof x === 'string' ? x.trim().slice(0, max) : '';
const PHOTO = `(select ph.updated_at from pulse.person_photo ph where ph.person_id=p.id)`;

/** The organisation's role names, as written on people's profiles (for the parser's lexicon and the role pickers). */
export async function orgRoles(c: PoolClient) {
  return (await c.query(`select pp.role,count(*)::int n from pulse.people_profile pp join pulse.person p on p.id=pp.person_id
   where p.status='active' and p.side='staff' and pp.role is not null and pp.role<>'' and pp.role !~* '(synthetic|^team member$)' group by 1 order by 2 desc,1`)).rows as { role: string; n: number }[];
}

/** Who holds each role: people whose profile role reads as it ("PGS" ← "PGS", "Senior PGS"), or who hold the role key. */
export async function roleHolders(c: PoolClient, roles: string[]) {
  const out: Record<string, { id: string; name: string; photoAt: string | null; pod: string | null }[]> = {};
  if (!roles.length) return out;
  const staff = (await c.query(`select p.id,p.display_name name,${PHOTO} "photoAt",pp.pod,pp.role,
     coalesce((select array_agg(r.role_key) from pulse.role_assignment r where r.person_id=p.id and current_date between r.valid_from and coalesce(r.valid_to,'infinity')),'{}') keys
   from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.status='active' and p.side='staff' order by p.display_name`)).rows as
    { id: string; name: string; photoAt: string | null; pod: string | null; role: string | null; keys: string[] }[];
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !['the', 'of', 'and'].includes(w));
  for (const role of roles) {
    const want = words(role); if (!want.length) { out[role] = []; continue; }
    out[role] = staff.filter((s) => { const have = words(s.role ?? ''); return want.every((w) => have.includes(w) || have.includes(w + 's')) || s.keys.includes(role.toLowerCase()); })
      .map(({ id: pid, name, photoAt, pod }) => ({ id: pid, name, photoAt, pod })).slice(0, 12);
  }
  return out;
}

function summary(doc: SopDoc) {
  const t = timing(doc);
  return { steps: doc.steps.length, phases: doc.phases.length, roles: doc.roles, handoffs: handoffs(doc).length, decisions: doc.steps.filter((s) => s.kind === 'decision' || s.kind === 'approval').length, minutes: t.minutes, slaHours: t.slaHours };
}

async function library(c: PoolClient, v: Viewer) {
  const rows = (await c.query(`select s.id,s.title,s.purpose,s.status,s.doc,s.owner_role "ownerRole",s.source,s.confidence::float,s.version,s.updated_at "updatedAt",s.category,
     cl.display_name "clientName",s.client_id "clientId",src.name "sourceName",src.text_hash is distinct from s.source_hash and s.source_id is not null "sourceChanged"
   from pulse.sop s left join pulse.client cl on cl.id=s.client_id left join pulse.sop_source src on src.id=s.source_id
   order by s.status='active' desc,s.status='draft' desc,s.updated_at desc limit 300`)).rows;
  // `shape`: the flow's skeleton for the card's small picture (no step text beyond the first few titles).
  const sops = rows.map(({ doc: raw, ...r }) => { const doc = readDoc(raw); return { ...r, ...summary(doc), firstSteps: doc.steps.slice(0, 4).map((s) => s.title),
    shape: doc.steps.map((s) => ({ id: s.id, title: '', kind: s.kind, role: s.role, personId: s.personId, phase: s.phase, next: s.next })) }; });
  let drive = null;
  if (editor(v)) {
    const d = (await c.query(`select count(*) filter(where status='new')::int waiting,count(*) filter(where status='imported')::int imported,count(*) filter(where status='dismissed')::int dismissed,
      max(captured_at) "firstAt",max(updated_at) "lastAt" from pulse.sop_source`)).rows[0];
    drive = d;
  }
  return { canEdit: editor(v), sops, drive };
}

/** A Drive source with the parts it reads as. `full` adds each part's whole document (for review before importing). */
async function sourceView(c: PoolClient, row: Body, known: string[], full: boolean) {
  const parts = parseSop({ title: String(row.name), text: String(row.body), knownRoles: known });
  const imported = (await c.query(`select id,title,status from pulse.sop where source_id=$1 order by created_at`, [row.id])).rows as { id: string; title: string; status: string }[];
  const owner = row.owner_email ? (await c.query(`select p.display_name name from pulse.account a join pulse.person p on p.id=a.holder_person_id where a.handle=$1 limit 1`, [row.owner_email])).rows[0]?.name ?? null : null;
  return {
    id: row.id, name: row.name, link: row.link, path: row.path, mime: row.mime, modifiedAt: row.modified_at, score: Number(row.score), reasons: row.reasons, status: row.status,
    owner: owner ?? row.owner_email ?? null, imported,
    parts: parts.map((p: ParsedSop, i) => ({ index: i, title: p.title, purpose: p.purpose, ownerRole: p.ownerRole, confidence: p.confidence, confidenceWords: confidenceWords(p.confidence), evidence: p.evidence,
      ...summary(p.doc), preview: p.doc.steps.slice(0, 6).map((s) => ({ title: s.title, role: s.role, kind: s.kind })),
      done: imported.find((x) => x.title.toLowerCase() === p.title.toLowerCase())?.id ?? null, ...(full ? { doc: p.doc } : {}) })),
    ...(full ? { excerpt: String(row.body).slice(0, 6000) } : {}),
  };
}

async function readOne(c: PoolClient, v: Viewer, sid: string) {
  const s = (await c.query(`select s.*,s.confidence::float confidence,cl.display_name "clientName",o.display_name "ownerName",
     cb.display_name "confirmedByName",ub.display_name "updatedByName",src.name "sourceName",src.link "sourceLink",src.path "sourcePath",
     src.text_hash is distinct from s.source_hash and s.source_id is not null "sourceChanged"
   from pulse.sop s left join pulse.client cl on cl.id=s.client_id left join pulse.person o on o.id=s.owner_id left join pulse.person cb on cb.id=s.confirmed_by
   left join pulse.person ub on ub.id=s.updated_by left join pulse.sop_source src on src.id=s.source_id where s.id=$1`, [sid])).rows[0];
  if (!s) fail(404, 'SOP not found');
  const doc = readDoc(s.doc);
  const people = await roleHolders(c, doc.roles);
  const named = [...new Set(doc.steps.map((x) => x.personId).filter(Boolean))] as string[];
  const persons = named.length ? (await c.query(`select p.id,p.display_name name,${PHOTO} "photoAt",pp.role,pp.pod from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=any($1)`, [named])).rows : [];
  const versions = (await c.query(`select v.version,v.title,v.note,v.saved_at "savedAt",p.display_name "savedBy" from pulse.sop_version v left join pulse.person p on p.id=v.saved_by where v.sop_id=$1 order by v.version desc limit 30`, [sid])).rows;
  return {
    canEdit: editor(v),
    sop: { id: s.id, title: s.title, purpose: s.purpose, status: s.status, doc, ownerRole: s.owner_role, ownerId: s.owner_id, ownerName: s.ownerName, clientId: s.client_id, clientName: s.clientName,
      category: s.category, tags: s.tags, source: s.source, confidence: s.confidence, version: s.version, updatedAt: s.updated_at, updatedBy: s.updatedByName,
      confirmedAt: s.confirmed_at, confirmedBy: s.confirmedByName, ...(editor(v) ? { sourceName: s.sourceName, sourceLink: s.sourceLink, sourcePath: s.sourcePath, sourceChanged: s.sourceChanged } : {}) },
    summary: summary(doc), edges: edges(doc), handoffs: handoffs(doc).map((e) => `${e.from}>${e.to}`), people, persons, versions,
  };
}

function input(b: Body) {
  const norm = normalizeDoc(b.doc);
  if ('error' in norm) fail(400, norm.error);
  const { doc } = norm as { doc: SopDoc };
  const status = str(b.status, 10) || 'draft';
  if (!['draft', 'active'].includes(status)) fail(400, 'Save as a draft or make it active');
  const confidence = typeof b.confidence === 'number' && b.confidence >= 0 && b.confidence <= 1 ? b.confidence : null;
  return { title: str(b.title), purpose: str(b.purpose, 2000) || null, doc, status, ownerRole: str(b.ownerRole, 80) || null, ownerId: optId(b.ownerId), clientId: optId(b.clientId),
    category: str(b.category, 40) || null, tags: Array.isArray(b.tags) ? b.tags.map((t) => str(t, 40)).filter(Boolean).slice(0, 12) : [], note: str(b.note, 300) || null, confidence };
}

export function registerSopRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/sops', (req) => tx(req, (c, v) => library(c, v)));
  app.get<{ Params: { id: string } }>('/api/v0/sops/:id', (req) => tx(req, (c, v) => readOne(c, v, id(req.params.id))));
  // The organisation's roles (for the editor's role picker and the parser) with how many people hold each.
  app.get('/api/v0/sops/roles', (req) => tx(req, async (c) => { const roles = await orgRoles(c); return { roles, holders: await roleHolders(c, roles.map((r) => r.role)) }; }));

  app.post<{ Body: Body }>('/api/v0/sops', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins make SOPs');
    const x = input(req.body);
    const sid = (await c.query('select pulse.sop_save(null,$1) id', [JSON.stringify({ ...x, source: str(req.body.source, 10) === 'paste' ? 'paste' : 'pulse' })])).rows[0].id as string;
    return { id: sid };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/sops/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins change SOPs');
    const sid = id(req.params.id); const x = input(req.body);
    await c.query('select pulse.sop_save($1,$2)', [sid, JSON.stringify({ ...x, sourceRefreshed: req.body.sourceRefreshed === true })]);
    return readOne(c, v, sid);
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/sops/:id/status', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins change SOPs');
    const status = str(req.body.status, 10); if (!['draft', 'active', 'archived'].includes(status)) fail(400, 'Choose draft, active or archived');
    await c.query('select pulse.sop_set_status($1,$2)', [id(req.params.id), status]);
    return { ok: true, status };
  }));
  // Pasted text read into SOPs, for review before saving (nothing is stored).
  app.post<{ Body: Body }>('/api/v0/sops/parse', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins make SOPs');
    const text = typeof req.body.text === 'string' ? req.body.text.slice(0, 200000) : '';
    if (text.trim().length < 20) fail(400, 'Paste the SOP text: at least a few lines');
    const known = (await orgRoles(c)).map((r) => r.role);
    return { parts: parseSop({ title: str(req.body.title) || 'Pasted SOP', text, knownRoles: known }).map((p) => ({ ...p, confidenceWords: confidenceWords(p.confidence), ...summary(p.doc) })) };
  }));

  // From Drive: what the Drive refresh found, read into steps on the fly.
  app.get<{ Querystring: { status?: string } }>('/api/v0/sops/drive', (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins bring SOPs in from Drive');
    const status = ['new', 'imported', 'dismissed', 'gone'].includes(String(req.query.status)) ? String(req.query.status) : 'new';
    const known = (await orgRoles(c)).map((r) => r.role);
    const rows = (await c.query(`select id,name,link,path,mime,modified_at,score,reasons,status,owner_email,body from pulse.sop_source where status=$1 order by score desc,name limit 80`, [status])).rows;
    const counts = (await c.query(`select status,count(*)::int n from pulse.sop_source group by 1`)).rows.reduce((o: Record<string, number>, r) => ({ ...o, [r.status]: r.n }), {});
    const last = (await c.query(`select max(updated_at) at from pulse.sop_source`)).rows[0].at;
    const sources = [];
    for (const r of rows) sources.push(await sourceView(c, r, known, false));
    return { status, counts, lastAt: last, sources };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/sops/drive/:id', (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins bring SOPs in from Drive');
    const r = (await c.query(`select id,name,link,path,mime,modified_at,score,reasons,status,owner_email,body from pulse.sop_source where id=$1`, [id(req.params.id)])).rows[0] ?? fail(404, 'That document is no longer listed');
    const known = (await orgRoles(c)).map((x) => x.role);
    return { source: await sourceView(c, r, known, true), people: await roleHolders(c, [...new Set(parseSop({ title: r.name, text: r.body, knownRoles: known }).flatMap((p) => p.doc.roles))]) };
  }));
  // Confirm one part as an SOP (as read, or as edited in the review), active at once or as a draft.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/sops/drive/:id/import', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins bring SOPs in from Drive');
    const sid = id(req.params.id);
    const r = (await c.query(`select id,name,body from pulse.sop_source where id=$1`, [sid])).rows[0] ?? fail(404, 'That document is no longer listed');
    const known = (await orgRoles(c)).map((x) => x.role);
    const parts = parseSop({ title: r.name, text: r.body, knownRoles: known });
    const index = Number.isInteger(req.body.part) ? Number(req.body.part) : 0;
    const p = parts[index] ?? fail(400, 'That part of the document is not an SOP');
    const edited = req.body.doc ? input({ ...req.body, status: req.body.status ?? 'active' }) : null;
    const x = edited ?? { title: p.title, purpose: p.purpose, doc: p.doc, status: str(req.body.status, 10) === 'draft' ? 'draft' : 'active', ownerRole: p.ownerRole, ownerId: null, clientId: null, category: null, tags: [], note: null, confidence: p.confidence };
    const made = (await c.query('select pulse.sop_save(null,$1) id', [JSON.stringify({ ...x, title: x.title || p.title, confidence: p.confidence, sourceId: sid })])).rows[0].id as string;
    return { id: made };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/sops/drive/:id/dismiss', (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins bring SOPs in from Drive');
    await c.query('select pulse.sop_source_decide($1,true)', [id(req.params.id)]); return { ok: true };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/sops/drive/:id/restore', (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins bring SOPs in from Drive');
    await c.query('select pulse.sop_source_decide($1,false)', [id(req.params.id)]); return { ok: true };
  }));
}
