#!/usr/bin/env node
// UX-5A (13 Oct 2026): the four personas the walk needs, on top of TASKS-P0's synthetic people (tools/tasks-p0-seed.mjs):
// staff = Rifob, HR = Asha (gets the hr role here), a founder = Kedab (leadership, outcome-based here: no check-in),
// admin = Tara (made here, admin role).
// Everybody is synthetic (sign-ins @synthetic.invalid); only the DEV database. Never point this at production.
//
//   set -a; . /etc/estate-autopilots/db/pulse_dev.env; set +a
//   node tools/ux5a-seed.mjs [--remove]
//     --remove  take Asha's hr role back and remove Tara (tasks-p0-seed.mjs --remove also removes Tara)
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pg = createRequire(join(root, "services/api/package.json"))("pg");
const ORG = "6f1a455d-ced2-504d-b8d5-5ae0efbe7c75";
const url = process.env.MIGRATE_DATABASE_URL;
if (!url) throw new Error("Load /etc/estate-autopilots/db/pulse_dev.env first (MIGRATE_DATABASE_URL)");
if (!/pulse_dev/.test(url)) throw new Error("This seed only runs on the dev database (pulse_dev)");
const TARA = { name: "Tara Kapoor", email: "tara.kapoor@synthetic.invalid", role: "Operations admin (synthetic)", pod: "Shared", department: "Operations" };
const ASHA = "asha.kireteso@synthetic.invalid", KEDAB = "kedab.mifos@synthetic.invalid", NOTE = "UX-5A walk: outcome-based founder (synthetic)";

const db = new pg.Client({ connectionString: url });
await db.connect();
await db.query("select set_config('pulse.org_id',$1,false)", [ORG]);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const holder = async (handle) => (await q(`select holder_person_id id from pulse.account where provider='google' and handle=$1`, [handle]))[0]?.id;

try {
  const asha = await holder(ASHA);
  if (!asha) throw new Error("Run tools/tasks-p0-seed.mjs first (no synthetic Asha)");
  await db.query("begin");
  if (process.argv.includes("--remove")) {
    await q(`delete from pulse.role_assignment where person_id=$1 and role_key='hr'`, [asha]);
    await q(`delete from pulse.person_work_terms where person_id=$1 and note=$2`, [await holder(KEDAB), NOTE]);
    const tara = await holder(TARA.email);
    if (tara) {
      for (const t of ["insight_decision", "role_brief", "brief_preference", "insight_receipt"]) {
        await db.query("select set_config('pulse.viewer_id',$1,true)", [tara]);
        await db.query(`delete from pulse.${t} where viewer_id=$1`, [tara]);
      }
      await db.query("select set_config('pulse.viewer_id','',true)");
      await q(`delete from pulse.notification where person_id=$1`, [tara]);
      await q(`delete from pulse.role_assignment where person_id=$1`, [tara]);
      await q(`delete from pulse.account where holder_person_id=$1`, [tara]);
      await q(`delete from pulse.people_profile where person_id=$1`, [tara]);
      await q(`delete from pulse.person where id=$1`, [tara]);
    }
    console.log("removed: Asha's hr role, Tara");
  } else {
    if (!(await q(`select 1 from pulse.role_assignment where person_id=$1 and role_key='hr' and (valid_to is null or valid_to>now())`, [asha])).length)
      await q(`insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values($1,$2,'hr',current_date-60)`, [ORG, asha]);
    const kedab = await holder(KEDAB);
    if (kedab) await q(`insert into pulse.person_work_terms(org_id,person_id,work_mode,note) values($1,$2,'outcome',$3) on conflict (person_id) do nothing`, [ORG, kedab, NOTE]);
    let tara = await holder(TARA.email);
    if (!tara) {
      tara = (await q(`insert into pulse.person(org_id,display_name,side,status,tracking_excluded,active_from) values($1,$2,'staff','active',true,current_date-60) returning id`, [ORG, TARA.name]))[0].id;
      await q(`insert into pulse.people_profile(org_id,person_id,role,pod,accounts,evidence,department,email,joined_on,notes) values($1,$2,$3,$4,$5::text[],$6,$7,($5::text[])[1],current_date-60,$8)`,
        [ORG, tara, TARA.role, TARA.pod, [TARA.email], "Synthetic test person (UX-5A seed)", TARA.department, "Synthetic: made by tools/ux5a-seed.mjs for the UX-5A walk. Remove with --remove."]);
      await q(`insert into pulse.account(org_id,provider,handle,holder_person_id,is_shared,is_company_owned,purpose) values($1,'google',$2,$3,false,true,'Workspace account (synthetic)')`, [ORG, TARA.email, tara]);
      await q(`insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values($1,$2,'admin',current_date-60)`, [ORG, tara]);
    }
    console.log(JSON.stringify({ asha, tara }));
  }
  await db.query("commit");
} catch (e) { await db.query("rollback").catch(() => null); throw e; } finally { await db.end(); }
