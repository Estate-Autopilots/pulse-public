#!/usr/bin/env node
// TASKS-P0 (11 Oct 2026): a synthetic "Kazuk-like" co-founder on the DEV database, so the task screens can be judged
// with a realistic load: 27 open tasks (mixed due dates, numbered steps in the notes, in-app places and links), the
// colleagues whose work waits on them (the unlock graph), comments with @mentions, a PDF proof and an HR-protected
// document. Everybody here is synthetic: names end in "(synthetic)" on their role, sign-ins use @synthetic.invalid.
//
// Tasks, projects, blockers, proof, comments and moves go through the real API routes, signed in as the synthetic
// people (Neha, a synthetic leader, creates Kedab's tasks as Savuzo created Kazuk's, so no real person is told about
// any of it); only the people, their sign-ins and the protected document (an HR import, like work_history.py) are
// written directly. Never point this at production.
//
//   set -a; . /etc/estate-autopilots/db/pulse_dev.env; set +a
//   node tools/tasks-p0-seed.mjs [--api http://127.0.0.1:3203] [--reset] [--remove] [--out <seed.json>]
//     --reset   remove the synthetic people and everything they touched, then seed again
//     --remove  remove only
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pg = createRequire(join(root, "services/api/package.json"))("pg");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const API = opt("api", "http://127.0.0.1:3203");
const OUT = opt("out", join(process.env.HOME, "ea-research/ux/tasks-p0/seed.json"));
const ORG = "6f1a455d-ced2-504d-b8d5-5ae0efbe7c75";
const DOMAIN = "synthetic.invalid";
const url = process.env.MIGRATE_DATABASE_URL;
if (!url) throw new Error("Load /etc/estate-autopilots/db/pulse_dev.env first (MIGRATE_DATABASE_URL)");
if (!/pulse_dev/.test(url)) throw new Error("This seed only runs on the dev database (pulse_dev)");

const PEOPLE = {
  kedab: { name: "Kedab Mifos", role: "Co-founder / CEO (synthetic)", pod: "Leadership", department: "Leadership", leadership: true },
  asha: { name: "Asha Kireteso", role: "HR executive (synthetic)", pod: "Shared", department: "Operations" },
  rifob: { name: "Rifob Iyer", role: "Engineer (synthetic)", pod: "Tech", department: "Technology" },
  meera: { name: "Meera Jivop", role: "Finance (synthetic)", pod: "Shared", department: "Finance" },
  neha: { name: "Neha Soniba", role: "Chief of staff (synthetic)", pod: "Leadership", department: "Leadership", leadership: true },
};
const email = (key) => `${key}.${PEOPLE[key].name.split(" ")[1].toLowerCase()}@${DOMAIN}`;
const ACTOR = email("neha");

// IST today, and days around it.
const istToday = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const plus = (n) => new Date(Date.parse(`${istToday}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekday = new Date(`${istToday}T00:00:00Z`).getUTCDay();
const nextMonday = plus(((8 - weekday) % 7) || 7), friday = plus(Math.max(1, (5 - weekday + 7) % 7));

const LAUNCH = "Launch & admin (synthetic)", ROADMAP = "Tech roadmap (synthetic)";
/** Kedab's 27 open tasks. `waits` are other keys this one waits on; `steps` notes read like the real launch tasks. */
const KEDAB = [
  { key: "leavers", project: LAUNCH, due: plus(-1), priority: "high", value: 5, minutes: 10, reviewer: "asha", title: "Tell HR who has left (Nisha, Varun and anyone else)",
    notes: "Send HR the names of everyone who has left the team: Nisha, Varun, and anyone else.\nThen they are taken out of the groups and get no Pulse invite.", valueNote: "Unlocks: clean invites for the whole team; ex-staff leave the groups." },
  { key: "wifi", project: LAUNCH, due: istToday, priority: "high", value: 5, minutes: 15, reviewer: "asha", title: "Send HR the office Wi-Fi name and the office public IP",
    notes: "Send HR two things: the office Wi-Fi name, and the public IP address of the office internet. Pulse uses them to check people in when they arrive at the office.\n1. Connect a phone or laptop to the office Wi-Fi.\n2. Search Google for \"what is my IP\" and copy the address: https://www.google.com/search?q=what+is+my+ip\n3. Send both to Asha on WhatsApp.\nHR adds both in Pulse → HR → Policies → Office presence.",
    valueNote: "Unlocks: check-in on arrival, so attendance is accurate and payroll can come from Pulse." },
  { key: "rules", project: LAUNCH, due: istToday, priority: "high", value: 8, minutes: 30, reviewer: "asha", title: "Decide the check-in rules",
    notes: "Decide three things and tell HR:\n1. Arrival: \"ask first\" (Pulse asks \"Check in?\") or \"automatic\".\n2. Reminder times.\n3. The payroll cut-off date.\nHR sets them in Pulse → HR → Onboard team → Check-in settings.", valueNote: "Unlocks: check-in reminders, the payroll cut-off and October payroll from Pulse." },
  { key: "notice", project: LAUNCH, due: plus(1), priority: "high", value: 8, minutes: 20, reviewer: "asha", title: "Approve staff notice v2 (privacy and consent)",
    notes: "1. Read staff notice v2 (privacy and consent) in Pulse → HR → Policies.\n2. Tell HR you approve it, or what to change.\nHR then publishes it.", valueNote: "Unlocks: the team launch, work-activity tracking and ID uploads (the legal basis for all three)." },
  { key: "message", project: LAUNCH, due: nextMonday, priority: "high", value: 5, minutes: 15, reviewer: "asha", title: "Approve the staff WhatsApp message and send it Monday 10:00",
    notes: "The draft message is in Pulse → HR → Onboard team → Rollout kit.\n1. Read the draft.\n2. Approve it in the kit.\n3. Send it to the staff group on Monday at 10:00.", valueNote: "Unlocks: the team launch on Monday." },
  { key: "invites", project: LAUNCH, due: nextMonday, priority: "high", value: 8, minutes: 10, reviewer: "asha", title: "Make sure HR invites everyone to Pulse on Monday 10:00",
    notes: "Check with Asha that every current team member gets a Pulse invite on Monday at 10:00.\nThe invite list is in Pulse → HR → Onboard team.", valueNote: "Unlocks: the whole team on Pulse: tasks, chats, attendance and bank details in one place." },
  { key: "bank", project: LAUNCH, due: friday, priority: "normal", value: 5, minutes: 20, reviewer: "meera", title: "Make sure every team member adds their bank details in Pulse",
    notes: "1. Open Pulse → HR → Onboard team and see who has no bank details yet.\n2. Remind them in the staff group.\n3. Tell Meera when everyone is done.", valueNote: "Unlocks: October salaries paid from Pulse." },
  { key: "billing", project: LAUNCH, due: friday, priority: "normal", value: 3, minutes: 45, reviewer: "meera", title: "Change the billing email on every vendor to billing@",
    notes: "Change the billing email to billing@ on:\n1. Google Workspace: https://admin.google.com/ac/billing\n2. Airtel\n3. Zoho\n4. The domain registrar", valueNote: "Unlocks: every bill reaches the finance bot." },
  { key: "gstemail", project: LAUNCH, due: friday, priority: "normal", value: 2, minutes: 10, reviewer: "meera", title: "Ask the CA to change the GST portal email to billing@",
    notes: "Ask the CA to change the email on the GST portal to billing@ so notices reach finance.", valueNote: "Unlocks: GST notices reach finance on time." },
  { key: "gst", project: LAUNCH, due: plus(-2), priority: "urgent", value: 13, minutes: 60, reviewer: "meera", status: "in_progress", title: "File GSTR-1 (Jul–Sep) and GSTR-3B with the CA",
    notes: "1. Send the CA the sales register for July to September.\n2. Check the CA's draft of GSTR-1.\n3. Approve it on the GST portal: https://www.gst.gov.in/\n4. Repeat for GSTR-3B before the 22nd.", valueNote: "Avoids late fees and interest on late tax." },
  { key: "statements", project: LAUNCH, due: friday, priority: "high", value: 5, minutes: 20, reviewer: "meera", title: "Upload the bank statements to Finance → Bank statements",
    notes: "1. Download July to September statements from the bank.\n2. Upload them in Pulse → Finance → Bank statements.", valueNote: "Unlocks: the CA pack for September." },
  { key: "zoho", project: LAUNCH, due: plus(9), priority: "high", value: 8, minutes: 90, reviewer: "meera", title: "Zoho: confirm Zoho Books, export all invoices, set up billing@ and the CA",
    notes: "1. Confirm the company uses Zoho Books.\n2. Export every invoice as CSV.\n3. Add billing@ as a user.\n4. Invite the CA as an accountant.", valueNote: "Unlocks: invoices in Pulse Finance." },
  { key: "gstin", project: LAUNCH, due: plus(10), priority: "normal", value: 3, minutes: 30, reviewer: "meera", title: "Add the company GSTIN on the Google Workspace, Airtel and Zoho billing profiles",
    notes: "Add the GSTIN on each billing profile so the invoices carry it and input tax can be claimed.", valueNote: "Unlocks: input tax credit on three vendors." },
  { key: "duns", project: LAUNCH, due: plus(12), priority: "normal", value: 5, minutes: 40, reviewer: "rifob", title: "Apply for a D-U-N-S number for the company",
    notes: "1. Open https://www.dnb.com/duns-number/get-a-duns.html\n2. Apply with the company's registered address.\n3. Forward the confirmation email to Rifob.", valueNote: "Unlocks: the Google Play and Apple Developer accounts." },
  { key: "firebase", project: LAUNCH, due: plus(3), priority: "normal", value: 5, minutes: 20, reviewer: "rifob", title: "Create a Firebase project in the company Google account and share the config with Rifob",
    notes: "1. Open https://console.firebase.google.com with the company account.\n2. Create a project called Pulse.\n3. Add an Android app and download google-services.json.\n4. Send it to Rifob.", valueNote: "Unlocks: push notifications in the Pulse phone app." },
  { key: "stores", project: LAUNCH, due: plus(20), priority: "low", value: 8, minutes: 60, reviewer: "rifob", waits: ["duns"], title: "Open the Google Play and Apple Developer accounts (after D-U-N-S)",
    notes: "After the D-U-N-S number arrives:\n1. Open the Google Play Console as an organisation.\n2. Enrol in the Apple Developer Program.\n3. Add Rifob as an admin on both.", valueNote: "Unlocks: the Pulse app in both stores." },
  { key: "whatsapp", project: LAUNCH, due: null, priority: "low", value: 5, minutes: 60, reviewer: "rifob", title: "Set up WhatsApp Business: Meta verification or a provider",
    notes: "Choose Meta's own verification or a provider, and start it. Rifob has a comparison in the Tech roadmap.", valueNote: "Unlocks: Pulse messages on WhatsApp." },
  { key: "lawyer", project: LAUNCH, due: null, priority: "normal", value: 5, minutes: 30, reviewer: "asha", title: "Get a lawyer to review the consent text and how long ID documents are kept",
    notes: "Share staff notice v2 and the document retention note with a lawyer. Ask for changes in writing.", valueNote: "Lowers the legal risk of ID uploads." },
  { key: "invoice", project: LAUNCH, due: istToday, priority: "high", value: 3, minutes: 10, reviewer: "meera", title: "Approve and pay Rifob's September invoice",
    notes: "1. Open the invoice in Pulse → Finance.\n2. Approve it.\n3. Pay it from the current account and attach the receipt here.", valueNote: "Keeps the engineer paid on time." },
  { key: "offer", project: LAUNCH, due: plus(1), priority: "high", value: 5, minutes: 30, reviewer: "asha", title: "Issue Rifob's offer letter and share the payroll details",
    notes: "1. Read the draft offer letter attached here (protected).\n2. Sign it.\n3. Ask Asha to add Rifob to payroll.", valueNote: "Unlocks: Rifob on payroll this month." },
  // The seven older tasks, as on the real board.
  { key: "oldnotice", project: ROADMAP, due: plus(-4), priority: "high", value: 5, minutes: 20, reviewer: "rifob", title: "Approve the staff notice that enables check-in and ID uploads",
    notes: "Read the staff notice and approve it so check-in and ID uploads can start." },
  { key: "roadmap", project: ROADMAP, due: plus(2), priority: "normal", value: 8, minutes: 45, reviewer: "rifob", title: "Review the Pulse roadmap PDF and mark the decisions",
    notes: "1. Open the roadmap PDF attached here.\n2. Mark agree or change on each decision on page 2.\n3. Tell Rifob in a comment.", valueNote: "Unlocks: the next three weeks of engineering." },
  { key: "internet", project: null, due: plus(5), priority: "normal", value: 3, minutes: 20, title: "Sign the vendor agreement for the office internet",
    notes: "The agreement is in the shared drive under Admin. Sign and send it back to the vendor." },
  { key: "brand", project: null, due: null, priority: "low", value: 2, minutes: 15, title: "Share the brand guidelines with the design team",
    notes: "Send the latest brand guidelines PDF to the design group." },
  { key: "offsite", project: null, due: null, priority: "low", value: 2, minutes: 15, title: "Pick a date for the team offsite" , notes: null },
  { key: "lease", project: null, due: plus(14), priority: "normal", value: 3, minutes: 20, title: "Reply to the landlord about the lease renewal",
    notes: "Say yes to 11 months, and ask for the deposit terms in writing." },
  { key: "welcome", project: null, due: null, priority: "low", value: 3, minutes: 30, title: "Record a 2-minute welcome video for new joiners",
    notes: "1. Write five lines: who we are, what we make, how we work.\n2. Record on a phone in landscape.\n3. Upload it to Pulse → Company." },
];
/** Finished this week: the progress ring and the streak have something to show. */
const DONE = [
  { key: "workspace", project: LAUNCH, title: "Set up the company Google Workspace", reviewer: "rifob", value: 5 },
  { key: "salary", project: LAUNCH, title: "Send the September salary sheet to the CA", reviewer: "meera", value: 3 },
];
/** Colleagues' work that waits on Kedab's tasks (the unlock graph). */
const WAITING = [
  { key: "w-groups", who: "asha", project: LAUNCH, due: plus(2), value: 3, waits: ["leavers"], title: "Remove leavers from the WhatsApp groups" },
  { key: "w-invite", who: "asha", project: LAUNCH, due: nextMonday, value: 8, waits: ["leavers", "notice", "invites"], title: "Send Pulse invites to the whole team" },
  { key: "w-office", who: "asha", project: LAUNCH, due: plus(2), value: 3, waits: ["wifi"], title: "Add the office Wi-Fi and IP in Pulse → HR → Policies → Office presence" },
  { key: "w-remind", who: "asha", project: LAUNCH, due: plus(3), value: 5, waits: ["rules"], title: "Turn on check-in reminders" },
  { key: "w-publish", who: "asha", project: LAUNCH, due: plus(2), value: 3, waits: ["notice"], title: "Publish staff notice v2 in Pulse → HR → Policies" },
  { key: "w-payroll", who: "meera", project: LAUNCH, due: plus(18), value: 13, waits: ["rules", "bank"], title: "Run October payroll from Pulse" },
  { key: "w-capack", who: "meera", project: LAUNCH, due: plus(8), value: 5, waits: ["statements"], title: "Send the CA pack for September" },
  { key: "w-bot", who: "meera", project: LAUNCH, due: plus(9), value: 3, waits: ["billing"], title: "Point the finance bot at billing@" },
  { key: "w-push", who: "rifob", project: LAUNCH, due: plus(7), value: 8, waits: ["firebase"], title: "Turn on push notifications in the Pulse phone app" },
  { key: "w-play", who: "rifob", project: LAUNCH, due: plus(30), value: 13, waits: ["stores"], title: "Publish the Pulse app on Google Play" },
];
const SUBTASKS = [
  { parent: "zoho", title: "Export every invoice as CSV", done: true },
  { parent: "zoho", title: "Add billing@ as a Zoho user" },
  { parent: "zoho", title: "Invite the CA as an accountant" },
  { parent: "gst", title: "Send the CA the sales register", done: true },
  { parent: "gst", title: "Approve GSTR-1 on the portal" },
];
const COMMENTS = [
  { on: "wifi", by: "asha", mention: ["kedab"], body: "@Kedab Mifos the Wi-Fi name is on the router label; I can't see the IP from home. Could you send both today?" },
  { on: "gst", by: "meera", mention: ["kedab"], body: "@Kedab Mifos the CA needs the sales register by 4 pm to file on time." },
  { on: "roadmap", by: "rifob", mention: ["kedab", "asha"], body: "@Kedab Mifos page 2 has the four decisions. @Asha Kireteso the check-in one affects HR." },
];

// ------------------------------------------------------------------------------------------------------ database
const db = new pg.Client({ connectionString: url, application_name: "tasks-p0-seed" });
await db.connect();
await db.query("select set_config('pulse.org_id',$1,false)", [ORG]);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

async function syntheticIds() {
  return (await q(`select a.holder_person_id id from pulse.account a where a.provider='google' and a.handle like '%@${DOMAIN}' and a.holder_person_id is not null`)).map((r) => r.id);
}

/** Deletes rows of `table` matching `where`, first deleting (recursively) every row that references them. */
async function purge(table, where, params, depth = 0) {
  if (depth > 10) throw new Error(`purge too deep at ${table}`);
  const [schema, name] = table.split(".");
  const refs = await q(`select cl.relnamespace::regnamespace::text sch,cl.relname tbl,a.attname col,fa.attname fcol,c.confdeltype del
    from pg_constraint c join pg_class cl on cl.oid=c.conrelid join pg_class fc on fc.oid=c.confrelid
    join lateral unnest(c.conkey,c.confkey) k(attnum,fattnum) on true join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
    join pg_attribute fa on fa.attrelid=c.confrelid and fa.attnum=k.fattnum
    where c.contype='f' and fc.relname=$1 and fc.relnamespace::regnamespace::text=$2 and array_length(c.conkey,1)=1`, [name, schema]);
  for (const r of refs) {
    if (r.del === "c") continue;               // on delete cascade
    const child = `${r.sch}.${r.tbl}`;
    const sub = `"${r.col}" in (select "${r.fcol}" from ${table} where ${where})`;
    if (!(await db.query(`select 1 from ${child} where ${sub} limit 1`, params)).rowCount) continue;   // nothing refers to these rows
    if (r.del === "n") { await db.query(`update ${child} set "${r.col}"=null where ${sub}`, params); continue; }  // set null
    if (child === table) await db.query(`update ${child} set "${r.col}"=null where ${sub}`, params);
    else await purge(child, sub, params, depth + 1);
  }
  return (await db.query(`delete from ${table} where ${where}`, params)).rowCount;
}

async function remove() {
  const ids = await syntheticIds();
  if (!ids.length) { console.log("nothing synthetic to remove"); return; }
  await db.query("begin");
  try {
    const projects = (await q(`select id from pulse.project where title in ($1,$2)`, [LAUNCH, ROADMAP])).map((r) => r.id);
    const tasks = (await q(`with recursive t(id) as (select id from pulse.task where coalesce(assignee_person_id,owner_id)=any($1) or created_by=any($1) or project_id=any($2)
      union select c.id from pulse.task c join t on c.parent_id=t.id) select id from t`, [ids, projects])).map((r) => r.id);
    const hrFiles = (await q(`select id from pulse_priv.hr_file where person_id=any($1) and source_key like 'tasks-p0:%'`, [ids])).map((r) => r.id);
    const n = {};
    n.notifications = await purge("pulse.notification", "person_id=any($1) or (subject_type='task' and subject_id=any($2))", [ids, tasks]);
    n.tasks = await purge("pulse.task", "id=any($1)", [tasks]);
    n.hrFiles = hrFiles.length ? await purge("pulse_priv.hr_file", "id=any($1)", [hrFiles]) : 0;
    n.projects = projects.length ? await purge("pulse.project", "id=any($1)", [projects]) : 0;
    n.accounts = await purge("pulse.account", `handle like '%@${DOMAIN}'`, []);
    // Rows only their viewer can see (opening pages writes them): delete them as each person, as release-smoke does.
    for (const pid of ids) {
      await db.query("select set_config('pulse.viewer_id',$1,true)", [pid]);
      for (const t of ["insight_decision", "role_brief", "brief_preference", "insight_receipt"]) await db.query(`delete from pulse.${t} where viewer_id=$1`, [pid]);
    }
    await db.query("select set_config('pulse.viewer_id','',true)");
    n.people = await purge("pulse.person", "id=any($1)", [ids]);
    await db.query("commit");
    console.log("removed", JSON.stringify(n));
  } catch (e) { await db.query("rollback"); throw e; }
}

async function ensurePeople() {
  const out = {};
  for (const [key, p] of Object.entries(PEOPLE)) {
    const handle = email(key);
    let id = (await q(`select holder_person_id id from pulse.account where provider='google' and handle=$1`, [handle]))[0]?.id;
    if (!id) {
      id = (await q(`insert into pulse.person(org_id,display_name,side,status,tracking_excluded,active_from) values($1,$2,'staff','active',true,$3) returning id`, [ORG, p.name, plus(-60)]))[0].id;
      await q(`insert into pulse.people_profile(org_id,person_id,role,pod,accounts,evidence,department,email,joined_on,notes) values($1,$2,$3,$4,$5::text[],$6,$7,($5::text[])[1],$8,$9)`,
        [ORG, id, p.role, p.pod, [handle], "Synthetic test person (TASKS-P0 seed)", p.department, plus(-60), "Synthetic: made by tools/tasks-p0-seed.mjs for the task screens. Remove with --remove."]);
      await q(`insert into pulse.account(org_id,provider,handle,holder_person_id,is_shared,is_company_owned,purpose) values($1,'google',$2,$3,false,true,'Workspace account (synthetic)')`, [ORG, handle, id]);
      if (p.leadership) await q(`insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values($1,$2,'leadership',$3)`, [ORG, id, plus(-60)]);
    }
    out[key] = { id, name: p.name, email: handle };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------ the API
async function call(path, body, as = ACTOR) {
  const r = await fetch(`${API}/api/v0/${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "cf-access-authenticated-user-email": as }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${path}: ${r.status} ${typeof data === "object" ? data.error ?? text : text}`.slice(0, 400));
  return data;
}

async function seed() {
  const people = await ensurePeople();
  const kedab = people.kedab.id;
  const have = (await q(`select count(*)::int n from pulse.task where coalesce(assignee_person_id,owner_id)=$1`, [kedab]))[0].n;
  if (have) { console.log(`Kedab already has ${have} tasks: run with --reset to seed again`); return writeOut(people); }
  const projects = {};
  for (const [name, summary] of [[LAUNCH, "Synthetic: everything that has to happen before the team moves onto Pulse."], [ROADMAP, "Synthetic: what engineering builds next."]]) {
    projects[name] = (await call("work/projects", { type: "internal", name, summary, ownerId: kedab })).id;
  }
  // Category, colour and icon (TASKS-P0 API; skipped on an API without the route).
  for (const [name, style] of [[LAUNCH, { category: "launch", color: "violet", icon: "rocket" }], [ROADMAP, { category: "internal", color: "indigo", icon: "code" }]])
    await call(`work/projects/${projects[name]}/style`, style, email("kedab")).catch((e) => console.log(`project style skipped: ${String(e.message).slice(0, 80)}`));
  const ids = {};
  const make = async (t, assignee, parentId) => {
    const r = await call("work/tasks", { title: t.title, assigneeId: assignee, parentId, projectId: t.project ? projects[t.project] : null, dueOn: t.due ?? null, priority: t.priority ?? "normal",
      notes: t.notes ?? undefined, reviewerId: t.reviewer ? people[t.reviewer].id : undefined, valuePoints: t.value, estimateMinutes: t.minutes });
    if (r.asked) throw new Error(`${t.title}: became a request, not an assignment`);
    if (t.valueNote) await call(`tasks/${r.id}`, { valueNote: t.valueNote });
    return r.id;
  };
  for (const t of KEDAB) ids[t.key] = await make(t, kedab);
  for (const t of WAITING) ids[t.key] = await make(t, people[t.who].id);
  for (const t of DONE) { ids[t.key] = await make(t, kedab); }
  for (const s of SUBTASKS) { const parent = KEDAB.find((k) => k.key === s.parent); const id = await make({ ...s, project: parent.project, reviewer: parent.reviewer }, kedab, ids[s.parent]); if (s.done) await call(`tasks/${id}/move`, { status: "done" }, people.kedab.email); }
  for (const t of [...KEDAB, ...WAITING]) for (const w of t.waits ?? []) await call(`tasks/${ids[t.key]}/block`, { blockerId: ids[w] });
  for (const t of KEDAB.filter((k) => k.status)) await call(`tasks/${ids[t.key]}/move`, { status: t.status }, people.kedab.email);
  for (const t of DONE) await call(`tasks/${ids[t.key]}/move`, { status: "done" }, people.kedab.email);

  // Proof: a PDF file on the roadmap review, links on two more, and a protected offer letter (an HR document).
  const pdf = readFileSync(join(root, "tests/e2e/fixtures/tasks-p0/roadmap-synthetic.pdf"));
  const proofs = {};
  proofs.pdf = (await call(`tasks/${ids.roadmap}/proof`, { name: "roadmap-synthetic.pdf", mime: "application/pdf", bytes: pdf.toString("base64"), label: "Pulse roadmap (synthetic).pdf" })).id;
  await call(`tasks/${ids.billing}/proof`, { url: "https://admin.google.com/ac/billing", label: "Workspace billing page" });
  await call(`tasks/${ids.workspace}/proof`, { url: "https://admin.google.com/", label: "Workspace admin console" });
  const offer = readFileSync(join(root, "tests/e2e/fixtures/tasks-p0/offer-letter-synthetic.pdf"));
  const hr = (await q(`insert into pulse_priv.hr_file(org_id,person_id,doc_kind,title,name,mime,bytes,sha256,source_key) values($1,$2,'offer','Offer letter (synthetic draft)','offer-letter-synthetic.pdf','application/pdf',$3,$4,$5)
    on conflict (org_id,source_key) do update set bytes=excluded.bytes returning id`, [ORG, people.rifob.id, offer, createHash("sha256").update(offer).digest("hex"), "tasks-p0:offer-letter"]))[0].id;
  proofs.protected = (await q(`insert into pulse.task_proof(org_id,task_id,kind,label,hr_file_id,source_key) values($1,$2,'document','Offer letter (synthetic draft)',$3,'tasks-p0:offer-letter') returning id`, [ORG, ids.offer, hr]))[0].id;

  for (const c of COMMENTS) await call("work/comments", { taskId: ids[c.on], body: c.body, mentions: c.mention.map((k) => people[k].id) }, people[c.by].email);
  // A guard: nothing the seed did may reach a real person's notifications (or a phone). Expect zero.
  const seeded = Object.values(ids), synthetic = Object.values(people).map((p) => p.id);
  const stray = `select n.id from pulse.notification n where not (n.person_id=any($2)) and (n.subject_id=any($1) or n.subject_id in (select id from pulse.work_comment where task_id=any($1)))`;
  await q(`delete from pulse.native_push_delivery where sent_at is null and notification_id in (${stray})`, [seeded, synthetic]);
  const cleared = (await q(`delete from pulse.notification where id in (${stray}) returning id`, [seeded, synthetic])).length;
  if (cleared) console.log(`cleared ${cleared} notifications the seed caused for real people`);
  return writeOut(people, ids, projects, proofs);
}

async function writeOut(people, ids, projects, proofs) {
  const saved = ids ? { at: new Date().toISOString(), api: API, people, projects, tasks: ids, proofs } : JSON.parse(readFileSync(OUT, "utf8"));
  mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(saved, null, 1));
  const open = (await q(`select count(*)::int n from pulse.task where coalesce(assignee_person_id,owner_id)=$1 and status in ('open','in_progress','blocked')`, [people.kedab.id]))[0].n;
  console.log(`Kedab Mifos (${people.kedab.id}): ${open} open tasks · seed written to ${OUT}`);
}

try {
  if (args.includes("--remove") || args.includes("--reset")) await remove();
  if (!args.includes("--remove")) await seed();
} finally { await db.end(); }
