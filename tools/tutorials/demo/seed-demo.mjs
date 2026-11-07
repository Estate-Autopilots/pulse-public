#!/usr/bin/env node
// Reels demo data for "Brightside Studio" (dev only, fictional): an AI employee (Luna) that asks before it acts, a
// client group with a client's question and Luna's pending "Send it" proposal to the coordinator, a synthetic finance
// model for the Focus home, and sign-in for the coordinator. Everything is written inside the demo company only: the
// script refuses any organisation that is not the rehearsal company at reels-demo.localhost.
//
//   set -a; . /etc/estate-autopilots/db/pulse_dev.env; set +a
//   node tools/tutorials/demo/seed-demo.mjs [--logins <file>] [--reset-r1]
//     --logins   write the coordinator's new password there (mode 600); never printed
//     --reset-r1 put the "Send it" proposal back to pending and remove Luna's posted reply (for a re-take)
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.PULSE_ROOT || join(dirname(fileURLToPath(import.meta.url)), "../../..");
const pg = createRequire(join(root, "services/api/package.json"))("pg");
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };
const HOST = "reels-demo.localhost";
const url = process.env.MIGRATE_DATABASE_URL;
if (!url || !/pulse_dev/.test(url)) throw new Error("Load /etc/estate-autopilots/db/pulse_dev.env first (dev database only)");

const db = new pg.Client({ connectionString: url });
await db.connect();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const as = async (viewer) => { await q("select set_config('pulse.viewer_id',$1,false)", [viewer ?? ""]); };

const org = (await one("select org_id, rehearsal from pulse.host_org($1)", [HOST]));
if (!org || !org.rehearsal) throw new Error(`${HOST} is not a rehearsal company: run setup-demo.mjs first`);
const ORG = org.org_id;
await q("select set_config('pulse.org_id',$1,false)", [ORG]);
const person = async (username) => (await one(`select p.id from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.org_id=$1 and pp.username=$2`, [ORG, username]))?.id;
const meera = await person("meera.shah"), rifob = await person("rifob.desai"), isha = await person("isha.kapoor"), ahoro = await person("ahoro.nair");
if (!meera || !rifob) throw new Error("Meera or Rifob is missing: run setup-demo.mjs first");

// The owner's demo vocabulary: Luna (the AI employee) and Skyline Heights (a fictional real-estate client).
const AI_NAME = "Luna";
const GROUP = "Skyline Heights";
const ASK = "Hi team! Can we move Saturday's site shoot to Friday morning? The show flat opens that weekend.";
const REPLY = "Yes, Friday morning works! Isha and Ahoro are free from 10. We'll shoot the show flat then and share the first cut on Monday.";
const WHY = "The shoot calendar has Friday morning free for Isha and Ahoro, and the brief only needs the show flat ready.";
// Earlier takes used other fictional names; existing rows are renamed in place so a re-run never leaves both.
const RENAMES = [
  ["Nova", AI_NAME], ["Sunrise Bakers", GROUP],
  ["Hi team! Can we move Saturday's shoot to Friday morning? Our new cake range launches that weekend.", ASK],
  ["Yes, Friday morning works! Isha and Ahoro are free from 10. We'll shoot the new cake range then and share the first cut on Monday.", REPLY],
  ["The shoot calendar has Friday morning free for Isha and Ahoro, and the brief only needs the bakery open.", WHY],
  ["Morning Kabir! The shoot plan for the cake range is in the brief. Shoot is on Saturday at the bakery.", "Morning Kabir! The shoot plan for the show flat is in the brief. Shoot is on Saturday at the site."],
  ["Morning Kabir! The shoot plan for the show flat is in the brief. Shoot is on Saturday at the bakery.", "Morning Kabir! The shoot plan for the show flat is in the brief. Shoot is on Saturday at the site."],
  ["Plan the cake range shoot", "Plan the show flat shoot"],
];

async function send(author, channel, body, minutesAgo) {
  // Written directly (viewer unset), so no AI run is triggered: the demo's proposal is seeded below instead.
  return (await one(`insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id,created_at)
                     values($1,$2,$3,$4,gen_random_uuid(),now() - make_interval(mins => $5)) returning id`, [ORG, channel, author, body, minutesAgo])).id;
}

try {
  if (args.includes("--reset-r1")) {
    const pr = await one(`select * from pulse.agent_proposal where org_id=$1 and kind='reply' order by created_at desc limit 1`, [ORG]);
    if (!pr) throw new Error("no proposal to reset");
    await q("begin");
    if (pr.posted_message_id) await q("delete from pulse.chat_message where id=$1", [pr.posted_message_id]);
    if (pr.decision_message_id) await q("delete from pulse.chat_message where id=$1", [pr.decision_message_id]);
    await q(`update pulse.agent_proposal set state='pending', sent_body=null, decided_by=null, decided_at=null, decided_via=null, decision_message_id=null, posted_message_id=null where id=$1`, [pr.id]);
    await q(`update pulse.chat_member set read_through = now() - interval '1 hour' where channel_id in ($1,$2) and person_id=$3`, [pr.dm_channel_id, pr.channel_id, rifob]);
    await q("commit");
    console.log("r1 reset: proposal pending again");
    process.exit(0);
  }

  await q("begin");
  // Rename earlier fictional names in place (person, channels, messages, the proposal, tasks).
  for (const [a, b] of RENAMES) {
    if (a === b) continue;
    await q(`update pulse.person set display_name=$3 where org_id=$1 and display_name=$2`, [ORG, a, b]);
    await q(`update pulse.chat_channel set name=replace(name,$2,$3), description=replace(description,$2,$3) where org_id=$1 and (name like '%'||$2||'%' or description like '%'||$2||'%')`, [ORG, a, b]);
    await q(`update pulse.agent_proposal set body=replace(body,$2,$3), why=replace(why,$2,$3), sent_body=replace(sent_body,$2,$3) where org_id=$1`, [ORG, a, b]);
    // Messages and tasks are only visible to their members: rename them as each demo person in turn.
    for (const viewer of [rifob, meera, isha, ahoro].filter(Boolean)) {
      await as(viewer);
      await q(`update pulse.chat_message set body=replace(body,$2,$3) where org_id=$1 and position($2 in body) > 0`, [ORG, a, b]);
      await q(`update pulse.task set title=replace(title,$2,$3) where org_id=$1 and position($2 in title) > 0`, [ORG, a, b]);
    }
    await as(null);
  }
  await q(`update pulse.people_profile pp set username='luna.brightside' from pulse.person p where p.id=pp.person_id and p.org_id=$1 and pp.username='nova.brightside'`, [ORG]);
  // Admins are not sent to two-step set-up on every sign-in in this demo company.
  await q(`update pulse_priv.auth_policy set required=false where org_id=$1`, [ORG]);
  // A demo company is handed over at once (the wizard's last step), so its staff can sign in.
  await q(`update pulse.org set activation='live' where id=$1 and rehearsal and activation='trial'`, [ORG]);

  // The coordinator signs in with a password (bcrypt via pgcrypto, as Pulse does). The file is written after commit.
  let writeLogins = null;
  if (opt("logins")) {
    const file = opt("logins");
    const logins = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    const has = await one(`select 1 from pulse.login_credential where person_id=$1 and status='active'`, [rifob]);
    if (!logins["rifob.desai"] || !has) {
      const pw = `Demo-${randomBytes(9).toString("base64url")}`;
      await q(`insert into pulse.login_credential(org_id,person_id,password_hash,must_change,status) values($1,$2,crypt($3,gen_salt('bf',10)),false,'active')
               on conflict (person_id) do update set password_hash=excluded.password_hash, must_change=false, status='active', failed_attempts=0, locked_until=null`, [ORG, rifob, pw]);
      logins["rifob.desai"] = pw;
      writeLogins = () => writeFileSync(file, JSON.stringify(logins, null, 1), { mode: 0o600 });
    }
  }

  // The client: Kabir from Skyline Heights (a client-side person of this company).
  let kabir = (await one(`select id from pulse.person where org_id=$1 and display_name='Kabir Mehra' and side='client'`, [ORG]))?.id;
  if (!kabir) kabir = (await one(`insert into pulse.person(org_id,display_name,side,status,active_from) values($1,'Kabir Mehra','client','active',current_date - 40) returning id`, [ORG])).id;

  // Luna, the AI employee: answers the client group only after Rifob says "Send it".
  let ai = (await one(`select am.person_id id from pulse.agent_member am join pulse.person p on p.id=am.person_id where am.org_id=$1 and p.display_name=$2`, [ORG, AI_NAME]))?.id;
  if (!ai) {
    await as(meera);
    const made = (await one(`select pulse.agent_create($1::jsonb) r`, [JSON.stringify({ name: AI_NAME, title: "Client coordinator AI", ownerId: meera, lane: "quick", username: "luna.brightside" })])).r;
    ai = made?.id ?? made?.personId ?? (await one(`select am.person_id id from pulse.agent_member am join pulse.person p on p.id=am.person_id where am.org_id=$1 and p.display_name=$2`, [ORG, AI_NAME])).id;
  }
  await q(`update pulse.agent_member set listens_to='leaders', autonomy='{"direct":"approve","mention":"approve","group":"approve"}'::jsonb, approver_person_id=$2 where person_id=$1`, [ai, rifob]);

  // The client group, with a little history and the client's question.
  let group = (await one(`select id from pulse.chat_channel where org_id=$1 and name=$2 and kind='custom'`, [ORG, GROUP]))?.id;
  if (!group) {
    group = (await one(`insert into pulse.chat_channel(org_id,key,name,kind,description,created_by) values($1,'custom:'||gen_random_uuid(),$2,'custom','Skyline Heights and the Brightside team',$3) returning id`, [ORG, GROUP, rifob])).id;
    for (const p of [rifob, meera, isha, ahoro, kabir, ai]) await q(`insert into pulse.chat_member(org_id,channel_id,person_id,read_through) values($1,$2,$3,now() - interval '3 hours') on conflict do nothing`, [ORG, group, p]);
    await send(rifob, group, "Morning Kabir! The shoot plan for the show flat is in the brief. Shoot is on Saturday at the site.", 180);
    await send(kabir, group, "Looks great, thank you!", 170);
    await send(isha, group, "I'll bring the macro lens for the close-ups.", 160);
    const ask = await send(kabir, group, ASK, 6);
    // Luna's private question to Rifob (what pulse.agent_propose writes after a real run).
    const dmKey = `dm:${[ai, rifob].sort()[0]}:${[ai, rifob].sort()[1]}`;
    const dm = (await one(`insert into pulse.chat_channel(org_id,key,name,kind,description) values($1,$2,'Direct message','direct','A private conversation')
                           on conflict (org_id,key) do update set key=excluded.key returning id`, [ORG, dmKey])).id;
    for (const p of [ai, rifob]) await q(`insert into pulse.chat_member(org_id,channel_id,person_id,read_through) values($1,$2,$3,now() - interval '3 hours') on conflict do nothing`, [ORG, dm, p]);
    const dmBody = `Kabir Mehra wrote in “${GROUP}”:\n“${ASK}”\nI have not answered there. This is what I would post: Send it, Edit, or Don't (a reply like “fine, send it” works too).`;
    const dmMsg = await send(ai, dm, dmBody, 5);
    await as(null);
    await q(`insert into pulse.agent_proposal(org_id,agent_id,channel_id,source_message_id,approver_id,dm_channel_id,dm_message_id,kind,body,why,state,created_at)
             values($1,$2,$3,$4,$5,$6,$7,'reply',$8,$9,'pending',now() - interval '5 minutes')`, [ORG, ai, group, ask, rifob, dm, dmMsg, REPLY, WHY]);
  }

  // A synthetic finance picture for the Focus home (fictional amounts; never EA's).
  await q(`insert into pulse_priv.finance_live_model(org_id, body, computed_at) values($1,$2::jsonb,now())
           on conflict (org_id) do update set body=excluded.body, computed_at=now()`, [ORG, JSON.stringify(financeModel())]);
  await q("commit");
  if (writeLogins) writeLogins();
  console.log(JSON.stringify({ org: ORG, ai, group, kabir }));
} catch (e) {
  await q("rollback").catch(() => {});
  throw e;
} finally {
  await db.end();
}

function financeModel() {
  const today = new Date(Date.now() + 330 * 60000);
  const ym = (back) => { const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 1)); return d.toISOString().slice(0, 7); };
  const iso = today.toISOString().slice(0, 10);
  const months = [5, 4, 3, 2, 1, 0].map((b, i) => ({ month: ym(b), invoiced: [620000, 700000, 680000, 760000, 820000, 410000][i], invoicedGross: 0, invoices: 6 + i, collected: [560000, 640000, 650000, 700000, 690000, 300000][i], collectedLines: 5, collectedBasis: "bank", revenue: null, revenueBasis: null, confidence: "high" }));
  const inv = (n, client, amount, days) => ({ invoice: `BS-${n}`, number: `BS-${n}`, client, date: iso, due: iso, total: amount, amount, outstanding: amount, daysOverdue: days, status: "unpaid", confirmed: true });
  const top = [inv(118, "Skyline Heights", 96000, 41), inv(121, "Greenleaf Cafe", 64000, 18), inv(109, "Urban Threads", 52000, 74)];
  return {
    asOf: iso, certified: false, certification: "Synthetic demo data", brief: [],
    revenue: { months, fiscal: [], best: null, worst: null, clientCount: 9, basis: "demo",
      clients: [{ client: "Skyline Heights", invoiced: 900000, collected: 804000, invoiceShare: 0.22, collectedShare: 0.21, invoices: 8, first: null, last: null, outstanding: 96000 }] },
    collections: { invoices: top, outstanding: { count: 5, amount: 248000 }, evidenceEnd: iso, paidRate: 0.91, paidRateBasis: "demo",
      overdue: { count: 3, amount: 212000, buckets: [{ bucket: "1–30 days", count: 1, amount: 64000 }, { bucket: "31–60 days", count: 1, amount: 96000 }, { bucket: "61–90 days", count: 1, amount: 52000 }],
        top, confirmed: { count: 2, amount: 160000, top: top.slice(0, 2) }, unverified: { count: 1, amount: 52000, top: top.slice(2) } } },
    expenses: { months: [], categories: [], vendors: [] },
    payroll: [{ month: ym(1), total: 420000, people: 6, basis: "demo", confidence: "high", source: "demo" }],
    burn: { avgMonthlyCost: 610000, avgMonthlyInvoiced: 698000, net: 88000, runwayMonths: 9, runwayNote: null, balance: { amount: 1850000, asOf: iso, ageDays: 2 }, basis: "demo" },
    margins: { operating: { months: [], revenue: 0, cost: 0, margin: null, basis: "demo" }, packages: [], clients: [], note: "" },
    software: { ownerMonthly: 0, aiMonthly: 0, officeMonthly: 0, tools: [], renewals30: [] },
    adSpend: { months: [], total: 0, receipts: 0, avg3: null, basis: "demo", note: "", confidence: "low" },
    compliance: { quarters: [], gaps: [], late: [], upcoming: [], notices: [] },
    anomalies: [], reconcile: { suggestions: [], matched: 0, evidenceEnd: null, unmatchedInvoices: 0, unmatchedCredits: 0 },
    forecast: { months: [], assumptions: [], confidence: "low", basis: "demo" }, budget: { vsActual: [] }, timeline: [], suspense: [], missing: [],
    activeClients: { active: 9, names: [], invoiced60: 9, sheets: [], basis: "demo", confidence: "medium" },
  };
}
