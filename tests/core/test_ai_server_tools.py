"""AI-SERVER-TOOLS (migration 1590): AI employees on the company's servers through API v1, all areas by default.

In the database: an AI employee lists every server of its company and runs work only where "AI employees may use this
server" is on, up to the level (write and full with the standing approval of the admin who set it), unless its managers
asked to be asked first; every job keeps whom it was for; a person runs jobs only as an organisation admin; jobs of
another company are never seen; a paused company's AI employees reach nothing; areas narrow per AI employee.
"""
import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant

from test_runners import _paired, _people
from test_runner_access import _agent, _as_agent

START = "select pulse.runner_server_job_start(%s,%s,%s,%s,%s,%s,%s,%s) j"


def test_ai_employee_runs_on_allowed_servers_up_to_the_level(worker, owner, api):
    w = build_world(worker, owner, api)
    p = _people(worker, w, ["admin", "person"], f"{w.code.lower()}.example")
    runner_id, _, _ = _paired(api, w, p["admin"])
    aid = _agent(owner, w, p["admin"])
    with api.transaction():
        _as_agent(api, w, aid)
        listed = api.execute("select pulse.runner_server_list() s").fetchone()["s"]
        assert [(s["id"], s["mayUse"], s["accessLevel"]) for s in listed] == [(runner_id, False, "read-only")], "it sees the server, not yet usable"
        name = listed[0]["name"]
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="may use this server"), api.transaction():
            api.execute(START, (runner_id, "shell-safe", None, ["uname", "-a"], "read-only", 60, None, p["person"]))
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        api.execute("select pulse.runner_access_set(%s,'read-write',true,true,'Synthetic: owner approved')", (runner_id,))
    with api.transaction():
        _as_agent(api, w, aid)
        job = api.execute(START, (name, "shell-safe", None, ["uname", "-a"], "read-only", 60, None, p["person"])).fetchone()["j"]
        assert job["status"] == "queued" and job["serverId"] == runner_id, "by name too"
        wjob = api.execute(START, (runner_id, "claude", "Synthetic write task", None, "write", 600, 1, None)).fetchone()["j"]
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="allows read-write work only"):
            with api.transaction():
                api.execute(START, (runner_id, "claude", "Synthetic shell task", None, "shell", 600, 1, None))
        read = api.execute("select pulse.runner_server_job_read(%s,20) j", (job["id"],)).fetchone()["j"]
        assert read["status"] == "queued" and read["requestedFor"] and read["link"].endswith(job["id"])
    with api.transaction():     # as the admin: who asked, for whom, and the standing approval of write work
        set_tenant(api, w.org, p["admin"])
        row = api.execute("select requested_by,requested_for,requested_by_type,approval,prompt,command from pulse.runner_job where id=%s", (job["id"],)).fetchone()
        assert (row["requested_by"], row["requested_for"], row["requested_by_type"], row["approval"], row["prompt"], row["command"]) ==             (aid, p["person"], "ai-employee", None, None, ["uname", "-a"])
        appr = api.execute("select approval from pulse.runner_job where id=%s", (wjob["id"],)).fetchone()["approval"]
        assert appr["standing"] is True and appr["approvedBy"]["id"] == str(p["admin"]), "write carries the admin's standing approval"
    # Its managers ask to be asked first: write work is refused, read work still runs.
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        assert api.execute("select pulse.agent_access_set(%s,null,true) a", (aid,)).fetchone()["a"]["serverWritesAsk"] is True
    with api.transaction():
        _as_agent(api, w, aid)
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="approves your write work"):
            with api.transaction():
                api.execute(START, (runner_id, "claude", "Synthetic write task", None, "write", 600, 1, None))
        api.execute(START, (runner_id, "claude", "Synthetic read task", None, "read-only", 600, 1, None))


def test_people_admins_only_and_companies_apart(worker, owner, api):
    w, other = build_world(worker, owner, api), build_world(worker, owner, api)
    p = _people(worker, w, ["admin", "person"], f"{w.code.lower()}.example")
    q = _people(worker, other, ["admin"], f"{other.code.lower()}.example")
    runner_id, _, _ = _paired(api, w, p["admin"])
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        job = api.execute(START, (runner_id, "shell-safe", None, ["df", "-h"], "read-only", 60, None, None)).fetchone()["j"]
        assert api.execute("select requested_for from pulse.runner_job where id=%s", (job["id"],)).fetchone()["requested_for"] == p["admin"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, p["person"])
        api.execute("select pulse.runner_server_list()")
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, p["person"])
        api.execute(START, (runner_id, "shell-safe", None, ["df"], "read-only", 60, None, None))
    with api.transaction():
        set_tenant(api, other.org, q["admin"])
        assert api.execute("select pulse.runner_server_list() s").fetchone()["s"] == []
        assert api.execute("select pulse.runner_server_job_read(%s,20) j", (job["id"],)).fetchone()["j"] is None
        with pytest.raises(psycopg.errors.NoDataFound), api.transaction():
            api.execute(START, (runner_id, "shell-safe", None, ["df"], "read-only", 60, None, None))


def test_pause_and_areas(worker, owner, api):
    w = build_world(worker, owner, api)
    p = _people(worker, w, ["admin", "person"], f"{w.code.lower()}.example")
    aid = _agent(owner, w, p["admin"])
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        out = api.execute("select pulse.agent_access_set(%s,array['tasks.read','billing.read'],null) a", (aid,)).fetchone()["a"]
        assert out["all"] is False and sorted(out["areas"]) == ["billing.read", "tasks.read"]
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            with api.transaction():
                api.execute("select pulse.agent_access_set(%s,array['root.write'],null)", (aid,))
        assert api.execute("select pulse.agent_access_set(%s,pulse.v1_scopes(),null) a", (aid,)).fetchone()["a"]["all"] is True
        assert api.execute("select pulse.agent_pause_set(true,'Synthetic pause') r").fetchone()["r"] == {"paused": True}
        assert api.execute("select pulse.agent_paused() p").fetchone()["p"] is True
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, p["person"])
        api.execute("select pulse.agent_pause_set(false,null)")
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, p["person"])
        api.execute("select pulse.agent_access_set(%s,null,null)", (aid,))
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        assert api.execute("select pulse.agent_pause_set(false,null) r").fetchone()["r"] == {"paused": False}
        assert api.execute("select pulse.agent_paused() p").fetchone()["p"] is False
