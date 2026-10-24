"""UX-TENANT (ADR-0032): a second company on the same Pulse, proven through the real API.

The install's company (EA's synthetic stand-in, with EAMARK names) sets up "ACMARK Closers" through the setup wizard's
routes: company and address, brand, first admin, people from a CSV, pods and roles, modules and rules, the isolation
check, open. AC's admin redeems a private set-password link at AC's own address and gives two people tasks on a new
project. Then every registered API route is called as AC (with EA's ids in the path) and as EA (with AC's ids): no
response may contain the other company's names or ids, and the other company's rows may not change. Sessions, the
Access header and device tokens are refused at the other company's address. Runner:
services/api/test/tenant-isolation-runner.mjs.

R51 adds: AC in a time zone whose days differ from India's (its due days, "today" and HR rules are its own, EA's stay
India's), a search pass (every GET asked for the other company's marker), a body pass (every POST names the other
company in its body), EA's photo and group chat swept by id, a plain company admin without salary, contact, money or
direct chats, and each company's phone receiving only its own company's push from the worker's real drain.
"""

import json
import os
import subprocess
import uuid
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def _config(role: str) -> str:
    config = conninfo_to_dict(dsn(role))
    config["database"] = config.pop("dbname")
    return json.dumps(config)


def test_two_companies_never_see_each_other(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    operator, client, task, chat = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Eamon EAMARK','staff')", (operator, w.org))
        worker.execute("""insert into pulse.people_profile(org_id,person_id,role,pod,username,evidence,email,user_no)
                          values(%s,%s,'Operations','Pod 1','eamon.eamark','{}',%s,90)""", (w.org, operator, f"eamon@{w.domain}"))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, operator))
        worker.execute("""insert into pulse.account(org_id,provider,handle,holder_person_id,purpose)
                          values(%s,'google',%s,%s,'Workspace account')""", (w.org, f"eamon@{w.domain}", operator))
        worker.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'EAMARK Client')", (client, w.org))
        worker.execute("update pulse.project set client_id=%s where id=%s", (client, w.project))
        worker.execute("""insert into pulse.task(id,org_id,project_id,title,assignee_person_id,created_by,status)
                          values(%s,%s,%s,'EAMARK task: reel cut',%s,%s,'open')""", (task, w.org, w.project, w.editor, operator))
        # R51: something to download (a photo) and to search (a group chat), both carrying the marker.
        worker.execute("insert into pulse.person_photo(org_id,person_id,mime,bytes) values(%s,%s,'image/png',%s)",
                       (w.org, w.editor, b"EAMARK synthetic photo bytes"))
        worker.execute("insert into pulse.chat_channel(id,org_id,key,name,kind) values(%s,%s,'eamark-group','EAMARK group','group')", (chat, w.org))
        worker.execute("insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, chat, operator))
        worker.execute("""insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id)
                          values(%s,%s,%s,'EAMARK chat: the reel is ready',gen_random_uuid())""", (w.org, chat, operator))
    with api.transaction():
        set_tenant(api, w.org, operator)
        api.execute("select pulse.login_issue(%s,'Synthetic-issued-2026!')", (operator,))
    ea = {
        "org": str(w.org), "slug": f"org-{w.org}", "name": f"Synthetic {w.code}", "accessEmail": f"eamon@{w.domain}",
        "admin": {"username": "eamon.eamark", "issued": "Synthetic-issued-2026!", "password": "Synthetic-operator-2026!"},
        "ids": {"person": str(w.editor), "people": [str(p) for p in (w.editor, w.editor2, w.lead, w.manager, operator)],
                "project": str(w.project), "client": str(client), "task": str(task), "chat": str(chat)},
    }
    env = {**os.environ, "TEST_API_CONFIG": _config("api"), "TEST_WORKER_CONFIG": _config("worker"), "TEST_EA": json.dumps(ea),
           "TEST_REPORT": str(tmp_path / "tenant.json"), "PULSE_ORG_ID": str(w.org),
           "PULSE_GMAIL_SEND_ENABLED": "0", "PULSE_DRIVE_UPLOAD_ENABLED": "0"}
    env.pop("PULSE_PUBLIC_LOGIN_ENABLED", None)
    env.pop("PULSE_PUBLIC_URL", None)
    root = Path(__file__).resolve().parents[2]
    proc = subprocess.run(["node", "test/tenant-isolation-runner.mjs"], cwd=root / "services/api", env=env,
                          capture_output=True, text=True, timeout=900, check=False)
    assert proc.returncode == 0, proc.stderr[-14000:] + "\n" + proc.stdout[-6000:]
    report = json.loads((tmp_path / "tenant.json").read_text())
    assert report["swept"] > report["routes"]          # every route, both ways, several ids each
    assert report["isolationTables"] > 100
    if os.environ.get("PULSE_TENANT_RECEIPT"):
        Path(os.environ["PULSE_TENANT_RECEIPT"]).write_text(json.dumps(report, indent=2))
    # The database agrees: AC's rows are AC's, and the worker sees two active companies.
    with worker.transaction():
        set_tenant(worker, report["acOrg"])
        assert worker.execute("select count(*) n from pulse.task where org_id<>pulse.current_org()").fetchone()["n"] == 0
        assert worker.execute("select count(*) n from pulse.task").fetchone()["n"] == 2
        assert worker.execute("select count(*) n from pulse.person where display_name like '%%EAMARK%%'").fetchone()["n"] == 0
    with worker.transaction():
        orgs = {str(r["org"]) for r in worker.execute("select pulse.list_active_orgs() org").fetchall()}
        assert {str(w.org), report["acOrg"]} <= orgs


def test_drive_collectors_refuse_another_company(worker, owner, api):
    """R51: the Drive changes (R44) and text (R45) collectors read with the install company's Google credential, so they
    write into the install company only; naming another company is refused before anything is read."""
    from pulse_gdrive_changes import cli as changes
    from pulse_gdrive_extract import cli as extract
    build_world(worker, owner, api)                       # makes sure an install company exists
    other = build_world(worker, owner, api)
    installed = worker.execute("select pulse.install_org() o").fetchone()["o"]
    assert installed and installed != other.org
    for cli in (changes, extract):
        assert cli._org(worker, None) == installed
        assert cli._org(worker, str(installed)) == installed
        try:
            cli._org(worker, str(other.org))
        except SystemExit as refused:
            assert "own company only" in str(refused)
        else:
            raise AssertionError(f"{cli.__name__} accepted another company")
