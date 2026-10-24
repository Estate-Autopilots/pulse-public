// UX-TENANT (ADR-0032): companies on this Pulse. The platform operator (an individual admin of the install's own
// company) sets up a new company step by step: company and address, brand, first admin, people, pods/teams/roles,
// modules and "Who can do what", an isolation check, then opens it for sign-in. Every write goes through a
// pulse.tenant_* function (0260) that lands in the new company only. Nothing here sends e-mail unless the operator
// presses Send, and a rehearsal company never sends.
// R53 (0480): the company step is one setup plan (pulse.tenant_plan: previewed row by row, applied in one transaction,
// a rerun keeps everything) that a setup file repeats for the next company; a company opens in trial and the operator
// activates it for staff once every gate passes (pulse.tenant_gates / tenant_activate); its own admins and HR follow the
// same checklist under Settings (/api/v0/company-setup).
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { brandBytesOk, BRAND_MAX_BYTES, currentMailBrand } from "./brand.js";
import { googleBridge } from "./google.js";
import { admin, fail, sessionHash, type Open, type Tx } from "./routes.js";
import { hostCompany, hostDirectoryFor, normaliseHost } from "./tenant-context.js";
import { accentCheck, feedbackInput, handoverInput, peopleFromCsv, pilotCheckInput, planSpec, publicOrigin, readiness, setupGuide, suggest, type PersonRow, type SetupGates } from "./tenant-model.js";
import { startGuide } from "./invitations.js";
import { PACK, packPayload } from "./flow/packs.js";

type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(404, "Setup not found");
const body = { type: "object" } as const;
const KINDS: Record<string, string> = { mark: "mark", logo: "logo", "logo-dark": "logo_dark", "logo-png": "logo_png" };
const MIMES = ["image/svg+xml", "image/png", "image/webp", "image/jpeg"];
const str = (x: unknown, max = 200) => String(x ?? "").slice(0, max);

type State = {
  id: string; name: string; status: string; steps: Record<string, { at: string } & Record<string, unknown>>;
  org: null | { id: string; name: string; slug: string; code: string; timeZone: string; dataRegion: string; status: string; rehearsal: boolean; host: string | null; signIn: string };
  brand?: { version: number; mark: boolean; logo: boolean; logoDark: boolean; logoPng: boolean; accent: string | null };
  admin?: null | { personId: string; name: string; email: string; username: string; title: string; invitation: string | null; linkReady: boolean; sentAt: string | null; expiresAt: string | null; signedIn: boolean };
  counts?: Record<string, number>; modules?: Record<string, boolean>; rules?: { role: string; action: string; scope: string }[];
  twoStep?: { required: boolean; graceUntil: string | null } | null; pods?: string[]; people?: unknown[] | null;
};

/** The sender setup invitations come from: the install's own, only when the operator configured it. */
function operatorMail(): { from: string | null; reason: string | null } {
  const from = process.env.PULSE_OPERATOR_MAIL_FROM?.trim() || null;
  if (process.env.PULSE_GMAIL_SEND_ENABLED !== "1") return { from, reason: "E-mail sending is not switched on for this server" };
  if (!from) return { from, reason: "Set PULSE_OPERATOR_MAIL_FROM, the address setup invitations come from" };
  return { from, reason: null };
}

/** What still stands between the company and its people signing in, in the order the owner works through it. */
export function checklist(s: State, mail: { reason: string | null }) {
  const o = s.org; const a = s.admin; const iso = s.steps.isolation as undefined | { at: string; leaks: number; tables: number };
  const isoFresh = !!iso && Date.parse(iso.at) > Date.now() - 3600_000;
  const local = !!o?.host && /\.localhost$/.test(o.host);
  const n = (count: number | undefined, one: string, many = `${one}s`) => `${count ?? 0} ${count === 1 ? one : many}`;
  type Item = { key: string; label: string; state: "done" | "todo" | "blocked" | "owner" | "info"; detail: string; blocking?: boolean };
  const items: Item[] = [
    { key: "company", label: "Company and web address", state: o ? "done" : "todo", blocking: true, detail: o ? `${o.name} (${o.code}) at ${o.host}` : "Name the company and choose its address" },
    { key: "route", label: "The address reaches this Pulse", state: local ? "done" : "owner", detail: local ? "A *.localhost rehearsal address needs no DNS" : `Point ${o?.host ?? "the address"} at this Pulse in Cloudflare, without Access in front of it (people sign in with Pulse passwords)` },
    { key: "brand", label: "Logo and colours", state: s.brand?.logo || s.brand?.mark || s.brand?.accent ? "done" : "todo", detail: s.brand?.accent ? `Accent ${s.brand.accent}${s.brand.logo ? ", logo set" : ""}` : "Optional: the sign-in page and e-mails show the company's own logo" },
    { key: "admin", label: "First admin", state: a?.email ? "done" : "todo", blocking: true, detail: a ? `${a.name} · ${a.email} · username ${a.username}` : "Who runs the company's Pulse" },
    { key: "invite", label: "The admin's invitation", state: a?.signedIn || a?.invitation === "used" ? "done" : a?.invitation === "sent" || a?.linkReady ? "done" : a ? "todo" : "todo",
      detail: a?.signedIn ? "The admin has set a password" : a?.invitation === "sent" ? `Sent ${a.sentAt?.slice(0, 10) ?? ""}` : a?.linkReady ? "A private set-password link is ready (shown once)" : a ? (o?.rehearsal ? "Rehearsal: get a private link (e-mail is never sent)" : mail.reason ? `Not sent: ${mail.reason}` : "Prepared; nothing is sent until you press Send") : "Add the first admin first" },
    { key: "people", label: "People", state: (s.counts?.people ?? 0) > 1 ? "done" : "todo", detail: `${n(s.counts?.people, "person", "people")}, ${s.counts?.withEmail ?? 0} with an e-mail` },
    { key: "structure", label: "Pods, teams and roles", state: (s.counts?.pods ?? 0) > 0 ? "done" : "todo", detail: [n(s.counts?.pods, "pod"), n(s.counts?.teams, "team"), n(s.counts?.admins, "admin")].join(", ") },
    { key: "settings", label: "Modules and who can do what", state: s.steps.settings ? "done" : "todo", detail: s.modules ? Object.entries(s.modules).map(([k, v]) => `${k} ${v ? "on" : "off"}`).join(", ") : "" },
    { key: "isolation", label: "Isolation check", state: iso && isoFresh && iso.leaks === 0 ? "done" : iso && iso.leaks > 0 ? "blocked" : "todo", blocking: true,
      detail: iso ? `${iso.tables} tables read as this company: ${iso.leaks === 0 ? "nothing from another company" : `${iso.leaks} rows from another company`}${isoFresh ? "" : " (over an hour ago: run it again)"}` : "Reads every company table as the new company and must find nothing else" },
    { key: "two-step", label: "Two-step verification", state: s.twoStep?.required ? "done" : "info", detail: s.twoStep?.required ? `Required for admins and HR from ${s.twoStep.graceUntil?.slice(0, 10) ?? "now"}` : "Not required" },
    { key: "mail", label: "The company's own e-mail sender", state: "owner", detail: "Off until the company connects its own sender (R52, owner errand E13): password resets and notices are not e-mailed meanwhile" },
    { key: "backup", label: "Backups and restore", state: "info", detail: "Covered by this install's database backups; a passed restore drill is needed before staff are activated (owner errand E19)" },
    { key: "legal", label: "Data and privacy terms", state: o?.rehearsal ? "info" : "owner", detail: o?.rehearsal ? "Rehearsal: synthetic people only" : "A processor arrangement and the privacy notice its people see, before staff are activated (owner errand E08)" },
  ];
  const blocked = items.filter((i) => i.blocking && i.state !== "done").map((i) => i.label);
  return { items, canOpen: !!o && o.status === "setup" && blocked.length === 0, blocked };
}

export function registerTenantRoutes(app: FastifyInstance, { tx, open, pool }: { tx: Tx; open: Open; pool: Pool }) {
  const hosts = hostDirectoryFor(pool);
  const operator = async (c: PoolClient) => {
    if (!(await c.query("select pulse.tenant_operator() ok")).rows[0].ok) fail(403, "Companies are set up by an admin of this install's own company");
  };
  const state = async (c: PoolClient, setup: string) => (await c.query("select pulse.tenant_state($1) s", [setup])).rows[0].s as State;
  const view = async (c: PoolClient, setup: string) => {
    const s = await state(c, setup); const mail = operatorMail();
    const gates = s.org ? (await c.query("select pulse.tenant_gates($1) g", [setup])).rows[0].g as SetupGates & { operator: string | null } : null;
    return { ...s, suggestions: suggest(s.org?.name ?? s.name), accent: s.brand?.accent ? accentCheck(s.brand.accent) : null,
      activation: gates ? { ...gates, guide: setupGuide(gates, "operator", setup), readiness: readiness(gates),
        operators: (await c.query(`select p.id, p.display_name name from pulse.person p where p.side='staff' and p.status='active' and exists (select 1 from pulse.role_assignment r
          where r.person_id=p.id and r.role_key='admin' and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) order by p.display_name`)).rows } : null,
      mail: { from: mail.from, sendEnabled: !mail.reason && !s.org?.rehearsal, reason: s.org?.rehearsal ? "A rehearsal company never sends e-mail" : mail.reason },
      workspace: { connected: false, reason: `${s.org?.name ?? s.name} has not connected its own Google Workspace to Pulse. Its Workspace admin grants that (owner errand E13); until then import a CSV.` },
      invitation: s.admin ? { subject: `Your ${s.org?.name} Pulse account`, guide: startGuide } : null,
      checklist: checklist(s, mail) };
  };

  // Signed out: which company this address belongs to and how people sign in here (the web's sign-in page and proxy ask).
  app.get("/api/v0/host", async () => {
    const company = hostCompany();
    const name = await open(async (c) => (await c.query("select name from pulse.org where id=pulse.current_org()")).rows[0]?.name ?? null);
    return { name, own: !company, signIn: company?.signIn ?? (process.env.PULSE_PUBLIC_LOGIN_ENABLED === "1" ? "password" : "access"), status: company?.status ?? "active", rehearsal: company?.rehearsal ?? false };
  });

  // The company's own module switches (Settings → Organisation). Everyone reads; admins change.
  app.get("/api/v0/settings/modules", (req) => tx(req, async (c, v) => ({ modules: (await c.query("select pulse.org_modules() m")).rows[0].m, canEdit: admin(v) && !!v.person })));
  app.post<{ Body: Body }>("/api/v0/settings/modules", { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!admin(v) || !v.person) fail(403, "An organisation admin turns modules on or off");
    return { modules: (await c.query("select pulse.org_module_set($1,$2) m", [str(req.body.module, 20), req.body.enabled === true])).rows[0].m };
  }));
  app.post<{ Body: Body }>("/api/v0/settings/brand-accent", { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!admin(v) || !v.person) fail(403, "An individual organisation admin changes the colours");
    const accent = req.body.accent === null || req.body.accent === "" ? null : str(req.body.accent, 7).toLowerCase();
    if (accent) { const check = accentCheck(accent); if (!check.ok) fail(400, check.note ?? "Choose another colour"); }
    await c.query("select pulse.org_brand_accent($1)", [accent]); return { accent };
  }));

  app.get("/api/v0/tenants", (req) => tx(req, async (c) => { await operator(c); return { companies: (await c.query("select pulse.tenant_list() l")).rows[0].l }; }));
  app.post<{ Body: Body }>("/api/v0/tenants", { schema: { body } }, (req) => tx(req, async (c) => {
    await operator(c); return { id: (await c.query("select pulse.tenant_start($1) id", [str(req.body.name, 80)])).rows[0].id };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/tenants/:id", (req) => tx(req, async (c) => { await operator(c); return view(c, id(req.params.id)); }));

  // Company and address: { name, slug, code, timeZone, dataRegion, host, rehearsal, check }. check: preview only.
  // R53: the step is the setup plan's company part, so "Check first" lists every row it would write.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/tenants/:id/company", { schema: { body } }, (req) => tx(req, async (c) => {
    await operator(c); const setup = id(req.params.id); const b = req.body;
    const company = { name: str(b.name, 80), slug: str(b.slug, 40), code: str(b.code, 4), timeZone: str(b.timeZone, 60), dataRegion: str(b.dataRegion, 10) || "in",
      host: normaliseHost(b.host) ?? str(b.host, 253), rehearsal: b.rehearsal === true };
    const plan = (await c.query("select pulse.tenant_plan($1,$2,$3) r", [setup, JSON.stringify({ company }), b.check !== true])).rows[0].r;
    const check = { ok: plan.ok, problems: plan.problems, warnings: plan.warnings, creates: plan.creates };
    if (!plan.applied) return { check, plan };
    hosts.clear();
    return { check, plan, setup: await view(c, setup) };
  }));

  // R53: the whole plan. GET gives the company's setup file (or a starting one); POST { spec, apply } previews or applies.
  app.get<{ Params: { id: string } }>("/api/v0/tenants/:id/plan", (req) => tx(req, async (c) => {
    await operator(c); const setup = id(req.params.id); const s = await state(c, setup);
    if (s.org) return { spec: (await c.query("select pulse.tenant_spec($1) r", [setup])).rows[0].r };
    const start = suggest(s.name);
    return { spec: { contract: "pulse.setup.v1", company: { name: s.name, slug: start.slug, code: start.code, timeZone: "", dataRegion: "in", host: "", rehearsal: /rehearsal/i.test(s.name) },
      modules: { tasks: true, chats: true, finance: true, attendance: false }, rules: [],
      sources: [{ key: "people-csv", kind: "csv", label: "People list (CSV)", categories: ["people", "structure"], grants: "admin" }] } };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/tenants/:id/plan", { schema: { body }, bodyLimit: 256 * 1024 }, (req) => tx(req, async (c) => {
    await operator(c); const setup = id(req.params.id);
    const spec = planSpec(req.body.spec);
    if (spec.company?.host) spec.company.host = normaliseHost(spec.company.host) ?? spec.company.host;
    const plan = (await c.query("select pulse.tenant_plan($1,$2,$3) r", [setup, JSON.stringify(spec), req.body.apply === true])).rows[0].r;
    if (!plan.applied) return { plan };
    hosts.clear();
    return { plan, setup: await view(c, setup) };
  }));

  // Brand: { kind: mark | logo | logo-dark | logo-png, mime, data (base64) } or { kind, remove } or { accent }.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/tenants/:id/brand", { schema: { body }, bodyLimit: Math.ceil(BRAND_MAX_BYTES * 1.4) + 4096 }, (req) => tx(req, async (c) => {
    await operator(c); const setup = id(req.params.id); const b = req.body;
    if ("accent" in b) {
      const accent = b.accent === null || b.accent === "" ? null : str(b.accent, 7).toLowerCase();
      if (accent) { const check = accentCheck(accent); if (!check.ok) fail(400, check.note ?? "Choose another colour"); }
      await c.query("select pulse.tenant_brand($1,'accent',null,null,$2)", [setup, accent]);
      return view(c, setup);
    }
    const kind = KINDS[str(b.kind, 20)]; if (!kind) fail(400, "Choose which picture: mark, logo, logo-dark or logo-png");
    if (b.remove === true) { await c.query("select pulse.tenant_brand($1,$2,null,null,null)", [setup, kind]); return view(c, setup); }
    const mime = str(b.mime, 40);
    if (!MIMES.includes(mime) || (kind === "logo_png" && mime !== "image/png")) fail(400, kind === "logo_png" ? "The e-mail logo is a PNG" : "Choose an SVG, PNG, WebP or JPEG");
    const bytes = typeof b.data === "string" ? Buffer.from(b.data, "base64") : Buffer.alloc(0);
    if (!bytes.length || bytes.length > BRAND_MAX_BYTES) fail(400, "Choose a picture under 512 KB");
    if (!brandBytesOk(bytes, mime)) fail(400, mime === "image/svg+xml" ? "This SVG has scripts or links to other files; export a plain SVG" : "The file is not the picture type it says");
    await c.query("select pulse.tenant_brand($1,$2,$3,$4,null)", [setup, kind, bytes, mime]);
    return view(c, setup);
  }));
  app.get<{ Params: { id: string; kind: string } }>("/api/v0/tenants/:id/brand/:kind", async (req, reply) => {
    const row = await tx(req, async (c) => {
      await operator(c);
      const kind = KINDS[req.params.kind]; if (!kind) fail(404, "Unknown picture");
      return (await c.query("select * from pulse.tenant_brand_read($1,$2)", [id(req.params.id), kind])).rows[0];
    });
    if (!row?.bytes) fail(404, "No picture is set");
    reply.header("cache-control", "private, no-store").header("x-content-type-options", "nosniff").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    return reply.type(String(row.mime)).send(row.bytes);
  });

  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/tenants/:id/admin", { schema: { body } }, (req) => tx(req, async (c) => {
    await operator(c); const setup = id(req.params.id);
    await c.query("select pulse.tenant_admin($1,$2,$3,$4)", [setup, str(req.body.name, 80), str(req.body.email, 200), str(req.body.title, 80)]);
    return view(c, setup);
  }));

  // The first admin's invitation. link: a one-time set-password link to hand over privately (shown once, nothing is
  // sent). send: the e-mail, only when the operator presses Send and sending is configured; never for a rehearsal.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/tenants/:id/invite", { schema: { body } }, async (req) => {
    await tx(req, async (c) => operator(c));
    const setup = id(req.params.id); const action = str(req.body.action, 10);
    if (action !== "link" && action !== "send") fail(400, "Choose link or send");
    if (req.body.confirmed !== true) fail(400, action === "link" ? "Confirm you will hand the link to the admin privately" : "Confirm the recipient before sending");
    const token = randomBytes(32).toString("base64url");
    const origin = (host: string | null) => publicOrigin(host, process.env.PULSE_PUBLIC_URL, typeof req.headers["x-pulse-host"] === "string" ? req.headers["x-pulse-host"] : undefined);
    if (action === "link") {
      const r = await tx(req, async (c) => { await operator(c); return (await c.query("select pulse.tenant_invite($1,'link',$2) r", [setup, sessionHash(token)])).rows[0].r; });
      const url = new URL("/login/set-password", origin(r.host)); url.hash = token;
      return { username: r.username, link: url.href, expiresInDays: 7 };
    }
    const mail = operatorMail(); if (mail.reason) fail(403, mail.reason);
    const r = await tx(req, async (c) => { await operator(c); return (await c.query("select pulse.tenant_invite($1,'send',$2) r", [setup, sessionHash(token)])).rows[0].r; });
    let ok = false;
    try {
      const url = new URL("/login/set-password", origin(r.host)); url.hash = token;
      const brand = await currentMailBrand();
      await googleBridge("send", { subject: mail.from, to: r.recipient, title: `Your ${r.company} Pulse account`, ...(brand ? { brand } : {}),
        body: `Hello ${r.name},\n\n${r.company} now has Pulse at ${origin(r.host)}. You are its first admin.\n\nYour Pulse username: ${r.username}\n\nSet your password: ${url.href}\n\nThis private link can be used once and expires in 7 days. No password is included in this email.\n\n${startGuide}` });
      ok = true;
    } catch { ok = false; }
    await tx(req, async (c) => { await operator(c); await c.query("select pulse.tenant_invite($1,$2,null)", [setup, ok ? "sent" : "failed"]); });
    if (!ok) fail(503, "The invitation was not sent; nothing reached the admin. Try again or hand over a private link.");
    return { sent: true, recipient: r.recipient };
  });

  // People: { source: 'csv', csv } or { rows }, apply false = preview.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/tenants/:id/people", { schema: { body }, bodyLimit: 2 * 1024 * 1024 }, (req) => tx(req, async (c) => {
    await operator(c); const setup = id(req.params.id); const b = req.body;
    if (b.source === "workspace") fail(409, "This company has not connected its Google Workspace; import a CSV instead");
    let rows: PersonRow[]; let columns = {};
    if (typeof b.csv === "string") {
      const parsed = peopleFromCsv(b.csv); if (parsed.problems.length) fail(400, parsed.problems[0]);
      rows = parsed.rows; columns = parsed.columns;
    } else if (Array.isArray(b.rows)) rows = (b.rows as Body[]).slice(0, 2000).map((r) => ({ name: str(r.name, 80), email: str(r.email, 200), title: str(r.title, 80), pod: str(r.pod, 40), team: str(r.team, 60), manager: str(r.manager, 200), access: str(r.access, 20).toLowerCase() }));
    else fail(400, "Choose a CSV file");
    const result = (await c.query("select pulse.tenant_people($1,$2,$3) r", [setup, JSON.stringify(rows!), b.apply === true])).rows[0].r;
    return { ...result, columns, setup: b.apply === true ? await view(c, setup) : undefined };
  }));

  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/tenants/:id/structure", { schema: { body } }, (req) => tx(req, async (c) => {
    await operator(c); const setup = id(req.params.id);
    if (!Array.isArray(req.body.ops)) fail(400, "Nothing to change");
    await c.query("select pulse.tenant_structure($1,$2)", [setup, JSON.stringify(req.body.ops)]);
    return view(c, setup);
  }));

  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/tenants/:id/settings", { schema: { body } }, (req) => tx(req, async (c) => {
    await operator(c); const setup = id(req.params.id);
    const modules = typeof req.body.modules === "object" && req.body.modules ? Object.fromEntries(Object.entries(req.body.modules as Body)
      .filter(([k]) => ["tasks", "chats", "finance", "attendance"].includes(k)).map(([k, v]) => [k, v === true])) : {};
    const rules = Array.isArray(req.body.rules) ? (req.body.rules as Body[]).slice(0, 20).map((r) => ({ role: str(r.role, 20), action: str(r.action, 30), scope: str(r.scope, 10) })) : [];
    await c.query("select pulse.tenant_settings($1,$2,$3)", [setup, JSON.stringify(modules), JSON.stringify(rules)]);
    return view(c, setup);
  }));

  // FLOW-E: the company's industry pack (its words, roles, starter processes and record types), written into it while it
  // is being set up; once open, its own admins change it in Settings → Industry & roles.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/tenants/:id/pack", { schema: { body } }, (req) => tx(req, async (c) => {
    await operator(c); const setup = id(req.params.id);
    const p = PACK.get(str(req.body.pack, 40)) ?? fail(400, "Choose an industry pack");
    await c.query("select pulse.tenant_pack($1,$2)", [setup, JSON.stringify(packPayload(p))]);
    return view(c, setup);
  }));

  // The isolation check reads every company table as the API role inside the new company (read only): any row of
  // another company, or any other company in pulse.org, is a leak and keeps the company closed.
  app.post<{ Params: { id: string } }>("/api/v0/tenants/:id/check", async (req) => {
    const setup = id(req.params.id);
    const target = await tx(req, async (c) => { await operator(c); return (await state(c, setup)).org?.id ?? fail(409, "Create the company first"); });
    const client = await pool.connect(); let tables = 0; const leaks: { table: string; rows: number }[] = [];
    try {
      await client.query("begin read only");
      await client.query("select set_config('pulse.org_id',$1,true), set_config('pulse.viewer_id','',true)", [target]);
      const list = (await client.query("select pulse.tenant_tables() t")).rows.map((r) => r.t as string);
      for (const table of list) {
        await client.query("savepoint t");
        try {
          const n = Number((await client.query(`select count(*) n from ${table.split(".").map((p) => `"${p.replace(/"/g, "")}"`).join(".")} where org_id is distinct from $1`, [target])).rows[0].n);
          tables++; if (n) leaks.push({ table, rows: n });
          await client.query("release savepoint t");
        } catch { await client.query("rollback to savepoint t"); }
      }
      const orgs = Number((await client.query("select count(*) n from pulse.org")).rows[0].n);
      if (orgs !== 1) leaks.push({ table: "pulse.org", rows: orgs - 1 });
      await client.query("rollback");
    } catch (e) { await client.query("rollback").catch(() => {}); throw e; } finally { client.release(); }
    const leakRows = leaks.reduce((n, l) => n + l.rows, 0);
    return tx(req, async (c) => {
      await operator(c);
      await c.query("select pulse.tenant_isolation_record($1,$2,$3,$4)", [setup, tables, leakRows, JSON.stringify(leaks)]);
      return { tables, leaks, setup: await view(c, setup) };
    });
  });

  // R53: the handover the operator records (responsible operator, support route, restore drill, the owner's references).
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/tenants/:id/handover", { schema: { body } }, (req) => tx(req, async (c) => {
    await operator(c); const setup = id(req.params.id);
    const h = handoverInput(req.body); if (h.problem) fail(400, h.problem);
    await c.query("select pulse.tenant_handover($1,$2)", [setup, JSON.stringify(h.body)]);
    return view(c, setup);
  }));
  // R53: activate for staff. The database checks every gate again; nothing is sent.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/tenants/:id/activate", { schema: { body } }, (req) => tx(req, async (c) => {
    await operator(c); const setup = id(req.params.id);
    if (req.body.confirmed !== true) fail(400, "Confirm that the company may now let its staff sign in");
    const r = (await c.query("select pulse.tenant_activate($1) r", [setup])).rows[0].r;
    if (!r.activated) fail(409, `Not activated: ${(r.blocked as string[]).join("; ")}`);
    return view(c, setup);
  }));

  // R54: the explicit readiness result for the operator's handover: the verdict (a rehearsal stays a rehearsal), every
  // open gate with the owner errands behind it, the pilot's evidence kinds and the feedback totals. Counts, no names.
  app.get<{ Params: { id: string } }>("/api/v0/tenants/:id/readiness", (req) => tx(req, async (c) => {
    await operator(c); const setup = id(req.params.id);
    if (!(await state(c, setup)).org) fail(409, "Create the company first");
    const g = (await c.query("select pulse.tenant_gates($1) g", [setup])).rows[0].g as SetupGates;
    return { company: g.company, readiness: readiness(g), gates: g.gates, pilot: g.pilot, sources: g.sources.map((s) => ({ key: s.key, kind: s.kind, ready: s.ready, why: s.why })) };
  }));

  app.post<{ Params: { id: string } }>("/api/v0/tenants/:id/open", (req) => tx(req, async (c) => {
    await operator(c); const setup = id(req.params.id);
    const r = (await c.query("select pulse.tenant_open($1) r", [setup])).rows[0].r;
    hosts.clear();
    if (!r.opened) fail(409, `Not opened: ${(r.blocked as string[]).join("; ")}`);
    return view(c, setup);
  }));

  // R53: the company's own side of the checklist (its admins and HR; sources are its admins' to register and decide).
  const companySetup = async (c: PoolClient) => {
    const s = (await c.query("select pulse.company_setup_state() s")).rows[0].s as { managed: boolean } & SetupGates;
    return s.managed ? { ...s, guide: setupGuide(s, "company"), readiness: readiness(s) } : s;
  };
  app.get("/api/v0/company-setup", (req) => tx(req, async (c) => companySetup(c)));
  app.post<{ Body: Body }>("/api/v0/company-setup/sources", { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!admin(v) || !v.person) fail(403, "Company admins register sources");
    const [source] = planSpec({ sources: [req.body] }).sources ?? [];
    await c.query("select pulse.company_source_add($1)", [JSON.stringify(source)]);
    return companySetup(c);
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/company-setup/sources/:id", { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!admin(v) || !v.person) fail(403, "Company admins decide on sources");
    if (!UUID.test(req.params.id)) fail(404, "Source not found");
    const decision = str(req.body.decision, 10);
    if (!["approved", "declined", "planned"].includes(decision)) fail(400, "Approve, decline or reopen the source");
    await c.query("select pulse.company_source_decide($1,$2,$3)", [req.params.id, decision, req.body.note == null ? null : str(req.body.note, 300)]);
    return companySetup(c);
  }));

  // R54: what the trial's pilot tried. Device checks: the company's admins and HR; the walkthrough: HR only (the database
  // decides). Each says what kind of evidence it is (mock, simulator, installed device, real data read only).
  app.post<{ Body: Body }>("/api/v0/company-setup/pilot-checks", { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!v.person || !(admin(v) || v.role === "hr")) fail(403, "Company admins and HR record what the pilot tried");
    await c.query("select pulse.company_pilot_check($1)", [JSON.stringify(pilotCheckInput(req.body))]);
    return companySetup(c);
  }));
  // R54: everyone's pilot feedback (P28). Four questions, once, anonymously: the database keeps only the totals.
  app.get("/api/v0/pilot-feedback", (req) => tx(req, async (c) => (await c.query("select pulse.pilot_feedback_mine() m")).rows[0].m));
  app.post<{ Body: Body }>("/api/v0/pilot-feedback", { schema: { body } }, (req) => tx(req, async (c) => {
    await c.query("select pulse.pilot_feedback_give($1)", [JSON.stringify(feedbackInput(req.body))]);
    return (await c.query("select pulse.pilot_feedback_mine() m")).rows[0].m;
  }));
}
