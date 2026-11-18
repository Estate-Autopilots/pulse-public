"""SERVERS-AI (migration 1560): Pulse Runner, "Connect a server" (docs/runner/PROTOCOL.md).

The protocol end to end through the API (services/api/test/runner-runner.mjs), and in the database: another
organisation never sees a server, job, event, code or token; a pairing code works once and only for ten minutes; a
revoked credential is refused (as 'revoked', which the API answers 401 runner_revoked); a job's MCP token ends with it.
"""
import hashlib
import json
import os
import secrets
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def _sha(x: str) -> str:
    return hashlib.sha256(x.encode()).hexdigest()


def _people(worker, w, roles, domain):
    ids = {r: uuid.uuid4() for r in roles}
    with worker.transaction():
        set_tenant(worker, w.org)
        for role, pid in ids.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, f"Synthetic runner {role}"))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,%s,'Pod 1','{}')", (w.org, pid, role))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, f"{role}@{domain}", pid))
            if role in ("admin", "hr", "leadership"):
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, pid, role))
    return ids


def _paired(api, w, admin_id, hostname="box"):
    """A code made by the organisation's admin, then paired (no organisation set, as the API does): runner id and credential."""
    code = f"{secrets.token_hex(2).upper()}-{secrets.token_hex(2).upper()}"
    with api.transaction():
        set_tenant(api, w.org, admin_id)
        api.execute("select pulse.runner_pair_code_create(%s)", (_sha("runner-code:" + code),))
    credential = "prc_" + secrets.token_urlsafe(32)[:43]
    with api.transaction():
        d = api.execute("select pulse.runner_pair(%s,%s,%s,'linux','x64','0.1.0') d", (_sha("runner-code:" + code), _sha(credential), hostname)).fetchone()["d"]
    assert d["status"] == "ok" and d["orgId"] == str(w.org)
    return d["runnerId"], credential, code


def _job(api, w, admin_id, runner_id, kind="claude"):
    job_id = "job_" + uuid.uuid4().hex
    with api.transaction():
        set_tenant(api, w.org, admin_id)
        if kind == "claude":
            api.execute("""insert into pulse.runner_job(org_id,id,runner_id,kind,prompt,time_limit_sec,cost_cap_usd,requested_by)
                           values(%s,%s,%s,'claude','Synthetic prompt',600,1,%s)""", (w.org, job_id, runner_id, admin_id))
        else:
            api.execute("""insert into pulse.runner_job(org_id,id,runner_id,kind,command,time_limit_sec,requested_by)
                           values(%s,%s,%s,'shell-safe',array['uptime'],60,%s)""", (w.org, job_id, runner_id, admin_id))
    return job_id


def test_runner_protocol_api(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    roles = _people(worker, w, ["person", "hr", "leadership", "admin"], "runners.example")
    config = conninfo_to_dict(dsn("api")); config["database"] = config.pop("dbname")
    wc = conninfo_to_dict(dsn("migrate")); wc["database"] = wc.pop("dbname")
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_OWNER_CONFIG": json.dumps(wc), "PULSE_ORG_ID": str(w.org),
           "TEST_ROLES": json.dumps({r: str(p) for r, p in roles.items()}), "TEST_REPORT": str(tmp_path / "runner.json")}
    env.pop("PULSE_RUNNER_MCP_URL", None)
    result = subprocess.run(["node", "test/runner-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                            text=True, capture_output=True, timeout=300)
    assert result.returncode == 0, result.stdout[-4000:] + "\n" + result.stderr[-4000:]
    assert json.loads((tmp_path / "runner.json").read_text())["checks"] >= 90


def test_other_org_cannot_see_runners_or_jobs(worker, owner, api):
    a, b = build_world(worker, owner, api), build_world(worker, owner, api)
    pa = _people(worker, a, ["admin", "person"], f"{a.code.lower()}.example")
    pb = _people(worker, b, ["admin"], f"{b.code.lower()}.example")
    runner_a, cred_a, _ = _paired(api, a, pa["admin"])
    job_a = _job(api, a, pa["admin"], runner_a)
    with api.transaction():                                   # A's server writes an event as itself
        assert api.execute("select pulse.runner_session(%s) s", (_sha(cred_a),)).fetchone()["s"]["status"] == "ok"
        api.execute("insert into pulse.runner_job_event(org_id,job_id,runner_id,seq,type,data) values(pulse.current_org(),%s,%s,1,'log','{}')", (job_a, runner_a))
    tables = ("pulse.runner", "pulse.runner_job", "pulse.runner_job_event")
    with api.transaction():                                   # A's admin sees A's
        set_tenant(api, a.org, pa["admin"])
        assert [api.execute(f"select count(*) n from {t}").fetchone()["n"] for t in tables] == [1, 1, 1]
        assert api.execute("select pulse.runner_pair_code_live() p").fetchone()["p"]["waiting"] == 0
    with api.transaction():                                   # B's admin, in B: nothing of A's
        set_tenant(api, b.org, pb["admin"])
        assert [api.execute(f"select count(*) n from {t} where true or org_id = %s", (a.org,)).fetchone()["n"] for t in tables] == [0, 0, 0]
    for viewer in (pb["admin"], pa["person"]):               # in A: B's admin is nobody there; A's member is not an admin
        with api.transaction():
            set_tenant(api, a.org, viewer)
            assert [api.execute(f"select count(*) n from {t}").fetchone()["n"] for t in tables] == [0, 0, 0]
            assert api.execute("select pulse.runner_pair_code_live() p").fetchone()["p"] is None
    with pytest.raises(psycopg.errors.NoDataFound), api.transaction():
        set_tenant(api, b.org, pb["admin"])
        api.execute("select pulse.runner_end(%s,'revoked')", (runner_a,))
    # RUNNERS-FULL (1589): the job-stamp trigger looks the server up in B first and refuses with "No such server", the
    # same answer as for a server that does not exist; the foreign key and policy still stand behind it.
    with pytest.raises((psycopg.errors.NoDataFound, psycopg.errors.ForeignKeyViolation, psycopg.errors.InsufficientPrivilege)), api.transaction():
        set_tenant(api, b.org, pb["admin"])
        api.execute("""insert into pulse.runner_job(org_id,id,runner_id,kind,command,time_limit_sec,requested_by)
                       values(%s,%s,%s,'shell-safe',array['uptime'],60,%s)""", (b.org, "job_" + uuid.uuid4().hex, runner_a, pb["admin"]))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():   # a member cannot make codes
        set_tenant(api, a.org, pa["person"])
        api.execute("select pulse.runner_pair_code_create(%s)", (_sha("x"),))
    for t in ("pulse_priv.runner_pair_code", "pulse_priv.runner_credential", "pulse_priv.runner_mcp_token"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():   # no runtime grants at all
            set_tenant(api, a.org, pa["admin"])
            api.execute(f"select count(*) from {t}")
    with api.transaction():                                   # A's server, inside A, sees only its own rows
        api.execute("select pulse.runner_session(%s)", (_sha(cred_a),))
        assert api.execute("select count(*) n from pulse.runner_job").fetchone()["n"] == 1
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with api.transaction():
                api.execute("""insert into pulse.runner_job(org_id,id,runner_id,kind,command,time_limit_sec,requested_by)
                               values(pulse.current_org(),%s,%s,'shell-safe',array['uptime'],60,%s)""", ("job_" + uuid.uuid4().hex, runner_a, pa["admin"]))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():   # a session never hops out of an organisation
        set_tenant(api, b.org)
        api.execute("select pulse.runner_session(%s)", (_sha(cred_a),))


def test_pairing_code_single_use_and_expiring(worker, owner, api):
    w = build_world(worker, owner, api)
    p = _people(worker, w, ["admin"], f"{w.code.lower()}.example")
    _, _, code = _paired(api, w, p["admin"])
    pair = lambda c: api.execute("select pulse.runner_pair(%s,%s,'h','linux','x64','0.1.0') d", (_sha("runner-code:" + c), _sha(secrets.token_hex(8)))).fetchone()["d"]
    with api.transaction():
        assert pair(code)["status"] == "used"
    with api.transaction():
        assert pair("ZZZZ-9999")["status"] == "invalid"
    late = f"{secrets.token_hex(2).upper()}-{secrets.token_hex(2).upper()}"
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        expires = api.execute("select pulse.runner_pair_code_create(%s) u", (_sha("runner-code:" + late),)).fetchone()["u"]
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        assert owner.execute("select extract(epoch from expires_at-created_at)::int s from pulse_priv.runner_pair_code where code_hash=%s",
                             (_sha("runner-code:" + late),)).fetchone()["s"] == 600
        owner.execute("update pulse_priv.runner_pair_code set expires_at=now()-interval '1 second' where code_hash=%s", (_sha("runner-code:" + late),))
    assert expires is not None
    with api.transaction():
        assert pair(late)["status"] == "expired"
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():   # pairing names the organisation, never hops
        set_tenant(api, w.org)
        pair(late)
    with api.transaction():                                   # five waiting codes at most (the used and expired ones do not count)
        set_tenant(api, w.org, p["admin"])
        for _ in range(5):
            api.execute("select pulse.runner_pair_code_create(%s)", (_sha(f"runner-code:{uuid.uuid4()}"),))
        with pytest.raises(psycopg.errors.ProgramLimitExceeded):
            with api.transaction():
                api.execute("select pulse.runner_pair_code_create(%s)", (_sha(f"runner-code:{uuid.uuid4()}"),))


def test_revoked_credential_refused_and_tokens_end(worker, owner, api):
    w = build_world(worker, owner, api)
    p = _people(worker, w, ["admin"], f"{w.code.lower()}.example")
    runner_id, cred, _ = _paired(api, w, p["admin"])
    job_id = _job(api, w, p["admin"], runner_id)
    token = "pmt_" + secrets.token_urlsafe(32)[:43]
    with api.transaction():
        assert api.execute("select pulse.runner_session(%s) s", (_sha(cred),)).fetchone()["s"] == {"status": "ok", "runnerId": runner_id, "orgId": str(w.org)}
        api.execute("update pulse.runner_job set status='delivered',delivered_at=now() where id=%s", (job_id,))
        api.execute("select pulse.runner_mcp_issue(%s,%s)", (job_id, _sha(token)))
    principal = lambda scope: api.execute("select pulse.v1_runner_principal(%s,%s) v", (_sha(token), scope)).fetchone()["v"]
    with api.transaction():
        assert api.execute("select org_id from pulse.runner_mcp_token_org(%s)", (_sha(token),)).fetchone()["org_id"] == w.org
    with api.transaction():
        set_tenant(api, w.org)
        assert principal("tasks.read") is not None
        assert api.execute("select current_setting('pulse.viewer_id') v").fetchone()["v"] == str(p["admin"])
    with api.transaction():
        set_tenant(api, w.org)
        assert principal("tasks.write") is None
    with api.transaction():
        assert api.execute("select pulse.runner_session(%s) s", (_sha("prc_unknown"),)).fetchone()["s"] == {"status": "unknown"}
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        assert api.execute("select pulse.runner_end(%s,'revoked') ok", (runner_id,)).fetchone()["ok"] is True
        assert api.execute("select status,error_code from pulse.runner_job where id=%s", (job_id,)).fetchone() == {"status": "cancelled", "error_code": "runner_revoked"}
    with api.transaction():
        assert api.execute("select pulse.runner_session(%s) s", (_sha(cred),)).fetchone()["s"] == {"status": "revoked"}
        assert api.execute("select coalesce(current_setting('pulse.org_id',true),'') o, coalesce(current_setting('pulse.runner_id',true),'') r").fetchone() == {"o": "", "r": ""}
    with api.transaction():
        set_tenant(api, w.org)
        assert principal("tasks.read") is None
    with api.transaction():
        assert api.execute("select count(*) n from pulse.runner_mcp_token_org(%s)", (_sha(token),)).fetchone()["n"] == 0
