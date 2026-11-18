"""CONNECTIONS part A in the browser: the home across a person's companies, in their own personal space
(apps/web/app/dashboard/across.tsx), the switcher and Organisations with test and demo companies apart, and Settings →
Organisation's registered name. services/api/test/across-home-browser-runner.mjs drives it at 1440 and 363, light and
dark (PULSE_ACROSS_SCREENSHOTS=<dir> keeps the shots). Everything is invented."""
import json
import os
import subprocess
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from conftest import dsn
from helpers import NOTICE_PURPOSES, build_world
from pulse_sdk.db import set_tenant
from test_erp_invoice import draft, issue, setup_company
from test_kazuk_gaps import owner_sql
from test_my_day import _staff_ready, _token
from test_founder_view import founder  # noqa: F401  (the fixture: Kedab in three companies and a personal space)


def _home_api(api, org, who):
    with api.transaction():
        set_tenant(api, org, who)
        return api.execute("select pulse.account_seat_purposes() p").fetchone()["p"]


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_across_home_in_the_browser(api, worker, owner, founder):  # noqa: F811
    f = founder; a, b, c = f["a"], f["b"], f["c"]
    names = {a.org: "Northstar Realty", b.org: "Brightpath Labs", c.org: "Kite Studio"}
    for w, name in ((a, names[a.org]), (b, names[b.org]), (c, names[c.org])):
        owner_sql(owner, w, "update pulse.org set name=%s, handle=%s where id=%s", (name, name.split()[0].lower() + w.code.lower(), w.org))
    # Kite Studio is a demo company: listed apart, never counted.
    owner_sql(owner, c, "update pulse.org set purpose='demo' where id=%s", (c.org,))
    assert _home_api(api, a.org, f["ka"])[str(c.org)] == {"purpose": "demo", "kind": "company"}
    # Money in Northstar: a bill 5 days late and one due in 2 days.
    client = uuid.uuid4()
    owner_sql(owner, a, "insert into pulse.client(id,org_id,display_name) values(%s,%s,'Lotus Interiors')", (client, a.org))
    setup_company(api, a, f["ka"])
    for days, taxable in ((-5, 10000000), (2, 6000000)):
        inv = draft(api, a, f["ka"], taxable=taxable, client=client)
        owner_sql(owner, a, "update pulse.erp_document set due_date=(now() at time zone 'Asia/Kolkata')::date+%s where id=%s", (days, inv))
        issue(api, a, f["ka"], inv)
    # Kedab's own work: late and due today in Northstar, late in Brightpath. "Due today" is 23:59 of the company's day (IST):
    # "in an hour" was tomorrow there when CI ran after 23:00 IST, and the day's ring said 1 of 2 (hosted run 44141061934).
    today_end = "((now() at time zone 'Asia/Kolkata')::date + time '23:59') at time zone 'Asia/Kolkata'"
    for w, who, title, due in ((a, f["ka"], "Send the room plan", "now()-interval '2 days'"), (a, f["ka"], "Call the site engineer", today_end),
                               (b, f["kb"], "Review the pitch deck", "now()-interval '1 day'")):
        owner_sql(owner, w, f"""insert into pulse.task(id,org_id,title,status,priority,assignee_person_id,due_at,created_by)
            values(%s,%s,%s,'open','high',%s,{due},%s)""", (uuid.uuid4(), w.org, title, who, who))
    # A client's open question in Brightpath (a block on a client's project).
    bc = uuid.uuid4()
    owner_sql(owner, b, "insert into pulse.client(id,org_id,display_name) values(%s,%s,'Harbor Builders')", (bc, b.org))
    owner_sql(owner, b, "update pulse.project set client_id=%s where id=%s", (bc, b.project))
    owner_sql(owner, b, """insert into pulse.blocker(org_id,project_id,blocker_key,opened_at,owner_side,source)
        values(%s,%s,'Floor plan from the client',now()-interval '2 days','client','declared')""", (b.org, b.project))
    # Northstar works with Greenline Homes on Pulse (a client connection) and with a vendor.
    g = build_world(worker, owner, api)
    owner_sql(owner, g, "update pulse.org set name='Greenline Homes' where id=%s", (g.org,))
    v = build_world(worker, owner, api)
    owner_sql(owner, v, "update pulse.org set name='Rapid Print Works' where id=%s", (v.org,))
    with owner.transaction():
        owner.execute("insert into pulse_priv.org_connection(a_org,b_org,kind) values(%s,%s,'client'),(%s,%s,'vendor')", (a.org, g.org, a.org, v.org))
    # Kedab's personal space is a ready seat; the browser opens there with a session minted by the account switch.
    with owner.transaction():
        set_tenant(owner, f["p"])
        owner.execute("""insert into privacy.notice (org_id, id, language, body_md, purposes, published_at)
                         values (%s, 'staff-v1', 'en', 'Synthetic staff notice', %s, now() - interval '30 days')""", (f["p"], NOTICE_PURPOSES))
        owner.execute("update pulse.person set display_name='Kedab Mifos' where id=%s", (f["kp"],))
    _staff_ready(api, worker, SimpleNamespace(org=f["p"]), f["kp"])
    for w in (a,):
        _staff_ready(api, worker, w, f["ka"])
    with worker.transaction():
        set_tenant(worker, a.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                       (a.org, f"kedab@{a.domain}", f["ka"]))
    with owner.transaction():
        # A password of his own (a synthetic bcrypt of random text): the one-password prompt is not part of this walk.
        owner.execute("update pulse_priv.pulse_account set display_name='Kedab Mifos', password_hash=crypt(gen_random_uuid()::text, gen_salt('bf', 4)) where id=%s", (f["account"],))
    # CONNECTIONS part B: Kedab works with Diya personally (a freelancer), made from his own space.
    with owner.transaction():
        owner.execute("update pulse_priv.pulse_account set display_name='Diya Nair' where handle=%s", (f["dhandle"],))
    with api.transaction():
        set_tenant(api, f["p"], f["kp"])
        conn = api.execute("select pulse.connection_make(%s) r", (Jsonb({"kind": "freelancer", "accountHandle": f["dhandle"], "bRole": "Designer"}),)).fetchone()["r"]["id"]
    token = _token(api, a, f["ka"], f["p"], owner)
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"personal": str(f["p"]), "token": token, "names": [names[a.org], names[b.org]], "demo": names[c.org],
                                   "workWith": ["Greenline Homes", "Rapid Print Works"], "conn": conn}),
           "TEST_EMAILS": json.dumps({"admin": f"kedab@{a.domain}"})}
    p = subprocess.run(["node", "test/across-home-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    print(p.stdout[-600:])
    # Settings → Organisation saved the registered name through the product's own function, with the note.
    with owner.transaction():
        set_tenant(owner, a.org)
        note = owner.execute("select changes from pulse.audit_event where org_id=%s and action='org.legal_name' order by at desc limit 1", (a.org,)).fetchone()
    assert note and note["changes"]["to"] == "Northstar Realty Private Limited" and note["changes"]["note"] == "Name approved by the registrar"
    # The agreement the walk drafted is a draft in Kedab's own space, and the task waits there on Diya's guest seat.
    with owner.transaction():
        set_tenant(owner, f["p"])
        k = owner.execute("select t.status from pulse.contract t where t.org_id=%s", (f["p"],)).fetchall()
        t = owner.execute("select p.side from pulse.task t join pulse.person p on p.id=t.assignee_person_id where t.org_id=%s and t.title='Pick the cover colours'", (f["p"],)).fetchone()
    assert [x["status"] for x in k] == ["draft"]
    assert t and t["side"] == "client"
