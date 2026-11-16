"""CASE-STUDIES (1966): case files are leaders' and admins' only, links point to records without copying them, and the
migration's switch and seed land only in the Vitals organisation. Synthetic tenants and fake names only."""
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_focus import accounts, modules_on
from test_tasks_rt1 import as_, team  # noqa: F401  (team is a fixture)

API = Path(__file__).resolve().parents[2] / "services/api"

TABLES = ("case_study", "case_study_link")


def seed(owner, w):
    with owner.transaction():
        set_tenant(owner, w.org)
        row = owner.execute("""insert into pulse.case_study(org_id,name,started_on,checks,months)
            values(%s,'Example Fake Co',current_date,'{"convince.offer": true}','[{"month":"2026-08","revenue":420000,"clients":6,"leads":40}]') returning id""", (w.org,)).fetchone()
    return row["id"]


def test_tables_force_row_security_with_a_tenant_policy(worker):
    rows = worker.execute("""select c.relname,c.relrowsecurity,c.relforcerowsecurity,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='case_study_leaders' and not p.polpermissive) leaders
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname = any(%s) order by 1""", (list(TABLES),)).fetchall()
    assert [(r["relname"], r["relrowsecurity"], r["relforcerowsecurity"], r["tenant"], r["leaders"]) for r in rows] == [(t, True, True, True, True) for t in TABLES]


def test_case_files_are_for_admins_only_here(api, owner, team):
    """The team's admin (manager) sees and changes the case; the members, the pod head and HR without leadership do not."""
    w = team
    cid = seed(owner, w)
    assert [r["name"] for r in as_(api, w, w.manager, "select name from pulse.case_study")] == ["Example Fake Co"]
    for who in (w.editor, w.editor2, w.outsider):
        assert as_(api, w, who, "select name from pulse.case_study") == []
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, "insert into pulse.case_study(org_id,name,started_on) values(pulse.current_org(),'Fake Sneak Co',current_date)")
    as_(api, w, w.manager, "update pulse.case_study set stage=2 where id=%s returning id", (cid,))
    assert as_(api, w, w.manager, "select stage from pulse.case_study where id=%s", (cid,))[0]["stage"] == 2


def test_checks_and_numbers_keep_their_shape(owner, team):
    w = team
    with owner.transaction(force_rollback=True):
        set_tenant(owner, w.org)
        for bad in ("""{"name":"x"}""",):
            with pytest.raises(psycopg.errors.CheckViolation), owner.transaction():
                owner.execute("insert into pulse.case_study(org_id,name,started_on,months) values(%s,'Fake Bad Co',current_date,%s)", (w.org, bad))
        with pytest.raises(psycopg.errors.CheckViolation), owner.transaction():
            owner.execute("insert into pulse.case_study(org_id,name,started_on,stage) values(%s,'Fake Bad Co',current_date,10)", (w.org,))
        with pytest.raises(psycopg.errors.CheckViolation), owner.transaction():
            owner.execute("insert into pulse.case_study(org_id,name,started_on) values(%s,'   ',current_date)", (w.org,))


def test_a_link_holds_only_the_id_and_goes_with_its_case(api, owner, team):
    w = team
    cid = seed(owner, w)
    with owner.transaction():
        set_tenant(owner, w.org)
        client = owner.execute("insert into pulse.client(org_id,display_name) values(%s,'Fake Client Co') returning id", (w.org,)).fetchone()["id"]
        owner.execute("insert into pulse.case_study_link(org_id,case_id,kind,ref_id,note) values(%s,%s,'client',%s,'Their client record')", (w.org, cid, client))
        with pytest.raises(psycopg.errors.CheckViolation), owner.transaction():
            owner.execute("insert into pulse.case_study_link(org_id,case_id,kind,ref_id) values(%s,%s,'invoice',%s)", (w.org, cid, client))
    assert [r["kind"] for r in as_(api, w, w.manager, "select kind from pulse.case_study_link")] == ["client"]
    assert as_(api, w, w.editor, "select kind from pulse.case_study_link") == []
    as_(api, w, w.manager, "delete from pulse.case_study where id=%s returning id", (cid,))
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse.case_study_link where case_id=%s", (cid,)).fetchone()["n"] == 0
        assert owner.execute("select count(*) n from pulse.client where id=%s", (client,)).fetchone()["n"] == 1, "the record itself stays"


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_case_studies_in_the_browser(api, worker, owner, team):
    """services/api/test/case-studies-browser-runner.mjs (PULSE_CASE_SCREENSHOTS=<dir> keeps the shots)."""
    w = team
    modules_on(worker, w, ["case_studies"])
    accounts(worker, w)
    with owner.transaction():
        set_tenant(owner, w.org)
        meeting = owner.execute("""insert into pulse.meeting(org_id,title,started_by,kind,source) values(%s,'Fake first talk',%s,'notes','notes') returning id""", (w.org, w.manager)).fetchone()["id"]
        months = json.dumps([{"month": f"2026-{m:02d}", "revenue": r, "clients": c, "leads": l} for m, r, c, l in
                             ((3, 1800000, 9, 90), (4, 1500000, 8, 80), (5, 1200000, 7, 70), (6, 700000, 5, 50), (7, 500000, 4, 45), (8, 400000, 4, 40))])
        lotus = owner.execute("""insert into pulse.case_study(org_id,name,sector,aim,stage,started_on,checks,months,pains,problems,lead_person_id,sort)
            values(%s,'Example Lotus Fake Co','Interior design','Bring revenue back to its best month',2,current_date - 11,
              '{"convince.offer":true,"convince.demo":true,"convince.yes":true,"data.agree":true}',%s,'["Slow replies to new leads","Quotes take too long"]','{Revenue fell}',%s,0) returning id""",
                              (w.org, months, w.manager)).fetchone()["id"]
        owner.execute("insert into pulse.case_study_link(org_id,case_id,kind,ref_id,note) values(%s,%s,'meeting',%s,'12:30-13:10 Fake clip line')", (w.org, lotus, meeting))
        harbor = owner.execute("""insert into pulse.case_study(org_id,name,sector,started_on,checks,sort)
            values(%s,'Example Harbor Fake Co','Real estate',current_date - 3,'{"convince.offer":true,"convince.demo":true}',1) returning id""", (w.org,)).fetchone()["id"]
        owner.execute("""insert into pulse.case_study(org_id,name,stage,started_on,sort) values
            (%s,'Example Coral Fake Co',3,current_date - 20,2),(%s,'Example Skyview Fake Co',1,current_date,3),(%s,'Example Greenline Fake Co',6,current_date - 50,4)""", (w.org, w.org, w.org))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_CASES": json.dumps({"lotus": str(lotus), "harbor": str(harbor)}),
           "TEST_EMAILS": json.dumps({"owner": f"owner@{w.domain}", "member": f"member@{w.domain}"})}
    p = subprocess.run(["node", "test/case-studies-browser-runner.mjs"], cwd=API, env=env, capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
