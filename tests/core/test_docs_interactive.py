"""DOCS-INTERACTIVE (1715): docs sent to a person, their answer, interactive block answers, reading receipts and links to
work, enforced by the database under forced row security. Synthetic tenants, people and words only."""
import psycopg
import pytest
from psycopg.types.json import Jsonb
from test_tasks_rt1 import as_, new_task, one, team  # noqa: F401  (team is a fixture)

DOC = "insert into pulse.doc(org_id,title,body_html,body_text,access,created_by) values(pulse.current_org(),%s,%s,'',%s,pulse.current_viewer()) returning id"
TABLES = ("doc_block_answer", "doc_link", "doc_read", "doc_request")
READ = """insert into pulse.doc_read(org_id,doc_id,person_id,session_id,active_ms,depth,sections)
  values(pulse.current_org(),%s,pulse.current_viewer(),%s,%s,%s,%s) returning id"""


def doc(api, w, who, title, access="private"):
    return one(api, w, who, DOC, (title, "<h2>Synthetic part</h2><p>Synthetic words</p>", access))["id"]


def test_tables_force_row_security_with_a_tenant_policy(worker):
    rows = worker.execute("""select c.relname,c.relrowsecurity,c.relforcerowsecurity,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname = any(%s) order by 1""", (list(TABLES),)).fetchall()
    assert [(r["relname"], r["relrowsecurity"], r["relforcerowsecurity"], r["tenant"]) for r in rows] == [(t, True, True, True) for t in TABLES]


def test_send_answer_and_notify(api, worker, team):
    w = team
    d = doc(api, w, w.editor, "Synthetic plan to approve")
    # Only the owner sends a private doc; sending shares it with the recipient and notifies them once.
    with pytest.raises((psycopg.errors.InsufficientPrivilege, psycopg.errors.NoDataFound)):
        one(api, w, w.outsider, "select pulse.doc_request_send(%s,%s,'approve',null,null) v", (d, w.editor2))
    # An editor of a company doc that is not its owner sends it; nobody sends to themselves.
    shared = doc(api, w, w.editor, "Synthetic company page", "company")
    one(api, w, w.editor2, "select pulse.doc_request_send(%s,%s,'read',null,null) v", (shared, w.outsider))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.editor, "select pulse.doc_request_send(%s,%s,'read',null,null) v", (shared, w.editor))
    rid = one(api, w, w.editor, "select pulse.doc_request_send(%s,%s,'approve','Synthetic note',null) v", (d, w.outsider))["v"]
    assert d in {r["id"] for r in as_(api, w, w.outsider, "select id from pulse.doc")}
    n = as_(api, w, w.outsider, "select title,href from pulse.notification where person_id=pulse.current_viewer() and event_key=%s", (f"doc-request:{rid}",))
    assert len(n) == 1 and n[0]["href"] == f"/docs/{d}?request={rid}" and "approve" in n[0]["title"]
    # The request is the sender's, the recipient's and the owner's to see; nobody else's.
    assert as_(api, w, w.editor2, "select id from pulse.doc_request where id=%s", (rid,)) == []
    assert as_(api, w, w.outsider, "select status from pulse.doc_request where id=%s", (rid,))[0]["status"] == "waiting"
    # Only the recipient answers; the sender hears it.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.doc_request_answer(%s,'approved',null)", (rid,))
    as_(api, w, w.outsider, "select pulse.doc_request_answer(%s,'changes','Synthetic: fix the dates')", (rid,))
    row = as_(api, w, w.editor, "select status,answer_note,answered_at is not null answered from pulse.doc_request where id=%s", (rid,))[0]
    assert (row["status"], row["answer_note"], row["answered"]) == ("changes", "Synthetic: fix the dates", True)
    assert len(as_(api, w, w.editor, "select id from pulse.notification where person_id=pulse.current_viewer() and event_key like %s", (f"doc-answer:{rid}:%",))) == 1
    # Requests are never written directly.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "insert into pulse.doc_request(org_id,doc_id,from_person,to_person,ask) values(pulse.current_org(),%s,pulse.current_viewer(),%s,'read') returning id", (d, w.editor2))


def test_reading_receipts_are_the_reader_owner_and_sender_alone(api, worker, team):
    w = team
    d = doc(api, w, w.editor, "Synthetic handbook", "company")
    one(api, w, w.editor, "select pulse.doc_request_send(%s,%s,'read',null,null) v", (d, w.outsider))
    sections = Jsonb({"s0-synthetic-part": {"t": "Synthetic part", "w": 40, "ms": 9000, "n": 1, "i": 0}})
    one(api, w, w.outsider, READ, (d, "dr-synthetic-0001", 9000, 0.9, sections))
    one(api, w, w.editor2, READ, (d, "dr-synthetic-0002", 1000, 0.2, Jsonb({})))
    # The reader writes only their own rows.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.outsider, """insert into pulse.doc_read(org_id,doc_id,person_id,session_id) values(pulse.current_org(),%s,%s,'dr-synthetic-0003') returning id""", (d, w.editor2))
    # Owner (and sender) sees everyone's; the reader sees their own; another colleague and an admin see none of others'.
    assert len(as_(api, w, w.editor, "select id from pulse.doc_read where doc_id=%s", (d,))) == 2
    assert {r["person_id"] for r in as_(api, w, w.outsider, "select person_id from pulse.doc_read where doc_id=%s", (d,))} == {w.outsider}
    assert {r["person_id"] for r in as_(api, w, w.manager, "select person_id from pulse.doc_read where doc_id=%s", (d,))} == set()
    # The company (an admin) can switch receipts off: nothing more is stored.
    switch = """insert into pulse.telemetry_setting(org_id,doc_reads,updated_by) values(pulse.current_org(),%s,pulse.current_viewer())
      on conflict (org_id) do update set doc_reads=excluded.doc_reads returning doc_reads"""
    one(api, w, w.manager, switch, (False,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.outsider, READ, (d, "dr-synthetic-0004", 1000, 0.5, Jsonb({})))
    one(api, w, w.manager, switch, (True,))


def test_block_answers_and_links_follow_the_doc(api, worker, team):
    w = team
    private = doc(api, w, w.editor, "Synthetic private form")
    company = doc(api, w, w.editor, "Synthetic company form", "company")
    ans = "insert into pulse.doc_block_answer(org_id,doc_id,block_id,kind,person_id,value) values(pulse.current_org(),%s,'b_synth01','approval',pulse.current_viewer(),%s) returning id"
    one(api, w, w.outsider, ans, (company, Jsonb({"decision": "approved"})))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.outsider, ans, (private, Jsonb({"decision": "approved"})))
    with pytest.raises(psycopg.errors.CheckViolation):
        one(api, w, w.editor, "insert into pulse.doc_block_answer(org_id,doc_id,block_id,kind,person_id,value) values(pulse.current_org(),%s,'nope','approval',pulse.current_viewer(),'{}') returning id", (company,))
    # Nobody changes another person's answer.
    assert as_(api, w, w.editor, "update pulse.doc_block_answer set value='{\"decision\":\"declined\"}' where doc_id=%s returning id", (company,)) == []
    # Links: the doc's editors link work; a reader links only a task they made (an approval's task); readers of the doc see the links.
    t = new_task(api, w, w.editor, title="Synthetic task with a brief")
    link = "insert into pulse.doc_link(org_id,doc_id,kind,ref_id,role,added_by) values(pulse.current_org(),%s,'task',%s,%s,pulse.current_viewer()) returning id"
    one(api, w, w.editor, link, (private, t, "brief"))
    assert as_(api, w, w.outsider, "select id from pulse.doc_link where doc_id=%s", (private,)) == []
    as_(api, w, w.editor, "update pulse.doc set company_edits=false where id=%s returning id", (company,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.outsider, link, (company, t, "related"))
    mine = new_task(api, w, w.outsider, title="Synthetic task from an approval")
    one(api, w, w.outsider, link, (company, mine, "related"))
    assert len(as_(api, w, w.editor2, "select id from pulse.doc_link where doc_id=%s", (company,))) == 1
