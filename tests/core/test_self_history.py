"""R43: My desk → History reads only what is really the person's. Imported monthly reports count only with a settled
owner (HR recorded it, or the report names the person's full name and has a source); a first-name match or a report
without a source stays with HR. Payslips are the ones HR issued, never a projection from salary records. Nothing of a
colleague's opens by changing an id. Synthetic tenants and names only."""
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

MONTH = "2026-09"


def _history(worker, w):
    rows = (
        ("pulse-month:hr", w.editor, "Editor One", "2026-01-01", "[]"),  # HR recorded it in Pulse
        ("drive:full", w.editor, "  editor   ONE ", "2025-12-01", '[{"sheet":"Dec 25","source":"drive_sheet"}]'),  # full name
        ("drive:first", w.editor, "Editor", "2025-11-01", '[{"sheet":"Nov 25"}]'),  # first name only
        ("drive:nosource", w.editor, "Editor One", "2025-10-01", "[]"),  # no source
        ("drive:other", w.editor2, "Editor Two", "2025-12-01", '[{"sheet":"Dec 25"}]'),
        ("drive:unknown", None, "Someone Else", "2025-12-01", '[{"sheet":"Dec 25"}]'),
    )
    with worker.transaction():
        set_tenant(worker, w.org)
        for key, person, label, month, evidence in rows:
            worker.execute("""insert into pulse.hr_month_history(org_id,source_key,person_id,person_label,month_label,month,leave_days,wfh_days,half_days,basis,evidence)
              values(%s,%s,%s,%s,%s,%s,1,2,null,'reported numeric count',%s)""", (w.org, key, person, label, month[:7], month, evidence))
        worker.execute("""insert into pulse_priv.hr_compensation(org_id,person_id,effective_month,kind,amount,source_file_id,source_name,source_sheet,basis)
          values(%s,%s,'2026-01-01','current',30000,'fixture','Synthetic salary','Salary','synthetic')""", (w.org, w.editor))
        for permission in ("hr.salary.read", "hr.salary.write"):
            worker.execute("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values(%s,%s,%s,'synthetic test')", (w.org, w.lead, permission))


def test_history_ownership_and_issued_payslips_in_the_database(api, worker, team):
    w = team
    _history(worker, w)
    mine = {r["source_key"]: r for r in as_(api, w, w.editor, "select * from pulse.hr_month_self()")}
    assert set(mine) == {"pulse-month:hr", "drive:full", "drive:first", "drive:nosource"}
    assert {k for k, r in mine.items() if r["resolved"]} == {"pulse-month:hr", "drive:full"}
    assert mine["pulse-month:hr"]["entered_by_hr"] and mine["drive:full"]["sheet"] == "Dec 25"
    assert {r["source_key"] for r in as_(api, w, w.editor2, "select * from pulse.hr_month_self() where resolved")} == {"drive:other"}
    # Salary records never become the employee's payslip; HR projects, reviews and issues.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.hr_payslip_project(%s,%s)", (w.editor, f"{MONTH}-01"))
    assert one(api, w, w.editor, "select pulse.hr_self_payslips() p")["p"] == []
    slip = one(api, w, w.lead, "select pulse.hr_payslip_project(%s,%s) p", (w.editor, f"{MONTH}-01"))["p"]
    assert slip["projection"] is True and slip["net"] == 30000
    one(api, w, w.lead, "select pulse.hr_payslip_issue(%s,%s,%s)", (w.editor, f"{MONTH}-01", slip["previewHash"]))
    issued = one(api, w, w.editor, "select pulse.hr_self_payslips() p")["p"]
    assert [(p["month"], p["version"]) for p in issued] == [(MONTH, 1)] and "net" not in json.dumps(issued)
    assert one(api, w, w.editor, "select pulse.hr_payslip_read(%s,%s) p", (w.editor, f"{MONTH}-01"))["p"]["projection"] is False
    assert one(api, w, w.editor2, "select pulse.hr_self_payslips() p")["p"] == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.hr_payslip_read(%s,%s)", (w.editor, f"{MONTH}-01"))


SCRIPT = r'''
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool,pool);
const call = async(url,email) => { const r=await app.inject({url,method:'GET',headers:{'cf-access-authenticated-user-email':email}}); return {status:r.statusCode,body:r.json()}; };
const member=process.env.TEST_MEMBER, head=process.env.TEST_HEAD, shared=process.env.TEST_SHARED, hr='hr@estateautopilots.com';
const me=process.env.TEST_MEMBER_ID, other=process.env.TEST_OTHER_ID, month=process.env.TEST_MONTH;
const out={};
out.history=await call('/api/v0/hr/self/history',member);
out.historyOther=await call('/api/v0/hr/self/history?person='+other,member);
out.historyShared=await call('/api/v0/hr/self/history',shared);
out.imported=await call('/api/v0/hr/imported-history',member);
out.importedOther=await call('/api/v0/hr/imported-history?person='+other,member);
out.importedHead=await call('/api/v0/hr/imported-history?person='+me,head);
out.importedHr=await call('/api/v0/hr/imported-history',hr);
out.slipBefore=await call(`/api/v0/hr/payslip/${me}?month=${month}`,member);
out.slipProjection=await call(`/api/v0/hr/payslip/${me}?month=${month}&projection=1`,member);
out.slipHr=await call(`/api/v0/hr/payslip/${me}?month=${month}`,hr);
out.slipHrOwn=await call(`/api/v0/hr/payslip/${process.env.TEST_HR_ID}?month=${month}&issued=1`,hr);
out.slipOther=await call(`/api/v0/hr/payslip/${other}?month=${month}`,member);
console.log('RESULT:'+JSON.stringify(out)); await app.close(); await pool.end();
'''


def test_history_through_the_api(api, worker, team):
    w = team
    _history(worker, w)
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        slip = api.execute("select pulse.hr_payslip_project(%s,%s) p", (w.editor, "2026-08-01")).fetchone()["p"]
        api.execute("select pulse.hr_payslip_issue(%s,%s,%s)", (w.editor, "2026-08-01", slip["previewHash"]))
    root = Path(__file__).resolve().parents[2]
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(w.org), "TEST_MEMBER": w.editor_handle,
           "TEST_HEAD": f"editor2@{w.domain}", "TEST_SHARED": w.shared_handle, "TEST_MEMBER_ID": str(w.editor),
           "TEST_OTHER_ID": str(w.editor2), "TEST_HR_ID": str(w.lead), "TEST_MONTH": MONTH}
    p = subprocess.run(["node", "--input-type=module", "-e", SCRIPT], cwd=root / "services/api", env=env, capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr[-2000:]
    r = json.loads(next(line[7:] for line in p.stdout.splitlines() if line.startswith("RESULT:")))
    status = {k: v["status"] for k, v in r.items()}
    assert status["historyShared"] in (401, 403)
    del status["historyShared"]
    assert status == {"history": 200, "historyOther": 200, "imported": 200, "importedOther": 403, "importedHead": 200, "importedHr": 200,
                      "slipBefore": 404, "slipProjection": 404, "slipHr": 200, "slipHrOwn": 404, "slipOther": 403}
    h = r["history"]["body"]
    # The person query is ignored: the route is bound to the signed-in person.
    assert r["historyOther"]["body"] == h | {"today": r["historyOther"]["body"]["today"]}
    assert [x["key"] for x in h["imported"]] == ["pulse-month:hr", "drive:full"]
    assert h["coverage"]["importedMonths"] == 2 and h["coverage"]["withHr"] == 2
    assert [p["month"] for p in h["payslips"]] == ["2026-08"] and set(h["payslips"][0]) == {"month", "version", "issuedAt"}
    text = json.dumps(h)
    for leak in ("Editor Two", "drive:other", "drive:unknown", "Someone Else", "drive:first", "drive:nosource"):
        assert leak not in text
    assert {x["source_key"] for x in r["imported"]["body"]["rows"]} == {"pulse-month:hr", "drive:full"} and r["imported"]["body"]["total"] == 2
    assert {x["source_key"] for x in r["importedHead"]["body"]["rows"]} == {"pulse-month:hr", "drive:full"}
    assert len(r["importedHr"]["body"]["rows"]) == 6
    assert r["slipHr"]["body"]["projection"] is True and r["slipHr"]["body"]["canIssue"] is True
