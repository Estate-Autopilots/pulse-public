"""WL-DOCS (18 Nov 2026; Willow Lane's owner: "quotation and all document creation is not working"): an AI employee with
its own key walks the selling paperwork over /api/v1/mcp on real PostgreSQL and row security
(services/api/test/wl-docs-runner.mjs): a quotation from words for a salesperson, submitted, approved by a person, read
back, sent, a proforma and an invoice drafted from it, a payment recorded, a doc written in the chat (shared there), a
message in a group and a task for a colleague; and the calls a model words loosely go through. Synthetic people,
products and prices only; nothing leaves the machine."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_agent_coworkers import agent_one, ask, claim, dispatch, make_agent
from test_erp_invoice import _seed_erp_world, erp  # noqa: F401  (erp is a fixture)
from test_runner_access import _agent
from test_tasks_rt1 import one, team  # noqa: F401  (team is a fixture)

CATALOGUE = [  # code, name, price (paise), gst
    ("TS-3.0", "TEST Sunbox 3.0 kW solar system", 9500000, 5), ("TS-5.0", "TEST Sunbox 5.0 kW solar system", 14000000, 5),
    ("AO-EXW7-5.0", "Extended warranty (+7 years) for TEST Sunbox 5.0", 1800000, 18), ("SV-INSTALL", "Installation & commissioning", 1250000, 18),
]


def _owner(owner, w, sql, args=()):
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        owner.execute(sql, args)


def test_an_ai_employee_walks_the_selling_paperwork(worker, owner, api, erp):  # noqa: F811
    w = erp
    _seed_erp_world(worker, w)   # Workspace accounts founder@ (leadership), finance@ and member@ the domain
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (w.org, w.founder))
        for code, name, price, gst in CATALOGUE:
            worker.execute("insert into pulse.erp_item(id,org_id,kind,code,name,price,gst_rate,status) values(%s,%s,'product',%s,%s,%s,%s,'active')",
                           (uuid.uuid4(), w.org, code, name, price, gst))
    aid = _agent(owner, w, w.founder)
    # As a client's AI employee is set up: operations access, its approver a leader, the billing and docs tools.
    _owner(owner, w, "update pulse.agent_member set access='operations', approver_person_id=%s, tools='{billing,chats,drive,memory,projects,tasks}' where person_id=%s", (w.founder, aid))
    group, stale = uuid.uuid4(), uuid.uuid4()
    _owner(owner, w, "insert into pulse.chat_channel(org_id,id,key,name,kind) values(%s,%s,%s,'Synthetic sales group','custom')", (w.org, group, f"group:{group}"))
    for m in (w.founder, w.member, aid):
        _owner(owner, w, "insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, group, m))
    # A team chat with a member the roster no longer puts there (the clean-up an AI's session may not run).
    _owner(owner, w, "insert into pulse.chat_channel(org_id,id,key,name,kind) values(%s,%s,'team:synthetic old team','Synthetic old team','team')", (w.org, stale))
    _owner(owner, w, "insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, stale, w.member))
    with api.transaction():
        set_tenant(api, w.org, w.founder)
        key = api.execute("select pulse.agent_key_issue(%s,'runner') k", (aid,)).fetchone()["k"]

    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    root = Path(__file__).resolve().parents[2]
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "PULSE_PUBLIC_URL": "https://pulse.synthetic.example", "TEST_API_CONFIG": json.dumps(config),
           "TEST_KEY": key, "TEST_W": json.dumps({"org": str(w.org), "founder": str(w.founder), "founderEmail": f"founder@{w.domain}", "member": str(w.member),
                                                  "memberEmail": f"member@{w.domain}", "agent": str(aid), "group": str(group)})}
    p = subprocess.run(["node", "test/wl-docs-runner.mjs"], cwd=root / "services/api", env=env, capture_output=True, text=True, timeout=300)
    if os.environ.get("WL_DOCS_EXPLORE"):
        Path(os.environ["WL_DOCS_EXPLORE"]).write_text(p.stdout + "\n--- stderr ---\n" + p.stderr[-4000:])
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    assert "wl-docs runner: ok" in p.stdout


def test_a_run_knows_who_wrote_the_message_so_the_screen_tools_reach_them(api, worker, owner, team):  # noqa: F811
    """2370: agent_dispatch's context carries message.authorId (a staff author). The runtime sends the screen tools, the
    "person you are answering" line and server jobs for that person; without it every screen tool an AI employee called
    fell back to the AI itself and was refused, so nothing it made was ever opened beside the chat."""
    w = team
    agent, _ = make_agent(api, w, "docs-agent")
    dm = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (agent,))["id"]
    asked = ask(api, w, w.manager, dm, "Make a site visit checklist and show it to me")
    [c] = claim(api, w, agent)
    d = dispatch(api, w, agent, c)
    msg = d["context"]["message"]
    assert d["status"] == "dispatched" and msg["id"] == str(asked)
    assert msg["authorId"] == str(w.manager), "the run knows who wrote (their person id), not only their name"
    # With that id the screen request is that person's (sent, or asked first at their level); without one it is the AI's
    # own id and Pulse refuses, as production did for every AI employee.
    target = "/docs/" + str(uuid.uuid4())
    r = agent_one(api, w, agent, "select pulse.agent_ui_request(%s,'panel.open',%s,'to show you the doc') r", (msg["authorId"], json.dumps({"target": target, "title": "Synthetic"})))["r"]
    assert r["state"] in ("sent", "asked") and r["action"] == "panel.open", r
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="only of a colleague you are helping"):
        agent_one(api, w, agent, "select pulse.agent_ui_request(null,'panel.open',%s,'to show you the doc') r", (json.dumps({"target": target}),))
