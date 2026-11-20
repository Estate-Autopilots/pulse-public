"""AC-CONTACTS (2397): a contact's tags, status, phone type and where they came from ("Testers are potential clients;
track who is testing"). The database keeps each to its rule; pulse.contact_writer() says who may add and change contacts
through API v1 and the AI tools (add_contact, update_contact: services/api/test/agent-api-runner.mjs). The Add contact
form, the profile and the tag filter in the browser with PULSE_CONTACT_TRACKING_BROWSER=1. Synthetic tenants only."""
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from helpers import build_world


def contact(worker, w, name="Synthetic Tester"):
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'other')", (pid, w.org, name))
        worker.execute("insert into pulse.contact_profile(org_id,person_id,source) values(%s,%s,'manual')", (w.org, pid))
    return pid


def give(worker, w, person, role):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01') on conflict do nothing", (w.org, person, role))


def test_tags_status_and_phone_type_keep_their_rules(worker, owner, api):
    w = build_world(worker, owner, api)
    give(worker, w, w.manager, "admin")
    pid = contact(worker, w)
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("""update pulse.contact_profile set tags='{tester,prospect}',contact_status='invited',contact_status_at=now(),device='android',
            came_from='Synthetic tester list' where person_id=%s""", (pid,))
        row = api.execute("select tags,contact_status,device,came_from from pulse.contact_profile where person_id=%s", (pid,)).fetchone()
    assert row == {"tags": ["tester", "prospect"], "contact_status": "invited", "device": "android", "came_from": "Synthetic tester list"}
    for sql, value in [("tags=%s", ["Tester"]), ("tags=%s", ["a" * 41]), ("tags=%s", [f"t{i}" for i in range(21)]), ("contact_status=%s", "maybe"),
                       ("device=%s", "nokia"), ("came_from=%s", "")]:
        with pytest.raises(psycopg.errors.CheckViolation):
            with api.transaction():
                set_tenant(api, w.org, w.manager)
                api.execute(f"update pulse.contact_profile set {sql} where person_id=%s", (value, pid))
    # Another company never sees the tags.
    other = build_world(worker, owner, api)
    with api.transaction():
        set_tenant(api, other.org, other.manager)
        assert api.execute("select count(*) n from pulse.contact_profile where person_id=%s", (pid,)).fetchone()["n"] == 0


def test_who_may_add_and_change_contacts_through_the_api(worker, owner, api):
    """Admins, leadership and the Finance role write contacts through the API role (row security, not only the routes);
    never a staff member's or an AI member's person row unless they are an admin or HR; anyone else writes nothing."""
    w = build_world(worker, owner, api)
    give(worker, w, w.manager, "admin")
    give(worker, w, w.lead, "leadership")
    for viewer, allowed in [(w.manager, True), (w.lead, True), (w.editor, False), (None, False)]:
        with api.transaction():
            set_tenant(api, w.org, viewer)
            assert api.execute("select pulse.contact_writer() v").fetchone()["v"] is allowed, viewer
    pid = uuid.uuid4()
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Lead Contact','other')", (pid, w.org))
        api.execute("insert into pulse.contact_profile(org_id,person_id,source,tags,contact_status) values(%s,%s,'manual','{tester}','invited')", (w.org, pid))
        api.execute("insert into pulse.company(org_id,name,source,created_by) values(%s,'Synthetic Testers Co','contact',%s)", (w.org, w.lead))
    for viewer, sql in [(w.lead, "insert into pulse.person(org_id,display_name,side) values(%s,'Synthetic Staff','staff')"),
                        (w.editor, "insert into pulse.person(org_id,display_name,side) values(%s,'Synthetic Contact','other')")]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with api.transaction():
                set_tenant(api, w.org, viewer)
                api.execute(sql, (w.org,))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert api.execute("update pulse.contact_profile set contact_status='client' where person_id=%s", (pid,)).rowcount == 0


@pytest.mark.skipif(__import__("os").environ.get("PULSE_CONTACT_TRACKING_BROWSER") != "1", reason="the browser walk runs with PULSE_CONTACT_TRACKING_BROWSER=1")
def test_a_tester_in_the_browser(worker, owner, api):
    """services/api/test/contact-tracking-browser.mjs: a sales team adds a tester (tag, status, phone, where from), opens
    the profile and the Testers list, at 363 and 1440 px, light and dark."""
    import json
    import os
    import subprocess
    from pathlib import Path
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = build_world(worker, owner, api)
    pid = uuid.uuid4()
    email = f"walker@sales-{w.code.lower()}.example"
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.org set name='Synthetic Sales Team' where id=%s", (w.org,))
        owner.execute("select pulse.record_types_defaults()")
        owner.execute("insert into pulse.record_type(org_id,entity,key,label) values(%s,'contact','relationship_contact','Relationship contact') on conflict do nothing", (w.org,))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Walker','staff')", (pid, w.org))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence,username,email) values(%s,%s,'admin','Pod 1','{}',%s,%s)",
                       (w.org, pid, "synthetic.walker.sales", email))
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, email, pid))
        for role in ("admin", "leadership"):
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, pid, role))
    contact(worker, w, "Synthetic Prospect Asha")   # the book is not empty: its header carries Add contact
    schema_owner = owner.execute("select pg_get_userbyid(nspowner) o from pg_namespace where nspname='pulse'").fetchone()["o"]
    with owner.transaction():
        owner.execute(f'set local role "{schema_owner}"')
        owner.execute("delete from pulse.install")
        owner.execute("insert into pulse.install(org_id,initialised_by) values(%s,'test:synthetic')", (w.org,))
    config = conninfo_to_dict(dsn("api")); config["database"] = config.pop("dbname")
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_ORG": json.dumps({"email": email}), "PULSE_CI": "1"}
    result = subprocess.run(["node", "test/contact-tracking-browser.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, text=True,
                            capture_output=True, timeout=3600)
    print(result.stdout[-2500:])
    assert result.returncode == 0, result.stdout[-2500:] + "\n" + result.stderr[-2500:]
