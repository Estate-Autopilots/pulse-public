"""AI-EMPLOYEE-POWER hotfix (migration 1621): run_on_server's whole database path as an AI employee.

The runOnServer handler (services/api/src/v1-servers.ts) starts the job and then records it in the change ledger as
'server.job' with the job's uuid (its id's hex). Both steps run in one transaction; either refusing rolls the job back
and API v1 answers a bare 400 (production, 6 Nov: first 22P02 on the subject, then 23514 on the action). This walks
the same two calls, in the same order, with the same arguments.
"""
from helpers import build_world
from pulse_sdk.db import set_tenant

from test_runners import _paired, _people
from test_runner_access import _agent, _as_agent

START = "select pulse.runner_server_job_start(%s,%s,%s,%s,%s,%s,%s,%s) j"


def _job_uuid(job_id):
    h = job_id[4:]
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def test_an_ai_employee_job_is_recorded_in_the_change_ledger(worker, owner, api):
    w = build_world(worker, owner, api)
    p = _people(worker, w, ["admin", "person"], f"{w.code.lower()}.example")
    runner_id, _, _ = _paired(api, w, p["admin"])
    aid = _agent(owner, w, p["admin"])
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        api.execute("select pulse.runner_access_set(%s,'read-write',true,true,'Synthetic: AI employees allowed')", (runner_id,))
    with api.transaction():
        _as_agent(api, w, aid)
        job = api.execute(START, (runner_id, "shell-safe", None, ["uname", "-a"], "read-only", 60, 2, None)).fetchone()["j"]
        change = api.execute("select pulse.app_change_add('server.job', %s::uuid, %s::jsonb) c",
                             (_job_uuid(job["id"]), '{"job": "%s", "server": "synthetic-box", "kind": "shell-safe", "profile": "read-only"}' % job["id"])).fetchone()["c"]
        assert change, "the ledger takes the job"
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        assert api.execute("select status from pulse.runner_job where id=%s", (job["id"],)).fetchone()["status"] == "queued", "the job stays queued"
