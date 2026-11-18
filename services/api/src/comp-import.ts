// COMP-A: the one-time conversion of a person's imported salary rows into their pay record (on dev now, on production
// at the release, as Pulse: the worker login, no viewer). Settled rows (a monthly salary, or a contractor's settled
// invoice) become approved versions; a proposed salary newer than them becomes an offer waiting for a founder's review.
// Nothing is approved or sent and nobody is notified. With --task, sending the offer later finishes that task (UX-5B).
// Prints kinds and dates only, never an amount. Without --apply nothing is written.
//   PULSE_DATABASE_URL_WORKER=… PULSE_DOCUMENT_KEY_FILE=… node services/api/dist/comp-import.js --org <uuid> --person <uuid> [--task <uuid>] [--apply]
import { randomUUID } from "node:crypto";
import pg from "pg";
import { requireKeyring, payContext, seal } from "./document-keys.js";
import { DEFAULT_TEMPLATE, normaliseFigures, setupPlan, type Component } from "./comp-model.js";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const org = arg("org"), pid = arg("person"), task = arg("task"), apply = process.argv.includes("--apply");
if (!org || !UUID.test(org) || !pid || !UUID.test(pid) || (task && !UUID.test(task))) { console.error("usage: comp-import --org <uuid> --person <uuid> [--task <uuid>] [--apply]"); process.exit(2); }
const url = process.env.PULSE_DATABASE_URL_WORKER ?? process.env.DATABASE_URL;
if (!url) { console.error("Set PULSE_DATABASE_URL_WORKER (or DATABASE_URL)"); process.exit(2); }
const sealed = (ring: Awaited<ReturnType<typeof requireKeyring>>, value: unknown, context: string) => {
  const s = seal(ring, Buffer.from(JSON.stringify(value), "utf8"), context);
  return { kid: s.keyId, key: s.dataKey.toString("base64"), data: s.data.toString("base64") };
};

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  await c.query("begin");
  if ((await c.query("select pg_has_role(current_user,'pulse_worker','SET') ok")).rows[0].ok) await c.query("set local role pulse_worker");
  await c.query("select set_config('pulse.org_id',$1,true)", [org]);
  const who = (await c.query("select p.display_name name,pp.role from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=$1 and p.side='staff'", [pid])).rows[0];
  if (!who) throw new Error("Person not found in this organisation");
  const rows = (await c.query(`select id,kind,effective_month::text "month",effective_from::text "effectiveFrom",amount,terms_status "termsStatus",terms_note "termsNote",source_name "sourceName"
    from pulse_priv.hr_compensation where person_id=$1 order by effective_month desc`, [pid])).rows;
  const plan = setupPlan(rows);
  const policy = (await c.query("select components,probation_days,offer_days from pulse.comp_policy where org_id=$1", [org])).rows[0];
  const template = (policy?.components ?? DEFAULT_TEMPLATE) as Component[];
  console.log(`${who.name}: ${rows.length} salary rows (${rows.map((r) => `${r.kind}${r.termsStatus ? ` ${r.termsStatus}` : ""} ${String(r.effectiveFrom ?? r.month).slice(0, 7)}`).join(", ")})`);
  console.log(plan.start ? `  version: ${plan.start.payType} from ${plan.start.on} (approved history, from "${plan.start.source}")` : "  version: none");
  console.log(plan.offer ? `  offer: salary from ${plan.offer.on}, waiting for a founder (from "${plan.offer.source}")${task ? `, linked to task ${task}` : ""}` : "  offer: none");
  if (!apply) { console.log("Dry run: nothing written. Add --apply."); await c.query("rollback"); }
  else {
    const ring = await requireKeyring("pay");
    const p: Record<string, unknown> = { person: pid, versions: [] };
    if (plan.start) {
      const vid = randomUUID();
      (p.versions as unknown[]).push({ id: vid, importRef: plan.start.id, payType: plan.start.payType, effectiveOn: plan.start.on, role: null,
        reason: plan.start.payType === "contractor" ? `Settled by invoice (${plan.start.source})` : `From the salary records (${plan.start.source})`,
        sealed: sealed(ring, normaliseFigures({ monthly: plan.start.amount }, plan.start.payType, template), payContext(org, pid, "change", vid)) });
    }
    if (plan.offer) {
      const changeId = randomUUID();
      p.offer = { changeId, importRef: plan.offer.id, role: String(who.role ?? "").replace(/\s*\(proposed\)\s*$/i, "") || "Role to confirm", startOn: plan.offer.on, payType: "salary",
        probationDays: policy?.probation_days ?? 90, terms: plan.offer.note ?? "", reason: `From the proposed terms (${plan.offer.source})`, taskId: task ?? null,
        sealed: sealed(ring, normaliseFigures({ monthly: plan.offer.amount }, "salary", template), payContext(org, pid, "change", changeId)) };
    }
    const r = (await c.query("select pulse.comp_import($1) r", [p])).rows[0].r;
    await c.query("commit");
    console.log(`Written: ${JSON.stringify(r.done.map((x: Record<string, string>) => Object.keys(x)[0]))}`);
  }
} catch (e) { await c.query("rollback").catch(() => undefined); console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
finally { await c.end(); }
