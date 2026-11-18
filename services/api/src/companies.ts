// COMPANIES-MODEL (owner, 16 Nov 2026; migration 2190): one model for companies, contacts and clients.
//   A company is an organisation in the world: its people (contacts), one main contact, and through its client record
//   its projects, quotes and invoices. A client is a relationship: with a company, or with one person. A company may
//   have its own Pulse account (found in the directory, or invited from its page) and then links to it.
//   GET  /api/v0/companies                     the company book (with counts for the filters)
//   GET  /api/v0/companies/:id                 one company: people, client record, projects, bills, its Pulse account
//   POST /api/v0/companies                     add one (or get the one with that name), with its main contact
//   POST /api/v0/companies/:id                 change its details, main contact, vendor/partner, its Pulse account
//   POST /api/v0/companies/:id/client          it is a client now: its client record (made once)
//   POST /api/v0/companies/:id/contacts        add a person there (new, or an existing contact)
//   POST /api/v0/clients/:id/kind              sort a client: a company or one person
// Records are edited by organisation admins (as clients and contacts are); everyone who works reads them.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { admin, fail, work, type Tx, type Viewer } from "./routes.js";

type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const body = { type: "object" } as const;
const canEdit = (v: Viewer) => { if (!admin(v)) fail(403, "Only an organisation admin can change this"); if (!v.person) fail(403, "A shared login cannot change records"); };
const mustId = (id: string, what: string) => { if (!UUID.test(id)) fail(404, `${what} not found`); };
const text = (raw: unknown, max: number) => { const s = raw === null || raw === undefined ? "" : String(raw).replace(/\s+/g, " ").trim(); if (s.length > max) fail(400, `Keep it under ${max} letters`); return s || null; };
const GSTIN = /^[0-9A-Z]{15}$/;

/** Text fields of a company the forms change: body key → column and limit. */
const COMPANY_FIELDS: Record<string, [string, number]> = {
  name: ["name", 160], legalName: ["legal_name", 200], industry: ["industry", 80], website: ["website", 200], email: ["email", 254],
  phone: ["phone", 40], city: ["city", 80], address: ["address", 500], gstin: ["gstin", 15], notes: ["notes", 4000],
};

const log = (c: PoolClient, v: Viewer, entity: string, id: string, field: string, from: string | null, to: string | null) =>
  c.query("insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values ($1,$2,$3,$4,$5,$6,$7)", [v.org, entity, id, field, from, to, v.person]);

/** The company with this name (any case), or a new one. */
export async function companyByName(c: PoolClient, v: Viewer, name: string, source: "manual" | "contact" | "client" | "billing" = "manual", extra: Body = {}) {
  const clean = text(name, 160);
  if (!clean || clean.length < 2) fail(400, "Type the company's name");
  const found = (await c.query("select id from pulse.company where lower(btrim(name))=lower($1) and archived_at is null order by created_at limit 1", [clean])).rows[0];
  if (found) return { id: found.id as string, existed: true };
  const gstin = extra.gstin ? String(extra.gstin).replace(/\s+/g, "").toUpperCase() : null;
  if (gstin && !GSTIN.test(gstin)) fail(400, "A GSTIN has 15 letters and numbers");
  const id = (await c.query(`insert into pulse.company(org_id,name,city,website,email,phone,gstin,industry,notes,is_vendor,is_partner,source,created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`, [v.org, clean, text(extra.city, 80), text(extra.website, 200), text(extra.email, 254),
    text(extra.phone, 40), gstin, text(extra.industry, 80), text(extra.notes, 4000), extra.isVendor === true, extra.isPartner === true, source, v.person])).rows[0].id as string;
  await log(c, v, "company", id, "created", null, clean);
  return { id, existed: false };
}

/** A new contact (person + profile), optionally working at a company. */
export async function newContact(c: PoolClient, v: Viewer, p: Body, companyId: string | null, side = "other") {
  const name = text(p.name, 120);
  if (!name || name.length < 2) fail(400, "Type the person's name");
  const type = text(p.contactType, 40);
  const id = (await c.query("insert into pulse.person(org_id,display_name,side) values ($1,$2,$3) returning id", [v.org, name, side])).rows[0].id as string;
  try {
    await c.query(`insert into pulse.contact_profile(org_id,person_id,contact_type,designation,email,phone,city,company_id,source,locked)
      values ($1,$2,$3,$4,$5,$6,$7,$8,'manual','{name,contact_type}')`, [v.org, id, type, text(p.designation, 120), text(p.email, 254), text(p.phone, 40), text(p.city, 80), companyId]);
  } catch (e) { const err = e as { code?: string; message?: string }; if (err.code === "22023") fail(400, err.message ?? "Check the type"); throw e; }
  await log(c, v, "contact", id, "created", null, name);
  if (companyId) await c.query("update pulse.company set primary_contact_id=$2,updated_at=now() where id=$1 and primary_contact_id is null", [companyId, id]);
  return id;
}

/** A client type that exists for this company: the one asked for, else the first of `prefer` that is offered. */
async function clientType(c: PoolClient, asked: unknown, prefer: string[]) {
  await c.query("select pulse.record_types_defaults()");
  const keys = (await c.query("select key from pulse.record_type where entity='client' and archived_at is null")).rows.map((r) => r.key as string);
  const a = typeof asked === "string" && asked ? asked : null;
  if (a) { if (!keys.includes(a)) fail(400, "Choose one of your client types"); return a; }
  return prefer.find((k) => keys.includes(k)) ?? "other";
}

/** The company's client record: the one it has, or a new one (with its main contact as the client's contact). */
export async function clientForCompany(c: PoolClient, v: Viewer, companyId: string, type?: unknown) {
  const co = (await c.query("select id,name,primary_contact_id pc,email,phone,city,website from pulse.company where id=$1", [companyId])).rows[0];
  if (!co) fail(404, "Company not found");
  const had = (await c.query("select id from pulse.client where company_id=$1 order by (status is distinct from 'churned') desc,id limit 1", [companyId])).rows[0];
  if (had) return { id: had.id as string, existed: true };
  const t = await clientType(c, type, ["business", "business_customer", "developer", "brand", "other"]);
  const id = (await c.query(`insert into pulse.client(org_id,display_name,client_type,type_basis,source,locked,company_id,entity_kind,primary_contact_id,email,phone,city,website,status)
    values ($1,$2,$3,'manual','manual','{display_name,client_type}',$4,'company',$5,$6,$7,$8,$9,'active') returning id`,
    [v.org, co.name, t, companyId, co.pc, co.email, co.phone, co.city, co.website])).rows[0].id as string;
  await log(c, v, "client", id, "created", null, co.name);
  await c.query(`insert into pulse.client_contact(org_id,client_id,person_id,is_primary)
    select $1,$2,cp.person_id,cp.person_id=$4 from pulse.contact_profile cp where cp.company_id=$3 on conflict do nothing`, [v.org, id, companyId, co.pc]);
  return { id, existed: false };
}

/** One person as a client (a freelancer's customer, a home buyer): their client record, made once. */
export async function clientForPerson(c: PoolClient, v: Viewer, personId: string, type?: unknown) {
  const p = (await c.query("select p.id,p.display_name name,cp.email,cp.phone,cp.city from pulse.person p left join pulse.contact_profile cp on cp.person_id=p.id where p.id=$1", [personId])).rows[0];
  if (!p) fail(404, "Contact not found");
  const had = (await c.query("select id from pulse.client where primary_contact_id=$1 and company_id is null and entity_kind='person' limit 1", [personId])).rows[0];
  if (had) return { id: had.id as string, existed: true };
  const t = await clientType(c, type, ["individual", "home_customer", "other"]);
  const id = (await c.query(`insert into pulse.client(org_id,display_name,client_type,type_basis,source,locked,entity_kind,primary_contact_id,email,phone,city,status)
    values ($1,$2,$3,'manual','manual','{display_name,client_type}','person',$4,$5,$6,$7,'active') returning id`, [v.org, p.name, t, personId, p.email, p.phone, p.city])).rows[0].id as string;
  await log(c, v, "client", id, "created", null, p.name);
  await c.query("insert into pulse.client_contact(org_id,client_id,person_id,is_primary) values ($1,$2,$3,true) on conflict do nothing", [v.org, id, personId]);
  await c.query("update pulse.person set side='client' where id=$1 and side='other'", [personId]);
  return { id, existed: false };
}

const COMPANY_ROW = `co.id,co.name,co.legal_name "legalName",co.industry,co.website,co.email,co.phone,co.city,co.address,co.gstin,co.notes,
  co.is_vendor "isVendor",co.is_partner "isPartner",co.source,co.created_at "createdAt",co.pulse_org_id "pulseOrgId",co.directory_invite_id "inviteId",
  pc.id "contactId",pc.display_name "contactName",
  (select cl.id from pulse.client cl where cl.company_id=co.id order by (cl.status is distinct from 'churned') desc,cl.id limit 1) "clientId",
  (select count(*)::int from pulse.contact_profile x join pulse.person xp on xp.id=x.person_id where x.company_id=co.id and xp.status<>'offboarded') people,
  (select count(*)::int from pulse.project pr where pr.client_id in (select id from pulse.client where company_id=co.id)) projects,
  (select count(*)::int from pulse.erp_document d where d.client_id in (select id from pulse.client where company_id=co.id) and d.doc_type='quotation') quotes,
  (select count(*)::int from pulse.erp_document d where d.client_id in (select id from pulse.client where company_id=co.id) and d.doc_type='invoice') invoices`;
const COMPANY_FROM = "pulse.company co left join pulse.person pc on pc.id=co.primary_contact_id";

export function registerCompanyBookRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get("/api/v0/companies", req => tx(req, async (c, v) => {
    work(v);
    const companies = (await c.query(`select ${COMPANY_ROW} from ${COMPANY_FROM} where co.archived_at is null order by lower(co.name)`)).rows;
    // The address book's Clients tab shows how many (companies and single people; not the company's own internal work).
    const clientCount = (await c.query("select count(*)::int n from pulse.client where client_type<>'internal' and not exists(select 1 from pulse.record_merge m where m.entity_type='client' and m.gone_id=client.id and m.undone_at is null)")).rows[0].n as number;
    return { companies, clientCount, canEdit: admin(v) && !!v.person };
  }));

  app.get<{ Params: { id: string } }>("/api/v0/companies/:id", req => tx(req, async (c, v) => {
    work(v); mustId(req.params.id, "Company");
    const company = (await c.query(`select ${COMPANY_ROW} from ${COMPANY_FROM} where co.id=$1`, [req.params.id])).rows[0];
    if (!company) fail(404, "Company not found");
    const people = (await c.query(`select p.id,p.display_name name,cp.designation,cp.email,cp.phone,cp.contact_type "contactType",(p.id=$2) "primary",
        (select ph.updated_at from pulse.person_photo ph where ph.person_id=p.id) "photoAt"
      from pulse.contact_profile cp join pulse.person p on p.id=cp.person_id where cp.company_id=$1 and p.status<>'offboarded'
      order by (p.id=$2) desc,p.display_name`, [company.id, company.contactId])).rows;
    const clients = (await c.query(`select cl.id,cl.display_name name,cl.client_type "clientType",cl.status from pulse.client cl where cl.company_id=$1 order by cl.display_name`, [company.id])).rows;
    const ids = clients.map((x) => x.id as string);
    const projects = ids.length ? (await c.query(`select p.id,coalesce(p.title,p.name) title,p.status,p.start_month::text "startMonth"
      from pulse.project p where p.client_id=any($1::uuid[]) order by p.start_month desc nulls last,p.registry_no desc limit 30`, [ids])).rows : [];
    const documents = ids.length ? (await c.query(`select d.id,d.doc_type "docType",d.number,d.status,d.total::float total,d.issue_date::text "issueDate"
      from pulse.erp_document d where d.client_id=any($1::uuid[]) order by d.created_at desc limit 30`, [ids])).rows : [];
    const pulse = company.pulseOrgId ? (await c.query("select pulse.company_pulse_card($1) c", [company.pulseOrgId])).rows[0].c : null;
    const invite = company.inviteId ? (await c.query("select pulse.company_invite_state($1) s", [company.inviteId])).rows[0].s : null;
    const types = (await c.query("select pulse.record_types('contact') t")).rows[0].t;
    return { company, people, clients, projects, documents, pulse, invite, types, canEdit: admin(v) && !!v.person };
  }));

  app.post<{ Body: Body }>("/api/v0/companies", { schema: { body } }, req => tx(req, async (c, v) => {
    canEdit(v);
    const b = req.body;
    const made = await companyByName(c, v, String(b.name ?? ""), "manual", b);
    let contactId: string | null = null;
    if (typeof b.contactId === "string" && UUID.test(b.contactId)) {
      if (!(await c.query("select 1 from pulse.contact_profile where person_id=$1", [b.contactId])).rows[0]) fail(400, "Choose one of your contacts");
      contactId = b.contactId;
      await c.query("update pulse.contact_profile set company_id=$2 where person_id=$1 and company_id is null", [contactId, made.id]);
      await c.query("update pulse.company set primary_contact_id=$2 where id=$1 and primary_contact_id is null", [made.id, contactId]);
    } else if (b.contact && typeof b.contact === "object" && text((b.contact as Body).name, 120)) {
      contactId = await newContact(c, v, b.contact as Body, made.id, b.client === true ? "client" : "other");
    }
    const clientId = b.client === true ? (await clientForCompany(c, v, made.id, b.clientType)).id : null;
    return { id: made.id, existed: made.existed, contactId, clientId };
  }));

  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/companies/:id", { schema: { body } }, req => tx(req, async (c, v) => {
    mustId(req.params.id, "Company"); canEdit(v);
    const row = (await c.query("select * from pulse.company where id=$1", [req.params.id])).rows[0];
    if (!row) fail(404, "Company not found");
    const b = req.body; let changed = 0;
    for (const [key, [col, max]] of Object.entries(COMPANY_FIELDS)) {
      if (!(key in b)) continue;
      let next = text(b[key], max);
      if (key === "name" && (!next || next.length < 2)) fail(400, "A company needs a name");
      if (key === "gstin" && next) { next = next.replace(/\s+/g, "").toUpperCase(); if (!GSTIN.test(next)) fail(400, "A GSTIN has 15 letters and numbers"); }
      if ((row[col] ?? null) === next) continue;
      await c.query(`update pulse.company set ${col}=$2,updated_at=now() where id=$1`, [row.id, next]);
      await log(c, v, "company", row.id, key, row[col] ?? null, next); changed += 1;
    }
    for (const [key, col] of [["isVendor", "is_vendor"], ["isPartner", "is_partner"]] as const) {
      if (!(key in b) || (b[key] === true) === row[col]) continue;
      await c.query(`update pulse.company set ${col}=$2,updated_at=now() where id=$1`, [row.id, b[key] === true]);
      await log(c, v, "company", row.id, key, String(row[col]), String(b[key] === true)); changed += 1;
    }
    if ("primaryContactId" in b) {
      const pid = b.primaryContactId ? String(b.primaryContactId) : null;
      if (pid && !(UUID.test(pid) && (await c.query("select 1 from pulse.contact_profile where person_id=$1", [pid])).rows[0])) fail(400, "Choose one of your contacts");
      if (pid !== row.primary_contact_id) {
        await c.query("update pulse.company set primary_contact_id=$2,updated_at=now() where id=$1", [row.id, pid]);
        if (pid) await c.query("update pulse.contact_profile set company_id=$2 where person_id=$1 and company_id is null", [pid, row.id]);
        await c.query("update pulse.client set primary_contact_id=$2 where company_id=$1", [row.id, pid]);
        await log(c, v, "company", row.id, "primaryContactId", row.primary_contact_id, pid); changed += 1;
      }
    }
    // Its own Pulse account: picked from the directory (the company's id there), or the invite we made for it.
    if ("pulseOrgId" in b) {
      const org = b.pulseOrgId ? String(b.pulseOrgId) : null;
      if (org && !(UUID.test(org) && (await c.query("select pulse.company_pulse_card($1) c", [org])).rows[0].c)) fail(400, "We could not find that company on Pulse");
      if (org && org === v.org) fail(400, "That is your own company");
      if (org !== row.pulse_org_id) { await c.query("update pulse.company set pulse_org_id=$2,updated_at=now() where id=$1", [row.id, org]); await log(c, v, "company", row.id, "pulseOrgId", row.pulse_org_id, org); changed += 1; }
    }
    if ("inviteId" in b) {
      const inv = b.inviteId ? String(b.inviteId) : null;
      if (inv) {
        const s = UUID.test(inv) ? (await c.query("select pulse.company_invite_state($1) s", [inv])).rows[0].s : null;
        if (!s) fail(400, "We could not find that invite");
        await c.query("update pulse.company set directory_invite_id=$2,pulse_org_id=coalesce(pulse_org_id,$3),updated_at=now() where id=$1", [row.id, inv, s.joinedOrg ?? null]);
      } else await c.query("update pulse.company set directory_invite_id=null,updated_at=now() where id=$1", [row.id]);
      changed += 1;
    }
    if (b.archived === true && !row.archived_at) { await c.query("update pulse.company set archived_at=now() where id=$1", [row.id]); await log(c, v, "company", row.id, "archived", null, "true"); changed += 1; }
    return { changed };
  }));

  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/companies/:id/client", { schema: { body } }, req => tx(req, async (c, v) => {
    mustId(req.params.id, "Company"); canEdit(v);
    const made = await clientForCompany(c, v, req.params.id, req.body.clientType);
    return { clientId: made.id, existed: made.existed };
  }));

  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/companies/:id/contacts", { schema: { body } }, req => tx(req, async (c, v) => {
    mustId(req.params.id, "Company"); canEdit(v);
    if (!(await c.query("select 1 from pulse.company where id=$1", [req.params.id])).rows[0]) fail(404, "Company not found");
    let id: string;
    if (typeof req.body.personId === "string" && UUID.test(req.body.personId)) {
      if (!(await c.query("update pulse.contact_profile set company_id=$2 where person_id=$1 returning 1", [req.body.personId, req.params.id])).rows[0]) fail(400, "Choose one of your contacts");
      id = req.body.personId;
      await c.query("update pulse.company set primary_contact_id=$2 where id=$1 and primary_contact_id is null", [req.params.id, id]);
    } else id = await newContact(c, v, req.body, req.params.id);
    // A person at a client company is one of that client's contacts too.
    await c.query(`insert into pulse.client_contact(org_id,client_id,person_id,is_primary) select $1,cl.id,$3,false from pulse.client cl where cl.company_id=$2 on conflict do nothing`, [v.org, req.params.id, id]);
    if (req.body.primary === true) {
      await c.query("update pulse.company set primary_contact_id=$2,updated_at=now() where id=$1", [req.params.id, id]);
      await c.query("update pulse.client set primary_contact_id=$2 where company_id=$1", [req.params.id, id]);
    }
    return { id };
  }));

  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/clients/:id/kind", { schema: { body } }, req => tx(req, async (c, v) => {
    mustId(req.params.id, "Client"); canEdit(v);
    const cl = (await c.query("select id,company_id,entity_kind,primary_contact_id from pulse.client where id=$1", [req.params.id])).rows[0];
    if (!cl) fail(404, "Client not found");
    const kind = String(req.body.kind ?? "");
    if (kind === "company") {
      if (cl.company_id) return { companyId: cl.company_id };
      const id = typeof req.body.companyId === "string" && UUID.test(req.body.companyId) ? req.body.companyId
        : typeof req.body.companyName === "string" && req.body.companyName.trim() ? (await companyByName(c, v, req.body.companyName, "client")).id : null;
      if (id) {
        await c.query("update pulse.client set company_id=$2,entity_kind='company' where id=$1", [cl.id, id]);
        await c.query("update pulse.contact_profile set company_id=$2 where company_id is null and (person_id=$3 or person_id in (select person_id from pulse.client_contact where client_id=$1))", [cl.id, id, cl.primary_contact_id]);
        await c.query("update pulse.company set primary_contact_id=$2 where id=$1 and primary_contact_id is null", [id, cl.primary_contact_id]);
        await log(c, v, "client", cl.id, "company", null, id);
        return { companyId: id };
      }
      await c.query("update pulse.client set entity_kind='company' where id=$1", [cl.id]);
      const made = (await c.query("select pulse.company_for_client($1,true) id", [cl.id])).rows[0].id as string;
      await log(c, v, "client", cl.id, "company", null, made);
      return { companyId: made };
    }
    if (kind === "person") {
      if (cl.company_id) fail(400, "This client is a company. Open the company to change it.");
      await c.query("update pulse.client set entity_kind='person' where id=$1", [cl.id]);
      await log(c, v, "client", cl.id, "kind", cl.entity_kind, "person");
      return { kind: "person" };
    }
    fail(400, "Choose a company or one person");
  }));
}
