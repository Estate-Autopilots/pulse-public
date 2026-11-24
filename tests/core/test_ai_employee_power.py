"""AI-EMPLOYEE-POWER (migration 1681): an access tier per AI employee per server, direct shell jobs, root with guardrails.

In the database: an AI employee's tier is the default (read-only on a read-only server, sandboxed otherwise) until an
admin sets it; root only by the organisation owner (its first admin) or a superadmin, typed GRANT ROOT, on a server that
lets AI employees in; a root job needs that grant (as a shell job); a read-only tier writes nothing; "Revoke all root"
removes every grant and stops root jobs; the root audit is for admins and lists each root command; another company sees
nothing.
"""
import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant

from test_runners import _paired, _people
from test_runner_access import _agent, _as_agent

START = "select pulse.runner_server_job_start(%s,%s,%s,%s,%s,%s,%s,%s) j"
SET = "select pulse.agent_server_tier_set(%s,%s,%s,%s,%s,%s) s"


def _first_admin(api, w, admin):
    with api.transaction():
        set_tenant(api, w.org, admin)
        return api.execute("""select ra.person_id from pulse.role_assignment ra join pulse.person p on p.id = ra.person_id
             and p.side = 'staff' and p.status = 'active' where ra.org_id = pulse.current_org() and ra.role_key = 'admin'
             and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity') order by ra.valid_from, ra.id limit 1""").fetchone()["person_id"]


def test_tiers_root_grant_and_root_jobs(worker, owner, api):
    w = build_world(worker, owner, api)
    p = _people(worker, w, ["admin", "person"], f"{w.code.lower()}.example")
    p2 = _people(worker, w, ["admin"], f"b.{w.code.lower()}.example")
    runner_id, _, _ = _paired(api, w, p["admin"])
    aid = _agent(owner, w, p["admin"])
    first = _first_admin(api, w, p["admin"])
    other = next(x for x in (p["admin"], p2["admin"]) if x != first)
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        api.execute("select pulse.runner_access_set(%s,'read-write',true,true,'Synthetic: owner approved')", (runner_id,))
    with api.transaction():
        _as_agent(api, w, aid)
        s = api.execute("select pulse.runner_server_list() s").fetchone()["s"][0]
        assert (s["tier"], s["mayUse"], s["directShell"], s["rootShell"]) == ("sandboxed", True, False, False), "the default on a read-write server"
        job = api.execute(START, (runner_id, "shell", None, ["ls -la /var/log | head"], "write", 120, None, p["person"])).fetchone()["j"]
        assert job["kind"] == "shell" and job["tier"] == "sandboxed"
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="do not have root"), api.transaction():
            api.execute(START, (runner_id, "shell", None, ["id"], "root", 60, None, None))
    with api.transaction():     # the stored shell job: one command line, no prompt, no cost cap
        set_tenant(api, w.org, p["admin"])
        row = api.execute("select kind,command,prompt,cost_cap_usd,profile,approval from pulse.runner_job where id=%s", (job["id"],)).fetchone()
        assert (row["kind"], row["command"], row["prompt"], row["cost_cap_usd"], row["profile"]) == ("shell", ["ls -la /var/log | head"], None, None, "write")
        assert row["approval"]["standing"] is True
        # read-only tier: no write work
        assert api.execute(SET, (aid, runner_id, "read-only", None, None, "Synthetic")).fetchone()["s"]["tier"] == "read-only"
    with api.transaction():
        _as_agent(api, w, aid)
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="only read"), api.transaction():
            api.execute(START, (runner_id, "shell", None, ["touch x"], "write", 60, None, None))
        api.execute(START, (runner_id, "shell", None, ["cat /etc/os-release"], "read-only", 60, None, None))
    # Root: not by another admin, not without the typed confirm, then by the owner.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="owner"), api.transaction():
        set_tenant(api, w.org, other)
        api.execute(SET, (aid, runner_id, "root", 900, "GRANT ROOT", None))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="GRANT ROOT"), api.transaction():
        set_tenant(api, w.org, first)
        api.execute(SET, (aid, runner_id, "root", 900, "yes", None))
    with api.transaction():
        set_tenant(api, w.org, first)
        g = api.execute(SET, (aid, runner_id, "root", 900, "GRANT ROOT", "Synthetic: owner asked")).fetchone()["s"]
        assert (g["tier"], g["timeLimitSec"], g["explicit"]) == ("root", 900, True)
        assert api.execute("select pulse.org_owner_or_superadmin() o").fetchone()["o"] is True
    with api.transaction():
        _as_agent(api, w, aid)
        rj = api.execute(START, (runner_id, "shell", None, ["apt-get -y install jq"], "root", None, None, p["person"])).fetchone()["j"]
        assert (rj["profile"], rj["tier"]) == ("root", "root")
        with pytest.raises(psycopg.errors.InvalidParameterValue, match="shell commands only"), api.transaction():
            api.execute(START, (runner_id, "claude", "Synthetic", None, "root", 60, 1, None))
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            api.execute("select pulse.runner_root_audit(10)")
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        r = api.execute("select time_limit_sec,sandbox,approval from pulse.runner_job where id=%s", (rj["id"],)).fetchone()
        assert (r["time_limit_sec"], r["sandbox"], r["approval"]["tier"]) == (900, False, "root"), "the tier's limit; outside the sandbox"
        audit = api.execute("select pulse.runner_root_audit(10) a").fetchone()["a"]
        assert [i["command"] for i in audit["items"]] == ["apt-get -y install jq"] and len(audit["grants"]) == 1
        assert [x["toTier"] for x in audit["log"]][:2] == ["root", "read-only"]
        out = api.execute("select pulse.agent_root_revoke_all('Synthetic kill switch') o").fetchone()["o"]
        assert out == {"revoked": 1, "cancelledJobs": 1}
        assert api.execute("select status from pulse.runner_job where id=%s", (rj["id"],)).fetchone()["status"] == "cancelled"
    with api.transaction():
        _as_agent(api, w, aid)
        assert api.execute("select pulse.runner_server_list() s").fetchone()["s"][0]["tier"] == "sandboxed", "back to the default"
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="do not have root"), api.transaction():
            api.execute(START, (runner_id, "shell", None, ["id"], "root", 60, None, None))
    # AI employees off for the server: no tier at all, and no root grant.
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        api.execute("select pulse.runner_access_set(%s,'read-write',true,false,'Synthetic: AI off')", (runner_id,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="AI employees are off"), api.transaction():
        set_tenant(api, w.org, first)
        api.execute(SET, (aid, runner_id, "root", 600, "GRANT ROOT", None))
    with api.transaction():
        _as_agent(api, w, aid)
        assert api.execute("select pulse.runner_server_list() s").fetchone()["s"][0]["tier"] == "none"


def test_people_and_other_companies(worker, owner, api):
    w, other = build_world(worker, owner, api), build_world(worker, owner, api)
    p = _people(worker, w, ["admin", "person"], f"{w.code.lower()}.example")
    q = _people(worker, other, ["admin"], f"{other.code.lower()}.example")
    runner_id, _, _ = _paired(api, w, p["admin"])
    aid = _agent(owner, w, p["admin"])
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, p["person"])
        api.execute(SET, (aid, runner_id, "sandboxed", None, None, None))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, p["person"])
        api.execute("select pulse.agent_root_revoke_all(null)")
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, p["admin"])
        api.execute(START, (runner_id, "shell", None, ["id"], "root", 60, None, None))
    with api.transaction():
        set_tenant(api, other.org, q["admin"])
        with pytest.raises(psycopg.errors.InvalidParameterValue, match="Choose an AI employee"), api.transaction():
            api.execute(SET, (aid, runner_id, "sandboxed", None, None, None))
        assert api.execute("select pulse.runner_root_audit(10) a").fetchone()["a"] == {"items": [], "grants": [], "log": []}
