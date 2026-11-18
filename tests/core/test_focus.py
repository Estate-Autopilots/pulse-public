"""FOCUS (1845): the owner's capacity board is organisation admins' only, funding is leaders', and collectors reach
their own organisation through the ingest key's hash alone. Synthetic tenants, fake accounts and fake keys only."""
import hashlib
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, team  # noqa: F401  (team is a fixture)

TABLES = ("focus_account", "focus_company", "focus_lane", "focus_plan", "focus_sample", "focus_settings", "funding_program")


def fake_hash(w):
    """Each synthetic company gets its own fake collector key (the hash is unique across organisations)."""
    return hashlib.sha256(f"fk_FAKE_{w.org}".encode()).hexdigest()


def seed(owner, w):
    """Fixtures go in as the schema owner: the worker role never touches these tables (the bot reads through
    pulse.focus_plan_outbound only)."""
    worker = owner
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.focus_settings(org_id) values(%s) on conflict do nothing", (w.org,))
        worker.execute("insert into pulse_priv.focus_ingest_key(org_id,hash) values(%s,%s) on conflict (org_id) do update set hash=excluded.hash", (w.org, fake_hash(w)))
        worker.execute("insert into pulse.focus_company(org_id,key,name,weight,hue,sort) values(%s,'alpha','Alpha Fake Co',60,268,0),(%s,'beta','Beta Fake Co',40,150,1)", (w.org, w.org))
        worker.execute("insert into pulse.focus_account(org_id,key,name,companies) values(%s,'fake-max','Fake Max','{alpha}')", (w.org,))
        worker.execute("insert into pulse.funding_program(org_id,name,blocked_by) values(%s,'Fake Credits Programme','Company registration')", (w.org,))


def test_a_funding_program_keeps_its_https_link(owner, team):
    """LAND-CAPTAIN-6: the url check used a repetition count of 300 (Postgres allows 255), so any row with a link failed
    "invalid repetition count(s)" - production's migration seed among them. A https link is kept; anything else is not."""
    w = team
    with owner.transaction(force_rollback=True):
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.funding_program(org_id,name,url) values(%s,'Fake Linked Programme','https://example.test/fake-programme')", (w.org,))
        for bad in ("http://example.test/fake", "https://ex ample.test", "https://" + "x" * 301):
            with pytest.raises(psycopg.errors.CheckViolation), owner.transaction():
                owner.execute("insert into pulse.funding_program(org_id,name,url) values(%s,'Fake Bad Link',%s)", (w.org, bad))


def test_tables_force_row_security_with_a_tenant_policy(worker):
    rows = worker.execute("""select c.relname,c.relrowsecurity,c.relforcerowsecurity,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname = any(%s) order by 1""", (list(TABLES),)).fetchall()
    assert [(r["relname"], r["relrowsecurity"], r["relforcerowsecurity"], r["tenant"]) for r in rows] == [(t, True, True, True) for t in TABLES]


def test_board_is_the_admins_and_funding_the_leaders(api, owner, team):
    w = team
    seed(owner, w)
    assert [r["key"] for r in as_(api, w, w.manager, "select key from pulse.focus_account")] == ["fake-max"]
    for who in (w.editor, w.editor2, w.outsider):
        assert as_(api, w, who, "select key from pulse.focus_account") == []
        assert as_(api, w, who, "select name from pulse.funding_program") == []
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, "insert into pulse.focus_lane(org_id,key,title,company) values(pulse.current_org(),'fake-lane','Fake lane','alpha')")
    assert [r["name"] for r in as_(api, w, w.manager, "select name from pulse.funding_program")] == ["Fake Credits Programme"]


def test_ingest_by_key_hash_only(api, owner, team):
    w = team
    seed(owner, w)
    key_hash = fake_hash(w)
    body = {"samples": [{"account": "fake-max", "window": "5h", "usedPct": 42, "resetsAt": "2030-01-01T00:00:00Z"},
                        {"account": "not-ours", "window": "5h", "usedPct": 10}],
            "lanes": [{"key": "FAKE-LANE", "title": "Fake lane", "company": "alpha", "account": "fake-max"}]}
    with api.transaction():
        r = api.execute("select pulse.focus_ingest(%s,%s) r", (key_hash, json.dumps(body))).fetchone()["r"]
    assert (r["samples"], r["lanes"], r["org"]) == (1, 1, str(w.org))
    rows = as_(api, w, w.manager, "select s.used_pct::float8 u from pulse.focus_sample s join pulse.focus_account a on a.id=s.account_id where a.key='fake-max'")
    assert [x["u"] for x in rows] == [42.0]
    # Inputs for the plan and the plan itself, once a day.
    with api.transaction():
        x = api.execute("select pulse.focus_inputs(%s) x", (key_hash,)).fetchone()["x"]
        assert [c["key"] for c in x["companies"]] == ["alpha", "beta"] and x["lanes"][0]["key"] == "FAKE-LANE"
        assert api.execute("select pulse.focus_plan_publish(%s,'{\"placed\":[]}') ok", (key_hash,)).fetchone()["ok"] is True
        assert api.execute("select pulse.focus_plan_publish(%s,'{\"placed\":[]}') ok", (key_hash,)).fetchone()["ok"] is False
    # Only an admin makes a key; the board says one exists, never what it is.
    assert as_(api, w, w.manager, "select pulse.focus_key_set(%s) t", ("1" * 64,))[0]["t"] is not None
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.focus_key_set(%s)", ("2" * 64,))
    assert as_(api, w, w.editor, "select pulse.focus_key_made() t")[0]["t"] is None
    # An unknown key reaches nothing.
    with pytest.raises(psycopg.errors.InvalidAuthorizationSpecification):
        with api.transaction():
            api.execute("select pulse.focus_ingest(%s,'{}')", ("0" * 64,))


API = Path(__file__).resolve().parents[2] / "services/api"


def modules_on(worker, w, keys):
    with worker.transaction():
        set_tenant(worker, w.org)
        row = worker.execute("select body from pulse.tenant_config where org_id=%s and doc_kind='tenant' and doc_key='modules' and is_active", (w.org,)).fetchone()
        if row:
            body = row["body"]
            body["on"] = sorted(set(body.get("on", [])) | set(keys))
            worker.execute("update pulse.tenant_config set body=%s where org_id=%s and doc_kind='tenant' and doc_key='modules' and is_active", (json.dumps(body), w.org))
        else:
            worker.execute("insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) values(%s,'tenant','modules',1,%s,true)",
                           (w.org, json.dumps({"off": [], "on": keys})))


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_focus_and_funding_in_the_browser(api, worker, owner, team):
    """services/api/test/focus-browser-runner.mjs (PULSE_FOCUS_SCREENSHOTS=<dir> keeps the shots)."""
    w = team
    seed(owner, w)
    modules_on(worker, w, ["focus", "funding"])
    focus_rows(owner, w)
    accounts(worker, w)
    run_browser(w, conninfo_to_dict(dsn("api")))


def focus_rows(owner, w):
    worker = owner
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.focus_account set name='Fake Max One' where org_id=%s and key='fake-max'", (w.org,))
        worker.execute("""insert into pulse.focus_account(org_id,key,name,own_company,companies,source,sort) values
            (%s,'fake-two','Fake Max Two','beta','{beta,alpha}','manual',1)""", (w.org,))
        worker.execute("""insert into pulse.focus_account(org_id,key,name,kind,cost,tiers,source,sort) values
            (%s,'fake-credit','Fake Credit API','api','metered','{T0,T1}','api',2),(%s,'fake-cloud','Fake Cloud','cloud','metered','{}','manual',3)""", (w.org, w.org))
        worker.execute("update pulse.focus_account set own_company='alpha' where org_id=%s and key='fake-max'", (w.org,))
        # A week of fake readings: the 5-hour window rising and refilling.
        worker.execute("""insert into pulse.focus_sample(org_id,account_id,at,win,used_pct,resets_at,company)
            select %s, a.id, now() - make_interval(hours => h), '5h', ((168 - h) %% 5) * 18 + (case when a.key='fake-two' then 5 else 0 end),
                   now() - make_interval(hours => h) + interval '3 hours', case when h %% 3 = 0 then 'beta' end
              from pulse.focus_account a, generate_series(1, 160, 2) h where a.org_id=%s and a.key in ('fake-max','fake-two')""", (w.org, w.org))
        worker.execute("""insert into pulse.focus_sample(org_id,account_id,win,used_pct,resets_at)
            select %s, id, '7d', 38, now() + interval '3 days' from pulse.focus_account where org_id=%s and key='fake-max'""", (w.org, w.org))
        worker.execute("""insert into pulse.focus_sample(org_id,account_id,win,amount,currency)
            select %s, id, 'balance', 12.5, 'USD' from pulse.focus_account where org_id=%s and key='fake-credit'""", (w.org, w.org))
        worker.execute("""insert into pulse.focus_lane(org_id,key,title,company,value,size,need,urgent,blocked_by) values
            (%s,'FAKE-1','Fake lane: build the thing','alpha',8,'M','T2',false,null),
            (%s,'FAKE-2','Fake lane: tidy the docs','beta',4,'S','T1',false,null),
            (%s,'FAKE-3','Fake lane: app store listing','alpha',6,'L','T2',false,'Fake company registration')""", (w.org, w.org, w.org))
        worker.execute("update pulse.funding_program set name='Fake Cloud Credits', amount='$1,000 (fake)', blocked_by='Fake company registration' where org_id=%s", (w.org,))


def accounts(worker, w):
    with worker.transaction():
        set_tenant(worker, w.org)
        for who, handle in ((w.manager, "owner"), (w.editor, "member")):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, f"{handle}@{w.domain}", who))


def run_browser(w, config):
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_EMAILS": json.dumps({"owner": f"owner@{w.domain}", "member": f"member@{w.domain}"})}
    p = subprocess.run(["node", "test/focus-browser-runner.mjs"], cwd=API, env=env, capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
