"""DOCS-ACTIVITY (2320): every move, share, access change, archive and restore of a doc or folder is recorded by the
database itself (doc_event), with how it was made (an AI employee, an API key, one of the server's tools, or a person in
the app) and an optional audit note; the trail is read under the doc's and folder's own visibility; an admin sees who
read a doc they can see. Synthetic tenants and words only."""
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)
from test_docs_drive import SHARE_DOC, SHARE_FOLDER, doc, folder

EVENTS = "select kind,via,via_label,detail,actor from pulse.doc_event where doc_id=%s order by at,kind"
FOLDER_EVENTS = "select kind,via,via_label,detail from pulse.doc_event where folder_id=%s order by at,kind"


def with_settings(api, w, who, settings, sql, args=()):
    """One statement as `who`, with request settings (actor_account, v1_token_id, doc_note) set as the API sets them."""
    with api.transaction():
        set_tenant(api, w.org, who)
        for k, v in settings.items():
            api.execute("select set_config(%s,%s,true)", (k, v))
        return api.execute(sql, args).fetchall()


def test_doc_event_forces_row_security_with_a_tenant_policy(worker):
    r = worker.execute("""select c.relrowsecurity,c.relforcerowsecurity,exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname='doc_event'""").fetchone()
    assert (r["relrowsecurity"], r["relforcerowsecurity"], r["tenant"]) == (True, True, True)


def test_moves_shares_access_and_archive_are_recorded_by_the_database(api, worker, team):
    w = team
    clients = folder(api, w, w.editor, "Clients")
    d = doc(api, w, w.editor, "Synthetic client brief", access="private")
    # Made in the app: one 'created' event, no "via".
    ev = as_(api, w, w.editor, EVENTS, (d,))
    assert [(e["kind"], e["via"]) for e in ev] == [("created", None)]
    assert ev[0]["actor"] == w.editor
    # Moved, with the caller's audit note kept.
    with_settings(api, w, w.editor, {"pulse.doc_note": "Tidy-up: briefs go under Clients"}, "update pulse.doc set folder_id=%s where id=%s returning id", (clients, d))
    moved = [e for e in as_(api, w, w.editor, EVENTS, (d,)) if e["kind"] == "moved"]
    assert moved and moved[0]["detail"]["from"] is None and moved[0]["detail"]["to"] == str(clients)
    assert moved[0]["detail"]["note"] == "Tidy-up: briefs go under Clients"
    # Access changed, a person added (with what they may do), then taken off.
    as_(api, w, w.editor, "update pulse.doc set access='people' where id=%s returning id", (d,))
    one(api, w, w.editor, SHARE_DOC, (d, w.editor2, False, True))
    one(api, w, w.editor, SHARE_DOC, (d, w.editor2, False, True))  # the same again changes nothing: no second line
    as_(api, w, w.editor, "delete from pulse.doc_share where doc_id=%s and person_id=%s returning doc_id", (d, w.editor2))
    as_(api, w, w.editor, "update pulse.doc set archived_at=now() where id=%s returning id", (d,))
    as_(api, w, w.editor, "update pulse.doc set archived_at=null where id=%s returning id", (d,))
    kinds = [e["kind"] for e in as_(api, w, w.editor, EVENTS, (d,))]
    assert kinds == ["created", "moved", "access", "shared", "unshared", "archived", "restored"], kinds
    shared = [e for e in as_(api, w, w.editor, EVENTS, (d,)) if e["kind"] == "shared"][0]
    assert shared["detail"] == {"person": str(w.editor2), "role": "comment"}
    # A word change is a version, not an event.
    as_(api, w, w.editor, "update pulse.doc set title='Synthetic client brief v2' where id=%s returning id", (d,))
    assert len(as_(api, w, w.editor, EVENTS, (d,))) == 7


def test_folders_record_made_moved_renamed_and_archived(api, worker, team):
    w = team
    top = folder(api, w, w.editor, "Sales")
    sub = folder(api, w, w.editor, "Offers")
    as_(api, w, w.editor, "update pulse.doc_folder set parent_id=%s where id=%s returning id", (top, sub))
    as_(api, w, w.editor, "update pulse.doc_folder set name='Offers and pricing' where id=%s returning id", (sub,))
    as_(api, w, w.editor, "update pulse.doc_folder set archived_at=now() where id=%s returning id", (sub,))
    ev = as_(api, w, w.editor, FOLDER_EVENTS, (sub,))
    assert [e["kind"] for e in ev] == ["created", "moved", "renamed", "archived"]
    assert ev[1]["detail"] == {"from": None, "to": str(top)}
    assert ev[2]["detail"] == {"from": "Offers", "to": "Offers and pricing"}


def test_how_a_change_was_made(api, worker, team):
    w = team
    # One of the server's tools, run for a person: its label is the tool's name.
    tool = {"pulse.actor_account": "docs tidy · approver: Synthetic Owner (owner)"}
    d = with_settings(api, w, w.editor, tool, """insert into pulse.doc(org_id,title,body_html,body_text,access,created_by)
      values(pulse.current_org(),'Synthetic report','<p>Words</p>','Words','company',pulse.current_viewer()) returning id""")[0]["id"]
    ev = as_(api, w, w.editor, EVENTS, (d,))
    assert (ev[0]["via"], ev[0]["via_label"]) == ("script", "docs tidy")
    assert as_(api, w, w.editor, "select via,via_label from pulse.doc_version where doc_id=%s", (d,)) == [{"via": "script", "via_label": "docs tidy"}]
    # A person in the app (their sign-in address as the actor): nothing.
    app = {"pulse.actor_account": "synthetic.person@example.test"}
    with_settings(api, w, w.editor, app, "update pulse.doc set folder_id=null, access='private' where id=%s returning id", (d,))
    assert [e["via"] for e in as_(api, w, w.editor, EVENTS, (d,)) if e["kind"] == "access"] == [None]
    # An API key (v1 / MCP): 'api'.
    key = {"pulse.actor_account": "synthetic.person@example.test", "pulse.v1_token_id": str(uuid.uuid4())}
    with_settings(api, w, w.editor, key, "update pulse.doc set access='company' where id=%s returning id", (d,))
    assert [e["via"] for e in as_(api, w, w.editor, EVENTS, (d,)) if e["kind"] == "access"] == [None, "api"]
    # An AI employee: 'ai'.
    agent = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Helper (AI)','agent')", (agent, w.org))
    a = doc(api, w, agent, "Synthetic AI summary")
    assert [(e["kind"], e["via"]) for e in as_(api, w, agent, EVENTS, (a,))] == [("created", "ai")]


def test_the_trail_follows_who_can_see_the_doc_and_folder(api, worker, team):
    w = team
    secret = doc(api, w, w.editor, "Synthetic private notes", access="private")
    as_(api, w, w.editor, "update pulse.doc set archived_at=now() where id=%s returning id", (secret,))
    legal = folder(api, w, w.editor, "Synthetic legal", access="people")
    one(api, w, w.editor, SHARE_FOLDER, (legal, w.editor2))
    for who in (w.editor2, w.outsider, w.manager):
        assert as_(api, w, who, EVENTS, (secret,)) == [], who
    assert as_(api, w, w.editor2, FOLDER_EVENTS, (legal,)) != []
    assert as_(api, w, w.outsider, FOLDER_EVENTS, (legal,)) == []
    # Nobody writes, changes or removes the trail directly; only the database's own triggers do.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "insert into pulse.doc_event(org_id,doc_id,kind,actor) values(pulse.current_org(),%s,'moved',pulse.current_viewer())", (secret,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.manager, "delete from pulse.doc_event where doc_id=%s", (secret,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.doc_event_add(pulse.current_org(),%s,null,'moved','{}'::jsonb)", (secret,))


def test_an_admin_sees_who_read_a_doc_they_can_see(api, worker, team):
    w = team
    d = doc(api, w, w.editor, "Synthetic company handbook")
    read = """insert into pulse.doc_read(org_id,doc_id,person_id,session_id,active_ms,depth) values(pulse.current_org(),%s,pulse.current_viewer(),%s,60000,0.8) returning id"""
    one(api, w, w.outsider, read, (d, "sessionAAAA1"))
    # The owner and an admin see it; another member does not.
    assert len(as_(api, w, w.editor, "select id from pulse.doc_read where doc_id=%s", (d,))) == 1
    assert len(as_(api, w, w.manager, "select id from pulse.doc_read where doc_id=%s", (d,))) == 1
    assert as_(api, w, w.editor2, "select id from pulse.doc_read where doc_id=%s", (d,)) == []
    # An admin does not see who read a private doc they cannot see.
    p = doc(api, w, w.editor, "Synthetic private draft", access="people")
    one(api, w, w.editor, SHARE_DOC, (p, w.outsider, False, False))
    one(api, w, w.outsider, read, (p, "sessionBBBB2"))
    assert as_(api, w, w.manager, "select id from pulse.doc_read where doc_id=%s", (p,)) == []


def test_another_company_sees_nothing(api, worker, team):
    w = team
    d = doc(api, w, w.editor, "Synthetic doc of company one")
    other = uuid.uuid4()
    with api.transaction():
        set_tenant(api, other, w.editor)
        assert api.execute(EVENTS, (d,)).fetchall() == []
