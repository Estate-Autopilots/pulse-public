"""WL-QUOTE-LIVE suite (10 Nov 2026): Bharata on a synthetic copy of Willow Lane, brute-forced with scripted salesperson
conversations in Hindi, Marathi and English, typed and spoken (TTS audio as chat voice notes, heard by the server's own
Whisper), each scored on client, items, prices, total, GST, approval and PDF (services/api/test/wl-quote-live-suite.mjs).
Only with PULSE_WLQ_LIVE=1: it spends real model tokens. Results in PULSE_WLQ_OUT. Every person, client, product and
price is invented; nothing is sent to anyone."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest
from conftest import MODE, dsn, role_url
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_agent_channels import settings
from test_agent_coworkers import lead, make_agent, owner_sql
from test_agent_ui_browser import install_org
from test_hr_suite import ADMIN
from test_tasks_rt1 import team  # noqa: F401  (a fixture)

SUITE = json.loads((Path(__file__).parent / "wl_quote_live_scenarios.json").read_text())


def salespeople(worker, w, n):
    """n synthetic salespeople who sign in (one conversation each, so no conversation reads another's)."""
    out = []
    with worker.transaction():
        set_tenant(worker, w.org)
        for i in range(n):
            pid, email = uuid.uuid4(), f"sales{i + 1}@wl-quote-live.example.test"
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, f"TEST Sales {i + 1} WL"))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,user_no,username) values(%s,%s,'Sales','test',%s,%s)", (w.org, pid, 500 + i, f"wlsales{i + 1}"))
            worker.execute("insert into pulse.account(id,org_id,provider,handle,holder_person_id,purpose) values(%s,%s,'google',%s,%s,'Workspace account')", (uuid.uuid4(), w.org, email, pid))
            out.append({"id": str(pid), "email": email})
    return out


@pytest.mark.skipif(os.environ.get("PULSE_WLQ_LIVE") != "1", reason="spends real model tokens: run with PULSE_WLQ_LIVE=1")
def test_bharata_quotes_from_chat_and_voice(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team  # the team fixture already signs the admin (ADMIN) in as w.manager
    lead(worker, w, w.manager)  # the owner approves quotations (leadership), as Akabod does
    settings(api, w, w.manager, {"listenOn": True, "listenRetentionDays": 30})  # Listen scenarios (on by default since 1951)
    with worker.transaction():
        set_tenant(worker, w.org)
        if not worker.execute("select 1 from pulse.role_assignment where person_id=%s and role_key='admin'", (w.manager,)).fetchone():
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values (%s,%s,'admin','2026-01-01')", (w.org, w.manager))
    owner_sql(owner, w, "update pulse.person set display_name='TEST Owner WL' where id=%s", (w.manager,))
    copies = int(os.environ.get("PULSE_WLQ_COPIES", "3"))
    agents = []
    for k in range(copies):
        username = f"bharata-{k + 1}"
        agent, key = make_agent(api, w, username)
        owner_sql(owner, w, "update pulse.agent_member set tools=%s, access='operations', daily_token_budget=2000000, instructions=%s, title=%s, provider=%s where org_id=%s and person_id=%s",
                  (["billing", "chats", "tasks", "memory"], SUITE["instructions"], "Quotations for the owner (synthetic Willow Lane)", os.environ.get("PULSE_WLQ_PROVIDER", "codex"), w.org, agent))
        owner_sql(owner, w, "update pulse.person set display_name=%s where id=%s", (f"Bharata {k + 1}", agent))
        keyfile = tmp_path / f"{username}.key"
        keyfile.write_text(key)
        keyfile.chmod(0o600)
        agents.append({"id": str(agent), "username": username, "keyFile": str(keyfile)})
    sales = salespeople(worker, w, len(SUITE["scenarios"]) + 8)
    was = install_org(owner, w.org)
    # The owner reads what each conversation left (as the migration role, the owner fixture's own login).
    url = lambda role: role_url("migrate") if role == "owner" and MODE["value"] == "superuser" else dsn(role)
    conf = lambda role: {**(d := conninfo_to_dict(url(role))), "database": d.pop("dbname")}
    out = Path(os.environ.get("PULSE_WLQ_OUT", tmp_path))
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(conf("api")), "TEST_OWNER_CONFIG": json.dumps(conf("owner")),
           "TEST_WORKER_DSN": dsn("worker"), "TEST_ORG": str(w.org), "TEST_ADMIN_EMAIL": ADMIN, "TEST_ADMIN_ID": str(w.manager),
           "TEST_SALES": json.dumps(sales), "TEST_AGENTS": json.dumps(agents), "PULSE_WLQ_OUT": str(out)}
    try:
        p = subprocess.run(["node", "test/wl-quote-live-suite.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                           capture_output=True, text=True, timeout=int(os.environ.get("PULSE_WLQ_TIMEOUT", "10800")), check=False)
    finally:
        if was:
            install_org(owner, was)
    (out / "suite-runner.log").write_text(p.stdout[-60000:] + "\n---\n" + p.stderr[-20000:])
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    assert json.loads((out / "runs.json").read_text())
