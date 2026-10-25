// Settings an organisation admin manages in the app: the organisation's name, pods, the admin and HR roles, and a
// read-only view of the connected sources. Every change is written to pulse.record_change.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { admin, fail, type Tx, type Viewer } from "./routes.js";
import { driveChangesCard, driveChangesStatus } from "./drive-changes.js";
import { driveTextCard, driveTextStatus } from "./drive-text.js";
import { connectorsCard, connectorsStatus } from "./connectors.js";
import { moduleOff, readModules } from "./modules.js";

type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLES = ["admin","hr","leadership","finance","manager","pgs","head_pgs"];
const PERMISSIONS = ["hr.salary.read", "hr.salary.write", "hr.contact.read", "hr.contact.write", "hr.documents.read"];

export function registerSettingsRoutes(app: FastifyInstance, { tx, syncStatus }: { tx: Tx; syncStatus: (c: PoolClient) => Promise<unknown> }) {
  const body = { type: "object" } as const;
  const must = (v: Viewer) => { if (!admin(v)) fail(403, "Settings are managed by organisation admins"); if (!v.person) fail(403, "A shared login cannot change settings"); };
  const log = (c: PoolClient, v: Viewer, entity: string, id: string, field: string, from: string | null, to: string | null) =>
    c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values ($1,$2,$3,$4,$5,$6,$7)`, [v.org, entity, id, field, from, to, v.person]);
  const podName = (raw: unknown) => { const name = String(raw ?? "").replace(/\s+/g, " ").trim(); if (name.length < 2 || name.length > 40) fail(400, "Give the pod a name of 2 to 40 characters"); return name; };

  app.get("/api/v0/settings", req => tx(req, async (c, v) => {
    if (!admin(v)) fail(403, "Settings are managed by organisation admins");
    const org = (await c.query("select name,slug,code from pulse.org where id=$1", [v.org])).rows[0];
    const member = `jsonb_build_object('id',p.id,'name',p.display_name,'role',pp.role,'photoAt',ph.updated_at,'managerId',pp.manager_id,'userNo',pp.user_no)`;
    const staff = `pulse.people_profile pp join pulse.person p on p.id=pp.person_id and p.side='staff' and p.status='active' left join pulse.person_photo ph on ph.person_id=p.id`;
    const pods = (await c.query(`select u.id,u.name,u.kind,(select count(*)::int from pulse.project pr where pr.unit_id=u.id) projects,
      coalesce((select jsonb_agg(${member} order by p.display_name) from ${staff} where pp.pod=u.name),'[]') members
      from pulse.unit u where u.kind='pod' and u.valid_to is null
      order by array_position(array['Leadership','Pod 1','Pod 2','Shared'],u.name) nulls last,u.name`)).rows;
    const unassigned = (await c.query(`select p.id,p.display_name name,pp.role,ph.updated_at "photoAt",pp.manager_id "managerId",pp.user_no "userNo" from ${staff}
      where pp.pod is null or pp.pod not in (select name from pulse.unit where kind='pod' and valid_to is null) order by p.display_name`)).rows;
    const roles = (await c.query(`select r.person_id "personId",p.display_name name,r.role_key "role",r.valid_from::text since,coalesce(pp.accounts,'{}') accounts
      from pulse.role_assignment r join pulse.person p on p.id=r.person_id left join pulse.people_profile pp on pp.person_id=p.id
      where r.role_key=any($1) and current_date between r.valid_from and coalesce(r.valid_to,'infinity') order by r.role_key,p.display_name`, [ROLES])).rows;
    const people = (await c.query(`select p.id,p.display_name name,pp.role,pp.pod,pp.manager_id "managerId",pp.user_no "userNo",ph.updated_at "photoAt"
      from ${staff} order by p.display_name`)).rows;
    // Who holds each restricted HR permission now (a revoked row stays in the table so the sync cannot hand it back).
    // Named grants apply to operational admins; HR and leadership own people-data access.
    const permissions = (await c.query(`select s.person_id "personId",p.display_name name,s.permission,s.granted_by "grantedBy",s.granted_at "grantedAt",
      exists(select 1 from pulse.role_assignment r where r.person_id=s.person_id and r.role_key=any($1)
        and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) effective
      from pulse.sensitive_permission s join pulse.person p on p.id=s.person_id where s.revoked_at is null order by p.display_name,s.permission`, [["admin","hr","leadership"]])).rows;
    const canGrant = !!v.person && (await c.query("select pulse.viewer_is('admin') and pulse.hr_can('hr.salary.read') ok")).rows[0].ok;
    // 1042: salary by named list (off: by the HR and leadership roles). byRoleOnly: who holds salary by the HR or
    // leadership role without the matching named grants, so loses it while the list is on: "salary" (no "Read salary")
    // or "edit" (reads by grant, edits by role).
    const salaryList = (await c.query(`select pulse.salary_named_list() "on",l.changed_at "changedAt",(select display_name from pulse.person where id=l.changed_by) "changedBy",
      coalesce((select jsonb_agg(jsonb_build_object('personId',x.id,'name',x.name,'loses',case when x.r then 'edit' else 'salary' end) order by x.name) from
        (select p.id,p.display_name name,
           exists(select 1 from pulse.sensitive_permission s where s.person_id=p.id and s.permission='hr.salary.read' and s.revoked_at is null) r,
           exists(select 1 from pulse.sensitive_permission s where s.person_id=p.id and s.permission='hr.salary.write' and s.revoked_at is null) w
         from pulse.person p where p.side='staff' and p.status='active' and exists(select 1 from pulse.role_assignment a where a.person_id=p.id
           and a.role_key in ('hr','leadership') and current_date between a.valid_from and coalesce(a.valid_to,'infinity'))) x where not (x.r and x.w)),'[]') "byRoleOnly"
      from (select 1) x left join pulse.comp_salary_list l on l.org_id=$1`, [v.org])).rows[0];
    const sync = await syncStatus(c) as { lastIndexedAt: string | null; upstreamAt: string | null };
    const n = (await c.query(`select (select count(*)::int from pulse.index_file) files,
      (select count(*)::int from pulse.account where provider='google' and purpose like 'Workspace%') workspace,
      (select count(distinct person_id)::int from pulse.person_source where source='groups_roster') groups,
      (select count(distinct person_id)::int from pulse.person_source where source='ops_hub') ops,
      (select count(distinct source_ref)::int from pulse.person_source where source='hr_document') "hrDocs",
      (select max(seen_at) from pulse.person_source) "rosterAt",(select count(*)::int from pulse.campaign) campaigns`)).rows[0];
    const sources = [
      { key: "drive", label: "Google Drive index", detail: `${n.files.toLocaleString("en-IN")} files indexed. Feeds projects, clients, contacts and deliveries.`, state: n.files ? "connected" : "planned", lastAt: n.files ? sync.upstreamAt : null },
      { key: "workspace", label: "Google Workspace directory", detail: `${n.workspace} company accounts. Decides who can sign in with Google.`, state: n.workspace ? "connected" : "planned", lastAt: n.workspace ? sync.lastIndexedAt : null },
      { key: "hr-documents", label: "HR documents in Drive", detail: `${n.hrDocs} salary, HR and attendance sheets read for the roster and the restricted HR records.`, state: n.hrDocs ? "connected" : "planned", lastAt: n.hrDocs ? n.rosterAt : null },
      { key: "groups", label: "Planned Workspace groups roster", detail: `${n.groups} people named. A file kept by the admin; it is read at every sync.`, state: "manual", lastAt: n.groups ? n.rosterAt : null },
      { key: "ops-hub", label: "Ops Hub team list", detail: `${n.ops} people named. Copied from the Ops Hub by hand; a live connection is not set up.`, state: "manual", lastAt: n.ops ? n.rosterAt : null },
      { key: "meta-ads", label: "Meta Ads", detail: n.campaigns ? `${n.campaigns} campaigns stored.` : "The collector exists; no ad account is connected on this environment.", state: n.campaigns ? "connected" : "planned", lastAt: null },
      driveChangesCard(await driveChangesStatus(c)),
      driveTextCard(await driveTextStatus(c)),
      // RELEASE-6: R52's card only while its module is on (modules.ts: PULSE_CONNECTORS=1 or setup).
      ...(moduleOff(await readModules(c, v.org), "connectors") ? [] : [connectorsCard(await connectorsStatus(c))]),
    ];
    const runs = (await c.query(`select id,source,started_at "startedAt",finished_at "finishedAt",ok,error,upstream_at "upstreamAt"
      from pulse.sync_run order by started_at desc limit 15`)).rows;
    return { canEdit: !!v.person, org, pods, unassigned, roles, people, permissions, canGrant, salaryList, sources, sync, runs };
  }));

  app.post<{ Body: Body }>("/api/v0/settings/org", { schema: { body } }, req => tx(req, async (c, v) => {
    must(v);
    const name = String(req.body.name ?? "").replace(/\s+/g, " ").trim();
    if (name.length < 2 || name.length > 80) fail(400, "Give the organisation a name of 2 to 80 characters");
    const before = (await c.query("select name from pulse.org where id=$1", [v.org])).rows[0].name;
    if (before !== name) { await c.query("update pulse.org set name=$1 where id=$2", [name, v.org]); await log(c, v, "org", v.org, "name", before, name); }
    return { ok: true };
  }));

  app.post<{ Body: Body }>("/api/v0/settings/pods", { schema: { body } }, req => tx(req, async (c, v) => {
    must(v);
    const name = podName(req.body.name);
    if ((await c.query("select 1 from pulse.unit where kind='pod' and valid_to is null and lower(name)=lower($1)", [name])).rows[0]) fail(409, "A pod with this name already exists");
    const id = (await c.query("insert into pulse.unit(org_id,kind,name) values ($1,'pod',$2) returning id", [v.org, name])).rows[0].id;
    await log(c, v, "pod", id, "created", null, name);
    return { id };
  }));

  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/settings/pods/:id", { schema: { body } }, req => tx(req, async (c, v) => {
    must(v);
    if (!UUID.test(req.params.id)) fail(404, "Pod not found");
    const pod = (await c.query("select name from pulse.unit where id=$1 and kind='pod' and valid_to is null for update", [req.params.id])).rows[0];
    if (!pod) fail(404, "Pod not found");
    if (req.body.action === "remove") {
      const used = (await c.query(`select (select count(*)::int from pulse.people_profile pp join pulse.person p on p.id=pp.person_id where pp.pod=$1 and p.status<>'offboarded') people,
        (select count(*)::int from pulse.project where unit_id=$2) projects`, [pod.name, req.params.id])).rows[0];
      if (used.people || used.projects) fail(409, "Move its people and projects to another pod first");
      await c.query("update pulse.unit set valid_to=current_date where id=$1", [req.params.id]);
      await log(c, v, "pod", req.params.id, "removed", pod.name, null);
      return { ok: true };
    }
    const name = podName(req.body.name);
    if (name === pod.name) return { ok: true };
    if ((await c.query("select 1 from pulse.unit where kind='pod' and valid_to is null and lower(name)=lower($1) and id<>$2", [name, req.params.id])).rows[0]) fail(409, "A pod with this name already exists");
    await c.query("update pulse.unit set name=$1 where id=$2", [name, req.params.id]);
    // People carry the pod by name; they follow the rename and keep it through the next sync.
    await c.query("update pulse.people_profile set pod=$1,locked=array(select distinct unnest(locked || 'pod'::text)) where pod=$2", [name, pod.name]);
    await log(c, v, "pod", req.params.id, "name", pod.name, name);
    return { ok: true };
  }));

  app.post<{ Body: Body }>("/api/v0/settings/roles", { schema: { body } }, req => tx(req, async (c, v) => {
    must(v);
    const person = String(req.body.personId ?? ""), role = String(req.body.role ?? ""), grant = req.body.action !== "revoke";
    if (!UUID.test(person) || !ROLES.includes(role)) fail(400, "Choose a person and a role");
    const who = (await c.query("select display_name name from pulse.person where id=$1 and side='staff' and status='active'", [person])).rows[0];
    if (!who) fail(404, "This person has no active record");
    const held = (await c.query(`select id from pulse.role_assignment where person_id=$1 and role_key=$2
      and current_date between valid_from and coalesce(valid_to,'infinity')`, [person, role])).rows;
    if (grant) {
      if (held.length) fail(409, `${who.name} already has this role`);
      const unit=["manager","pgs","head_pgs"].includes(role)?(await c.query("select u.id from pulse.unit u join pulse.people_profile pp on pp.pod=u.name where pp.person_id=$1 and u.kind='pod' and u.valid_to is null",[person])).rows[0]?.id:null;
      if(["manager","pgs","head_pgs"].includes(role)&&!unit)fail(400,"Assign this person to a current pod before granting pod access");
      await c.query("insert into pulse.role_assignment(org_id,person_id,role_key,unit_id,is_manager_of_unit,valid_from) values ($1,$2,$3,$4,$5,current_date)", [v.org, person, role,unit,["manager","head_pgs"].includes(role)]);
    } else {
      if (!held.length) fail(409, `${who.name} does not have this role`);
      if (person === v.person && role === "admin") fail(400, "You cannot end your own admin role; ask another admin");
      // 1042: while salaries are by named list, only an admin holding "Read salary" manages it; keep at least one.
      if (role === "admin" && (await c.query(`select pulse.salary_named_list()
        and exists(select 1 from pulse.sensitive_permission where person_id=$1 and permission='hr.salary.read' and revoked_at is null)
        and not exists(select 1 from pulse.role_assignment r
        join pulse.sensitive_permission s on s.person_id=r.person_id and s.permission='hr.salary.read' and s.revoked_at is null
        where r.role_key='admin' and r.person_id<>$1 and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) last`, [person])).rows[0].last)
        fail(409, `${who.name} is the only admin who holds “Read salary” while salaries are by named list; name another admin first`);
      await c.query("update pulse.role_assignment set valid_to=current_date - 1 where id=any($1)", [held.map(r => r.id)]);
    }
    await log(c, v, "role", person, role, grant ? null : "held", grant ? "granted" : null);
    return { ok: true };
  }));

  // The five named HR permissions sit on top of the admin or HR role. The database function lets only an admin who
  // holds salary access change them; the checks here give a plain answer before it is reached.
  app.post<{ Body: Body }>("/api/v0/settings/permissions", { schema: { body } }, req => tx(req, async (c, v) => {
    must(v);
    const person = String(req.body.personId ?? ""), permission = String(req.body.permission ?? ""), action = String(req.body.action ?? "");
    if (!PERMISSIONS.includes(permission)) fail(400, "Unknown permission");
    if (!UUID.test(person) || !["grant", "revoke"].includes(action)) fail(400, "Choose a person and whether to grant or revoke");
    const grant = action === "grant";
    if (!(await c.query("select pulse.viewer_is('admin') and pulse.hr_can('hr.salary.read') ok")).rows[0].ok) fail(403, "Only an organisation admin who holds salary access can change these permissions");
    const who = (await c.query("select display_name name from pulse.person where id=$1 and side='staff' and status='active'", [person])).rows[0];
    if (!who) fail(404, "This person has no active record");
    const held = !!(await c.query("select 1 from pulse.sensitive_permission where person_id=$1 and permission=$2 and revoked_at is null", [person, permission])).rows[0];
    if (grant) {
      if (held) fail(409, `${who.name} already has this permission`);
      const role = (await c.query(`select 1 from pulse.role_assignment where person_id=$1 and role_key=any($2)
        and current_date between valid_from and coalesce(valid_to,'infinity')`, [person, ["admin","hr","leadership"]])).rows[0];
      if (!role) fail(400, `${who.name} is not an admin or HR, so this permission would do nothing. Give the role first.`);
    } else {
      if (!held) fail(409, `${who.name} does not have this permission`);
      if (person === v.person && permission === "hr.salary.read") fail(400, "You cannot revoke your own salary access; ask another admin who holds it");
    }
    await c.query("select pulse.hr_permission_set($1,$2,$3)", [person, permission, grant]);
    await log(c, v, "permission", person, permission, grant ? null : "held", grant ? "granted" : null);
    return { ok: true };
  }));

  // 1042: salary by named list for the organisation, on or off. The database function decides who may change it; the
  // checks here give a plain answer before it is reached.
  app.post<{ Body: Body }>("/api/v0/settings/salary-list", { schema: { body } }, req => tx(req, async (c, v) => {
    must(v);
    if (typeof req.body.on !== "boolean") fail(400, "Say whether salary access is by named list");
    const me = (await c.query(`select pulse.viewer_is('admin') and pulse.hr_can('hr.salary.read') ok,
      exists(select 1 from pulse.sensitive_permission where person_id=$1 and permission='hr.salary.read' and revoked_at is null) named`, [v.person])).rows[0];
    if (!me.ok) fail(403, "Only an organisation admin who holds salary access changes who sees salaries");
    if (req.body.on && !me.named) fail(400, "Hold a named “Read salary” grant yourself first, or you would lose salary access too");
    // The function records the change in record_change itself (org / salary_named_list).
    const on = (await c.query("select pulse.salary_named_list_set($1) named", [req.body.on])).rows[0].named as boolean;
    return { ok: true, on };
  }));
}
