"""Exercise real HTTP handlers and RLS on synthetic tenant data."""
import json
import os
import subprocess
import uuid
from pathlib import Path
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from helpers import build_world
from pulse_sdk.db import set_tenant


def test_api_roles_attendance_leave_and_validation(worker, owner, api):
    w = build_world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("select pulse.hr_defaults()")
        # Today is a working day whatever day CI runs (check-in refuses a weekly off): no change Monday to Saturday.
        owner.execute("update pulse.hr_policy set work_days=array(select distinct d from unnest(work_days||extract(isodow from now() at time zone 'Asia/Kolkata')::int) d order by d)")
        owner.execute("update pulse.hr_policy set attendance_enabled=true where org_id=%s", (w.org,))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.account set purpose='Workspace account' where handle=%s", (w.editor_handle,))
        for email, pid, role in (("admin@estateautopilots.com", w.manager, "admin"),
                                 ("hr@estateautopilots.com", w.lead, "hr")):
            worker.execute("insert into pulse.account(id,org_id,provider,handle,holder_person_id,purpose) "
                           "values (%s,%s,'google',%s,%s,'Workspace account')", (uuid.uuid4(), w.org, email, pid))
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) "
                           "values (%s,%s,%s,'2026-01-01')", (w.org, pid, role))
    root = Path(__file__).resolve().parents[2]
    script = r'''
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool,pool);
const call = async(url,email,payload) => {
 const r=await app.inject({url,method:payload?'POST':'GET',headers:email?{'cf-access-authenticated-user-email':email}:{},...(payload?{payload}:{})});
 return {status:r.statusCode,body:r.json()};
};
const member=process.env.TEST_MEMBER;
const out=[];
out.push(await call('/api/v0/my-week',null));
out.push(await call('/api/v0/my-week','nobody@example.test'));
out.push(await call('/api/v0/leadership-week',member));
out.push(await call('/api/v0/my-week','hr@estateautopilots.com'));
out.push(await call('/api/v0/leadership-week','admin@estateautopilots.com'));
out.push(await call('/api/v0/my-week?week=2026-W99',member));
out.push(await call('/api/v0/attendance/check-in',member,{}));
out.push(await call('/api/v0/attendance/check-in',member,{}));
out.push(await call('/api/v0/attendance/check-out',member,{}));
out.push(await call('/api/v0/leave',member,{fromDate:'2026-02-30',toDate:'2026-03-01',kind:'annual'}));
const leave=await call('/api/v0/leave',member,{fromDate:'2026-10-09',toDate:'2026-10-10',kind:'annual'});
out.push(leave);
out.push(await call(`/api/v0/leave/${leave.body.id}/decision`,member,{decision:'approved'}));
out.push(await call(`/api/v0/leave/${leave.body.id}/decision`,'hr@estateautopilots.com',{decision:'approved'}));
out.push(await call(`/api/v0/leave/${leave.body.id}/decision`,'hr@estateautopilots.com',{decision:'rejected'}));
out.push(await call('/api/v0/attendance','hr@estateautopilots.com'));
out.push(await call('/api/v0/leave','hr@estateautopilots.com'));
// Company-wide insights are for organisation admins only, and carry counts, never salary or contact data.
out.push(await call('/api/v0/insights',member));
out.push(await call('/api/v0/insights','hr@estateautopilots.com'));
out.push(await call('/api/v0/insights','admin@estateautopilots.com'));
console.log('RESULT:'+JSON.stringify(out)); await app.close(); await pool.end();
'''
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(w.org), "TEST_MEMBER": w.editor_handle}
    p = subprocess.run(["node", "--input-type=module", "-e", script], cwd=root / "services/api",
                       env=env, capture_output=True, text=True, check=True, timeout=30)
    result = json.loads(next(line[7:] for line in p.stdout.splitlines() if line.startswith("RESULT:")))
    assert [r["status"] for r in result][:16] == [401,403,403,403,200,400,200,409,200,400,200,403,200,409,200,200]
    assert result[12]["body"]["status"] == "approved"
    member_insights, hr_insights, admin_insights = result[16], result[17], result[18]
    assert member_insights["status"] == 403 and hr_insights["status"] == 403 and admin_insights["status"] == 200
    body = admin_insights["body"]
    assert len(body["weeks"]) == 12 and len(body["attendance"]) == 14
    assert {"mix", "clients", "pods", "teams", "people", "identity", "stages", "quiet", "accounts"} <= set(body)
    assert body["people"]["headcount"] >= 1 and sum(p["people"] for p in body["pods"]) == body["people"]["headcount"]
    assert body["identity"]["recent"] == body["identity"]["shared"] + body["identity"]["credited"] + body["identity"]["unlinked"]
    assert not any(word in json.dumps(body).lower() for word in ("salary", "amount", "personal_phone", "personalemail"))
