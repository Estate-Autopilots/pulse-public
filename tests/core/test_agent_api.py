"""AGENT-API (owner, 4 Nov 2026: "the strongest possible API, MCP and CLI"): the work and money operations of API v1 and
their MCP tools on real tenant RLS (services/api/test/agent-api-runner.mjs), with personal tokens and a bot key for a
synthetic AI member (Willow Lane's Bhrata, synthetic here), a second organisation for isolation, and the audit receipts
and undo ledger read back as the owner. Synthetic people, clients and figures only."""
import hashlib
import json
import os
import secrets
import subprocess
import uuid
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_agent_coworkers import make_agent
from test_erp_invoice import _seed_erp_world, erp, one  # noqa: F401  (erp is a fixture)


def test_agent_api_end_to_end(worker, owner, api, erp):  # noqa: F811
    w = erp
    _seed_erp_world(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        # The admin who makes the AI member and its bot key.
        worker.execute("""insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) select %s,%s,'admin','2026-01-01'
            where not exists(select 1 from pulse.role_assignment where person_id=%s and role_key='admin')""", (w.org, w.manager, w.manager))
    agent, _key = make_agent(api, w, "bhrata-synthetic")
    other = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"admin@{w.domain}", w.manager))
    with owner.transaction():
        set_tenant(owner, w.org)
        # Bhrata drafts quotations: its AI member has the Billing and Tasks tools on (an admin's choice on its profile).
        # It makes and changes tasks as itself, so it has Operations access (Pulse's rule for AI members, agent_acts).
        owner.execute("update pulse.agent_member set tools=array(select distinct unnest(tools||'{billing,tasks}'::text[])),access='operations' where person_id=%s", (agent,))
        # Willow Lane keeps stock with serial numbers: inventory is on in this synthetic company.
        owner.execute("update pulse.erp_settings set inventory_enabled=true where org_id=%s", (w.org,))
    with owner.transaction():
        set_tenant(owner, other.org)
        owner.execute("insert into pulse.org_domain(org_id,host,sign_in,added_by) values(%s,'agent-api-other.example','password','synthetic')", (other.org,))
    # Org B's person has the Finance role there, so the isolation checks are not just a missing role (review, 5 Nov 2026).
    with worker.transaction():
        set_tenant(worker, other.org)
        worker.execute("""insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) select %s,%s,'finance','2026-01-01'
            where not exists(select 1 from pulse.role_assignment where person_id=%s and role_key='finance')""", (other.org, other.manager, other.manager))
    # A client with an open project and a members-only one nobody synthetic is on, for what a member's token may read.
    private_client, open_project, secret_project = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Synthetic Private Client')", (private_client, w.org))
        owner.execute("""insert into pulse.project(id,org_id,registry_no,name,title,client_id,visibility) values
            (%s,%s,9151,'Synthetic open rooftop','Synthetic open rooftop',%s,'org'),(%s,%s,9152,'Synthetic secret rooftop','Synthetic secret rooftop',%s,'members')""",
            (open_project, w.org, private_client, secret_project, w.org, private_client))
    # A personal token in the other organisation, made as its admin there.
    other_token = "ppt_" + secrets.token_urlsafe(32)[:43]
    with api.transaction():
        set_tenant(api, other.org, other.manager)
        api.execute("select pulse.api_token_issue('personal','Other org script',%s,30,null,%s)",
                    (["tasks.read", "tasks.write", "projects.read", "people.read", "billing.read", "companies.read"], hashlib.sha256(other_token.encode()).hexdigest()))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "PULSE_PUBLIC_URL": "https://pulse.synthetic.example", "TEST_API_CONFIG": json.dumps(config),
           "TEST_W": json.dumps({"org": str(w.org), "agent": str(agent), "finance": str(w.finance), "founder": str(w.founder), "member": str(w.member),
                                 "financeEmail": f"finance@{w.domain}", "founderEmail": f"founder@{w.domain}", "memberEmail": f"member@{w.domain}", "adminEmail": f"admin@{w.domain}",
                                 "otherToken": other_token, "otherPerson": str(other.manager), "otherHost": "agent-api-other.example",
                                 "privateClient": str(private_client), "openProject": str(open_project), "secretProject": str(secret_project)})}
    # PULSE_AUTH_BROWSER=1 (with a built web app, NEXT_DIST_DIR) also drives Settings → API keys, /oauth/device and
    # /developers in Chromium at 390 and 1440 px; PULSE_AGENT_API_SCREENSHOTS=<dir> keeps the screens.
    p = subprocess.run(["node", "test/agent-api-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=600, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-8000:]
    out = json.loads([line for line in p.stdout.splitlines() if line.startswith('{"ok"')][-1])
    assert out["checks"] >= 120, out
    if os.environ.get("PULSE_AUTH_BROWSER") == "1":
        assert out["browserChecks"] >= 20, out
    assert other_token not in p.stdout + p.stderr, "a token never reaches the logs"
    with owner.transaction():
        set_tenant(owner, w.org)
        # Audit: one receipt per call, each as its own token's principal; the bot's calls are its AI member's.
        kinds = {r["principal_kind"]: r["n"] for r in owner.execute("""select principal_kind,count(*) n from pulse_priv.v1_call where org_id=%s and operation_id in
            ('createQuotation','approveQuotation','findOrCreateClient','createTask') group by 1""", (w.org,)).fetchall()}
        assert kinds.get("ai", 0) >= 4 and kinds.get("person", 0) >= 2, kinds
        bot_calls = owner.execute("select count(*) n from pulse_priv.v1_call where org_id=%s and principal_id=%s and status=403 and operation_id='approveQuotation'", (w.org, agent)).fetchone()["n"]
        assert bot_calls >= 1, "the bot's refused approval is on record"
        apps = {r["app"] for r in owner.execute("select distinct app from pulse_priv.app_change where org_id=%s", (w.org,)).fetchall()}
        assert {"Bhrata (synthetic) (bot key)", "Finance scripts (personal token)", "Member tasks (personal token)"} <= apps, apps
        stored = owner.execute("select token_sha256 from pulse_priv.api_token where org_id=%s", (w.org,)).fetchall()
        assert stored and all(len(r["token_sha256"]) == 64 for r in stored), "only digests are stored"
        assert owner.execute("select count(*) n from pulse_priv.v1_call where org_id=%s and token_id in (select id from pulse_priv.api_token where org_id<>%s)", (w.org, w.org)).fetchone()["n"] == 0
    with owner.transaction():
        set_tenant(owner, other.org)
        assert owner.execute("select count(*) n from pulse_priv.v1_call where org_id=%s", (other.org,)).fetchone()["n"] >= 5
