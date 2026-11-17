"""AI-TOOLS-FIX (17 Nov 2026, migration 2210; EA bugs #25 and #31): AI employees reach their Pulse tools on every engine.

In the database: a company-server job an AI employee asked for gets a Pulse MCP token that acts as that AI employee
(its areas, its pause, its member row; read areas only; an AI session), where before every such token was refused
(403 "This key has no API v1 area grants here"); a person's job still acts as the person.
Through the API (services/api/test/ai-tools-fix-runner.mjs): with its own key and with such a job token, an AI employee
lists its tools, finds staff with their work emails (no phone: that is HR's), reads attendance as its person may (not
other people's), and is still refused what only a person does (its own change list, filing leave).
Synthetic people, servers and figures only.
"""
import json
import os
import secrets
import subprocess
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant

from test_runners import _paired, _people, _sha
from test_runner_access import _agent, _as_agent


def _ai_job_token(api, w, admin, runner_id, cred, aid):
    """The runtime's "runner" engine: the AI employee queues a read-only Claude job; the server takes it and its token."""
    with api.transaction():
        set_tenant(api, w.org, admin)
        api.execute("select pulse.runner_access_set(%s,'read-only',true,true,'Synthetic: AI employees may use this server')", (runner_id,))
    with api.transaction():
        _as_agent(api, w, aid)
        job = api.execute("select pulse.runner_agent_job_create(%s,'claude','Synthetic task look',null,'read-only',600,1) id", (runner_id,)).fetchone()["id"]
    token = "pmt_" + secrets.token_urlsafe(32)[:43]
    with api.transaction():
        api.execute("select pulse.runner_session(%s)", (_sha(cred),))
        api.execute("update pulse.runner_job set status='delivered',delivered_at=now() where id=%s", (job,))
        api.execute("select pulse.runner_mcp_issue(%s,%s)", (job, _sha(token)))
    with api.transaction():
        set_tenant(api, w.org, admin)
        assert api.execute("select requested_by_type t from pulse.runner_job where id=%s", (job,)).fetchone()["t"] == "ai-employee"
    return job, token


def test_an_ai_employees_job_token_acts_as_that_ai_employee(worker, owner, api):
    w = build_world(worker, owner, api)
    p = _people(worker, w, ["admin", "person"], f"{w.code.lower()}.example")
    runner_id, cred, _ = _paired(api, w, p["admin"])
    aid = _agent(owner, w, p["admin"])
    job, token = _ai_job_token(api, w, p["admin"], runner_id, cred, aid)

    def principal(scope):
        with api.transaction():
            set_tenant(api, w.org)
            v = api.execute("select pulse.v1_runner_principal(%s,%s) v", (_sha(token), scope)).fetchone()["v"]
            who = api.execute("""select nullif(current_setting('pulse.viewer_id',true),'') viewer, pulse.agent_session() agent,
                nullif(current_setting('pulse.actor_account',true),'') actor""").fetchone()
            return v, who

    v, who = principal("tasks.read")
    assert v is not None, "EA bug #25: an AI employee's job token was refused on every area"
    assert who == {"viewer": str(aid), "agent": aid, "actor": f"runner:{job}"}, "it acts as the AI employee, in an AI session"
    assert principal("people.read")[0] is not None
    v, who = principal("tasks.write")
    assert v is None and who["viewer"] is None and who["agent"] is None, "a job token holds read areas only"

    # The areas its managers left it narrow its jobs too; a paused company's AI employees reach nothing; nor does one
    # whose member row is switched off.
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        api.execute("select pulse.agent_access_set(%s,array['people.read'],null)", (aid,))
    assert principal("tasks.read")[0] is None and principal("people.read")[0] is not None
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        api.execute("select pulse.agent_access_set(%s,pulse.v1_scopes(),null)", (aid,))
        api.execute("select pulse.agent_pause_set(true,'Synthetic pause')")
    v, who = principal("tasks.read")
    assert v is None and who["viewer"] is None
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        api.execute("select pulse.agent_pause_set(false,null)")
    assert principal("tasks.read")[0] is not None
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        owner.execute("update pulse.agent_member set disabled_at=now() where person_id=%s", (aid,))
    v, who = principal("tasks.read")
    assert v is None and who["viewer"] is None and who["agent"] is None

    # A person's job still acts as the person (and not in an AI session).
    pjob = "job_" + secrets.token_hex(16)
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        api.execute("""insert into pulse.runner_job(org_id,id,runner_id,kind,prompt,time_limit_sec,cost_cap_usd,requested_by)
                       values(%s,%s,%s,'claude','Synthetic prompt',600,1,%s)""", (w.org, pjob, runner_id, p["admin"]))
    ptoken = "pmt_" + secrets.token_urlsafe(32)[:43]
    with api.transaction():
        api.execute("select pulse.runner_session(%s)", (_sha(cred),))
        api.execute("update pulse.runner_job set status='delivered',delivered_at=now() where id=%s", (pjob,))
        api.execute("select pulse.runner_mcp_issue(%s,%s)", (pjob, _sha(ptoken)))
    with api.transaction():
        set_tenant(api, w.org)
        assert api.execute("select pulse.v1_runner_principal(%s,'tasks.read') v", (_sha(ptoken),)).fetchone()["v"] is not None
        assert api.execute("select current_setting('pulse.viewer_id') v, pulse.agent_session() a").fetchone() == {"v": str(p["admin"]), "a": None}


def test_ai_employee_reads_people_and_attendance_as_itself_over_the_api(worker, owner, api):
    w = build_world(worker, owner, api)
    p = _people(worker, w, ["admin", "person"], f"{w.code.lower()}.example")
    runner_id, cred, _ = _paired(api, w, p["admin"])
    aid = _agent(owner, w, p["admin"])
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        key = api.execute("select pulse.agent_key_issue(%s,'runner') k", (aid,)).fetchone()["k"]
    job, token = _ai_job_token(api, w, p["admin"], runner_id, cred, aid)
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        # A work email any colleague sees, and a phone only HR and admins see.
        owner.execute("update pulse.people_profile set email=%s, phone='+91 90000 00001' where person_id=%s", (f"synthetic.person@{w.domain}", p["person"]))
        owner.execute("""insert into pulse.attendance_entry(org_id,person_id,work_date,mode,checked_in_at,client)
          values(%s,%s,(now() at time zone 'Asia/Kolkata')::date,'office',now()-interval '30 minutes','{"via":"web","trigger":"manual"}')""", (w.org, p["person"]))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_KEY": key, "TEST_JOB_TOKEN": token, "TEST_PERSON": str(p["person"]),
           "TEST_EMAIL": f"synthetic.person@{w.domain}", "TEST_AGENT": str(aid)}
    result = subprocess.run(["node", "test/ai-tools-fix-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                            env=env, capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, (result.stdout + result.stderr)[-6000:]
    # The call log names the job token's calls as an AI employee's (they were "no token, no principal" 403s before).
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        kinds = owner.execute("""select c.principal_kind k, c.status s, count(*) n from pulse_priv.v1_call c
            join pulse_priv.runner_mcp_token t on t.id=c.token_id where t.job_id=%s group by 1,2""", (job,)).fetchall()
        assert kinds and all(r["k"] == "ai" for r in kinds), kinds
        assert any(r["s"] == 200 for r in kinds), kinds
