// EST-1474 (T1 slice 1): the Creative Strategy app's API. A sprint per client project (intake: package, Day 1, the named
// client approver, the growth strategist and the creative strategist), its critical inputs (owner, received date) and its
// dated deliverables (done date), and CS Home: "my work" for the signed-in strategist, the Day-1 alerts first. The
// sprint's strategists, leadership and admins open a sprint; leadership and admins open anyone's Home. A client's edit
// carries the time it was made, and an older edit arriving after a newer one changes nothing. Off until the server
// switches the module on (PULSE_CREATIVE=1, modules.ts).
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { CREATIVE_SEED, homeRows, inputsFor, sortHome, sprintClock, type CreativeConfig } from "./creative-model.js";
import { ORG_TZ } from "./org-time.js";
import { fail, leadership, manager, work, type Tx, type Viewer } from "./routes.js";

type Body = Record<string, unknown>;
type Sprint = { id: string; projectId: string; project: string; package: string; dayOne: string; approver: string | null; gsPersonId: string | null;
  gs: string | null; csPersonId: string | null; cs: string | null; status: string; editedAt: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const config: CreativeConfig = CREATIVE_SEED;
const SPRINT = `select s.id,s.project_id "projectId",coalesce(nullif(p.title,''),p.name) project,s.package,s.day_one::text "dayOne",s.approver,
  s.gs_person_id "gsPersonId",g.display_name gs,s.cs_person_id "csPersonId",x.display_name cs,s.status,s.edited_at "editedAt"
  from pulse.creative_sprint s join pulse.project p on p.id=s.project_id
  left join pulse.person g on g.id=s.gs_person_id left join pulse.person x on x.id=s.cs_person_id`;

const day = (x: unknown, what: string) => { const s = String(x ?? ""); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : fail(400, what); };
const person = (x: unknown) => x === null || x === undefined || x === "" ? null : UUID.test(String(x)) ? String(x) : fail(400, "Choose a colleague from the list");
const text = (x: unknown, max: number) => { const s = String(x ?? "").trim(); return s ? s.slice(0, max) : null; };
/** When the edit was made on the device: an older edit than the stored one is ignored. At most a minute ahead of us. */
const editedAt = (x: unknown) => {
  if (x === undefined) return new Date().toISOString();
  const t = Date.parse(String(x)); if (Number.isNaN(t) || t > Date.now() + 60_000) fail(400, "Send when the edit was made");
  return new Date(t).toISOString();
};
const member = (v: Viewer, s: Sprint) => leadership(v) || (!!v.person && (s.csPersonId === v.person || s.gsPersonId === v.person));
const today = async (c: PoolClient) => (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d`)).rows[0].d as string;
/** EST-1792: anyone given work here is an active staff member of this organisation: on start, on reassigning the
 *  strategists and on an item's owner. A person the row already names may stay even if they have since left. */
async function colleague(c: PoolClient, id: string | null, kept?: string | null) {
  if (id && id !== kept && !(await c.query("select 1 from pulse.person where id=$1 and org_id=pulse.current_org() and side='staff' and status='active'", [id])).rowCount)
    fail(400, "Choose an active colleague");
  return id;
}
/** EST-1792: a sprint names its client approver, growth strategist and creative strategist. */
const needed = <T>(x: T | null, what: string) => x ?? fail(400, what);

async function readSprint(c: PoolClient, v: Viewer, id: unknown): Promise<Sprint> {
  if (!UUID.test(String(id))) fail(404, "Sprint not found");
  const s = (await c.query(`${SPRINT} where s.id=$1`, [id])).rows[0] as Sprint | undefined;
  if (!s) return fail(404, "Sprint not found");
  if (!member(v, s)) fail(403, "Only the sprint's strategists, leadership and admins open it");
  return s;
}

async function view(c: PoolClient, s: Sprint) {
  const rows = (await c.query(`select i.kind,i.key,i.owner_person_id "ownerPersonId",o.display_name owner,i.done_on::text "doneOn",i.note,i.edited_at "editedAt"
    from pulse.creative_sprint_item i left join pulse.person o on o.id=i.owner_person_id where i.sprint_id=$1`, [s.id])).rows;
  const of = (kind: string, key: string) => rows.find((r) => r.kind === kind && r.key === key);
  const inputs = inputsFor(config, s.package).map((i) => { const r = of("input", i.key);
    return { key: i.key, label: i.label, ownerPersonId: r?.ownerPersonId ?? null, owner: r?.owner ?? null, receivedOn: r?.doneOn ?? null, note: r?.note ?? null, editedAt: r?.editedAt ?? null }; });
  const clock = sprintClock(config, s, Object.fromEntries(inputs.map((i) => [i.key, i.receivedOn])),
    Object.fromEntries(config.milestones.map((m) => [m.key, of("milestone", m.key)?.doneOn ?? null])), await today(c));
  const milestones = clock.items.map((i) => { const r = of("milestone", i.key);
    return { ...i, ownerPersonId: r?.ownerPersonId ?? null, owner: r?.owner ?? null, note: r?.note ?? null, editedAt: r?.editedAt ?? null }; });
  return { sprint: s, inputs, milestones, clock: { dayOne: clock.dayOne, today: clock.today, day: clock.day, shift: clock.shift, lateInputs: clock.lateInputs, missingInputs: clock.missingInputs },
    approvalWorkingDays: config.approvalWorkingDays, link: `/creative/sprints/${s.id}` };
}

export function registerCreativeRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const body = { type: "object" } as const;
  app.get("/api/v0/creative/config", (req) => tx(req, async (_c, v) => { work(v);
    return { ...config, canStart: leadership(v) || manager(v) }; }));

  // The sprints the viewer works on (leadership and admins: every active one), with where each clock stands.
  app.get("/api/v0/creative/sprints", (req) => tx(req, async (c, v) => {
    work(v);
    const rows = (await c.query(`${SPRINT} where s.status='active' and ($1 or s.cs_person_id=$2 or s.gs_person_id=$2) order by s.day_one desc limit 200`,
      [leadership(v), v.person])).rows as Sprint[];
    const sprints = [];
    for (const s of rows) { const d = await view(c, s);
      sprints.push({ ...s, day: d.clock.day, shift: d.clock.shift, missingInputs: d.clock.missingInputs,
        overdue: d.milestones.filter((m) => m.state === "overdue").length, next: d.milestones.find((m) => m.state !== "done") ?? null }); }
    return { sprints, canStart: leadership(v) || manager(v) };
  }));

  app.post<{ Body: Body }>("/api/v0/creative/sprints", { schema: { body } }, (req) => tx(req, async (c, v) => {
    work(v); if (!leadership(v) && !manager(v)) fail(403, "Leadership, admins and growth strategists start a sprint");
    const b = req.body;
    if (!UUID.test(String(b.projectId))) fail(400, "Choose the client project");
    const pkg = String(b.package ?? ""); if (!config.packages.some((p) => p.key === pkg)) fail(400, "Choose the package");
    const dayOne = day(b.dayOne, "Choose Day 1"), approver = needed(text(b.approver, 120), "Name the client approver");
    const gs = needed(person(b.gsPersonId) ?? v.person, "Choose the growth strategist"), cs = needed(person(b.csPersonId), "Choose the creative strategist");
    if (!(await c.query("select 1 from pulse.project where id=$1 and deleted_at is null", [b.projectId])).rowCount) fail(404, "Project not found");
    for (const p of [gs, cs]) await colleague(c, p);
    const id = (await c.query(`insert into pulse.creative_sprint(org_id,project_id,package,day_one,approver,gs_person_id,cs_person_id,created_by)
      values (pulse.current_org(),$1,$2,$3,$4,$5,$6,$7) on conflict (org_id,project_id) where status='active' do nothing returning id`,
      [b.projectId, pkg, dayOne, approver, gs, cs, v.person])).rows[0]?.id;
    if (!id) fail(409, "This project already has an active sprint");
    for (const i of inputsFor(config, pkg)) await c.query(`insert into pulse.creative_sprint_item(org_id,sprint_id,kind,key,owner_person_id) values (pulse.current_org(),$1,'input',$2,$3)`, [id, i.key, gs]);
    for (const m of config.milestones) await c.query(`insert into pulse.creative_sprint_item(org_id,sprint_id,kind,key,owner_person_id) values (pulse.current_org(),$1,'milestone',$2,$3)`, [id, m.key, cs]);
    return view(c, await readSprint(c, v, id));
  }));

  app.get<{ Params: { id: string } }>("/api/v0/creative/sprints/:id", (req) => tx(req, async (c, v) => {
    work(v); return { ...(await view(c, await readSprint(c, v, req.params.id))), canReassign: leadership(v) || manager(v) }; }));

  // For starting a sprint and choosing owners: client projects without an active sprint, and active colleagues.
  app.get("/api/v0/creative/choices", (req) => tx(req, async (c, v) => {
    work(v);
    const projects = (await c.query(`select p.id,coalesce(nullif(p.title,''),p.name) name,cl.display_name client from pulse.project p left join pulse.client cl on cl.id=p.client_id
      where p.deleted_at is null and p.status is distinct from 'closed' and not exists (select 1 from pulse.creative_sprint s where s.project_id=p.id and s.status='active')
      order by 2 limit 500`)).rows;
    const people = (await c.query("select id,display_name name from pulse.person where side='staff' and status='active' order by 2")).rows;
    return { projects, people, me: v.person };
  }));

  // Intake: package, Day 1, the approver; moving the strategists is for leadership, admins and managers.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/creative/sprints/:id", { schema: { body } }, (req) => tx(req, async (c, v) => {
    work(v); const s = await readSprint(c, v, req.params.id), b = req.body, at = editedAt(b.editedAt);
    const pkg = b.package === undefined ? s.package : String(b.package); if (!config.packages.some((p) => p.key === pkg)) fail(400, "Choose the package");
    const reassign = b.gsPersonId !== undefined || b.csPersonId !== undefined;
    if (reassign && !leadership(v) && !manager(v)) fail(403, "Leadership, admins and growth strategists choose the strategists");
    const status = b.status === undefined ? s.status : String(b.status); if (!["active", "archived"].includes(status)) fail(400, "Choose active or archived");
    const approver = b.approver === undefined ? s.approver : needed(text(b.approver, 120), "Name the client approver");
    const gs = b.gsPersonId === undefined ? s.gsPersonId : await colleague(c, needed(person(b.gsPersonId), "Choose the growth strategist"), s.gsPersonId);
    const cs = b.csPersonId === undefined ? s.csPersonId : await colleague(c, needed(person(b.csPersonId), "Choose the creative strategist"), s.csPersonId);
    await c.query(`update pulse.creative_sprint set package=$2,day_one=$3,approver=$4,gs_person_id=$5,cs_person_id=$6,status=$7,edited_at=$8 where id=$1 and edited_at<$8`,
      [s.id, pkg, b.dayOne === undefined ? s.dayOne : day(b.dayOne, "Choose Day 1"), approver, gs, cs, status, at]);
    for (const i of inputsFor(config, pkg)) await c.query(`insert into pulse.creative_sprint_item(org_id,sprint_id,kind,key,owner_person_id) values (pulse.current_org(),$1,'input',$2,$3)
      on conflict do nothing`, [s.id, i.key, s.gsPersonId]);
    return view(c, (await c.query(`${SPRINT} where s.id=$1`, [s.id])).rows[0]);
  }));

  // One input (received date, owner) or deliverable (done date, owner), with an optional note. The whole item is sent.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/creative/sprints/:id/items", { schema: { body } }, (req) => tx(req, async (c, v) => {
    work(v); const s = await readSprint(c, v, req.params.id), b = req.body, at = editedAt(b.editedAt);
    const kind = String(b.kind ?? ""), key = String(b.key ?? "");
    const known = kind === "input" ? inputsFor(config, s.package).some((i) => i.key === key) : kind === "milestone" && config.milestones.some((m) => m.key === key);
    if (!known) fail(400, "Choose an input or a deliverable of this sprint");
    const doneOn = b.doneOn === null || b.doneOn === undefined || b.doneOn === "" ? null : day(b.doneOn, "Choose the date");
    const kept = (await c.query("select owner_person_id o from pulse.creative_sprint_item where sprint_id=$1 and kind=$2 and key=$3", [s.id, kind, key])).rows[0]?.o ?? null;
    const owner = await colleague(c, person(b.ownerPersonId), kept);
    await c.query(`insert into pulse.creative_sprint_item(org_id,sprint_id,kind,key,owner_person_id,done_on,note,edited_at) values (pulse.current_org(),$1,$2,$3,$4,$5,$6,$7)
      on conflict (sprint_id,kind,key) do update set owner_person_id=excluded.owner_person_id,done_on=excluded.done_on,note=excluded.note,edited_at=excluded.edited_at
      where pulse.creative_sprint_item.edited_at<excluded.edited_at`, [s.id, kind, key, owner, doneOn, text(b.note, 500), at]);
    return view(c, s);
  }));

  // CS Home: the signed-in strategist's work (leadership and admins may open anyone's). Alerts, overdue, today, next.
  app.get<{ Querystring: { person?: string } }>("/api/v0/creative/home", (req) => tx(req, async (c, v) => {
    work(v);
    const asked = req.query.person && req.query.person !== v.person ? String(req.query.person) : null;
    if (asked && !leadership(v)) fail(403, "Leadership and admins open another person's Home");
    const who = asked ?? v.person; if (!who || !UUID.test(who)) fail(403, "An individual account has a Home");
    const name = (await c.query("select display_name from pulse.person where id=$1", [who])).rows[0]?.display_name ?? null;
    if (!name) fail(404, "Person not found");
    const rows = (await c.query(`${SPRINT} where s.status='active' and (s.cs_person_id=$1 or s.gs_person_id=$1)`, [who])).rows as Sprint[];
    const all = [];
    for (const s of rows) { const d = await view(c, s), clock = { ...d.clock, items: d.milestones };
      const mine = homeRows(config, { id: s.id, project: s.project, package: s.package }, clock);
      all.push(...(s.csPersonId === who ? mine : mine.filter((r) => r.kind === "alert" && r.key === "inputs"))); }
    return { person: { id: who, name }, rows: sortHome(all), sprints: rows.length, canChoosePerson: leadership(v) };
  }));
}
