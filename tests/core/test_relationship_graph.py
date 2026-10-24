"""R46 relationship graph in the database: imported links are typed proposals with their source, never truth; only a
reviewer an admin named for that kind decides, against the version they saw; a written name with no record stays
unresolved; a source that changes after a decision proposes a correction while the confirmed relationship stands;
decisions undo; model links stay hidden and undecidable until the owner's definition is recorded; nothing crosses a
company; reviewers' tasks and pushes carry counts only. Synthetic tenants, names and details only."""
import uuid
from datetime import date

import psycopg
import pytest
from helpers import build_world
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, notes, one, team  # noqa: F401  (team is a fixture)

PRIVATE = ("ravi@example.test", "98765", "Northstar", "Skyline", "Ravi", "Asha", "Lakeview", "Parkside", "Opinem")


def rel_world(worker, w):
    """Two engagement records of one RE project (same key), a third project, two clients with the same name, a
    developer with a contact (email and phone on file), a model with a shoot, and Review data's PM suggestions:
    one naming a colleague's record, one only a written name."""
    x = type("X", (), {})()
    x.north, x.sky1, x.sky2, x.p1, x.p2, x.p3, x.ravi, x.asha = (uuid.uuid4() for _ in range(8))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.client(id,org_id,display_name,client_type) values(%s,%s,'Northstar Developers','developer')", (x.north, w.org))
        for cid in (x.sky1, x.sky2):
            worker.execute("insert into pulse.client(id,org_id,display_name,client_type) values(%s,%s,'Skyline Realty','channel_partner')", (cid, w.org))
        no = worker.execute("select coalesce(max(registry_no),0)+1 n from pulse.project").fetchone()["n"]
        for i, (pid, title, key, client) in enumerate(((x.p1, "Lakeview", "lakeview@baner", x.north), (x.p2, "Lakeview", "lakeview@baner", x.sky1),
                                                       (x.p3, "Parkside", "parkside@wakad", x.sky2))):
            worker.execute("insert into pulse.project(id,org_id,registry_no,name,title,project_key,client_id,start_month) values(%s,%s,%s,%s,%s,%s,%s,'2026-08-01')",
                           (pid, w.org, no + i, title, title, key, client))
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Ravi Contact','other')", (x.ravi, w.org))
        worker.execute("insert into pulse.contact_profile(org_id,person_id,contact_type,email,phone,source) values(%s,%s,'developer','ravi@example.test','+91 98765 43210','enrichment')", (w.org, x.ravi))
        worker.execute("insert into pulse.client_contact(org_id,client_id,person_id,is_primary) values(%s,%s,%s,true)", (w.org, x.north, x.ravi))
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Asha Rao','talent')", (x.asha, w.org))
        worker.execute("insert into pulse.contact_profile(org_id,person_id,contact_type,source) values(%s,%s,'talent','test')", (w.org, x.asha))
        worker.execute("""insert into pulse.talent_shoot(org_id,source_key,person_id,alias,shoot_on,month,project_id,project_basis,project_confidence,place_basis,sources,source)
                          values(%s,'sd:synthetic:1',%s,'asha','2026-09-02','2026-09-01',%s,'client_name',0.9,'none','{shoot_sheet}',%s)""",
                       (w.org, x.asha, x.p1, Jsonb({"type": "sheet"})))
        for pid, proposed in ((x.p1, {"pod": None, "pgsId": str(w.editor2), "pgsCandidate": "Editor Two", "pgsBasis": "Assigned PM; PGS title not established"}),
                              (x.p3, {"pod": None, "pgsId": None, "pgsCandidate": "Opinem", "pgsBasis": "Assigned PM; PGS title not established"})):
            worker.execute("""insert into pulse.review_item(org_id,source_key,kind,entity_type,entity_id,title,proposed,confidence,evidence)
                              values(%s,%s,'project_pod','project',%s,'pod / PGS',%s,0.6,'[]')""", (w.org, f"pod:{pid}", pid, Jsonb(proposed)))
    return x


def refresh(api, w):
    return one(api, w, w.manager, "select pulse.relation_refresh() r")["r"]


def heads(api, w, who, **match):
    rows = as_(api, w, who, "select * from pulse.relation_head order by kind,subject_id")
    return [r for r in rows if all(r[k] == v for k, v in match.items())]


def head(api, w, who, **match):
    rows = heads(api, w, who, **match)
    assert len(rows) == 1, rows
    return rows[0]


def name(api, w, person, kinds):
    as_(api, w, w.manager, "select pulse.relation_reviewer_set(%s,%s,'synthetic')", (person, kinds))


def decide(api, w, who, h, action, p=None, note=None):
    return one(api, w, who, "select pulse.relation_decide(%s,%s,%s,%s,%s) id", (h["thread"], h["id"], action, Jsonb(p or {}), note))["id"]


def test_proposals_are_typed_counted_and_never_confirmed(api, worker, team):
    w = team
    x = rel_world(worker, w)
    counts = refresh(api, w)
    assert counts["added"] >= 8 and counts["changed"] == 0
    all_ = heads(api, w, w.editor)
    assert {r["status"] for r in all_} == {"proposed"} and all(r["actor"] is None for r in all_)
    # Engagement records are not all unique developments: the two Lakeview records share one RE project key.
    dev = heads(api, w, w.editor, kind="development")
    assert sorted(r["subject_id"] for r in dev) == sorted([x.p1, x.p2]) and {r["object_key"] for r in dev} == {"lakeview@baner"}
    assert "Lakeview" in dev[0]["object_label"] and dev[0]["evidence"][0]["basis"].startswith("The same project key as 1")
    # Typed clients: a developer, a channel partner; two clients with the same name stay two records (no merge).
    roles = {r["subject_id"]: r["role"] for r in heads(api, w, w.editor, kind="client")}
    assert roles[x.p1] == "developer" and roles[x.p2] == "channel_partner" and roles[x.p3] == "channel_partner"
    sky = {r["object_id"] for r in heads(api, w, w.editor, kind="client") if r["object_label"] == "Skyline Realty"}
    assert sky == {x.sky1, x.sky2}
    # The PM named by a record is resolved; a written name alone is not matched to anyone.
    assert head(api, w, w.editor, kind="team", subject_id=x.p1)["object_id"] == w.editor2
    opinem = head(api, w, w.editor, kind="team", subject_id=x.p3)
    assert opinem["object_id"] is None and opinem["object_label"] == "Opinem"
    # A contact keeps its role and source but none of its details; the model link and its shoot dates exist (hidden in views).
    ravi = head(api, w, w.editor, kind="contact")
    assert ravi["object_id"] == x.ravi and ravi["role"] == "Primary contact" and "ravi@example.test" not in str(ravi) and "98765" not in str(ravi)
    model = head(api, w, w.editor, kind="model")
    assert model["object_type"] == "model" and model["valid_from"] == date(2026, 9, 2)
    # Reading the sources again proposes nothing new.
    again = refresh(api, w)
    assert again["added"] == 0 and again["changed"] == 0 and again["withdrawn"] == 0


def test_only_named_reviewers_decide_and_pushes_carry_counts_only(api, worker, team):
    w = team
    x = rel_world(worker, w)
    refresh(api, w)
    p1 = head(api, w, w.editor, kind="client", subject_id=x.p1)
    # A role is not a reviewer grant: neither a pod head nor an admin decides before being named.
    for who in (w.editor2, w.manager):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            decide(api, w, who, p1, "confirm")
    # Naming reviewers is the admins' job.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.relation_reviewer_set(%s,%s,null)", (w.editor2, ["client"]))
    name(api, w, w.editor2, ["client", "team"])
    task = one(api, w, w.editor2, "select id,title,notes,status from pulse.task where source='relation_review' and owner_id=%s", (w.editor2,))
    assert task["title"] == "Confirm 5 relationships" and task["status"] == "open"
    sent = notes(worker, w, w.editor2, "task.assigned")
    assert [n["subject_id"] for n in sent] == [task["id"]] and sent[0]["href"] == f"/tasks/{task['id']}" and sent[0]["title"] == "A task was assigned to you"
    assert "/relationships?view=review" in task["notes"]
    for text in [sent[0]["title"], sent[0]["href"], task["title"], task["notes"]]:
        assert not any(p in text for p in PRIVATE), text
    # A reviewer sees their own grant only.
    assert one(api, w, w.editor, "select count(*)::int n from pulse.relation_reviewer")["n"] == 0
    assert one(api, w, w.manager, "select count(*)::int n from pulse.relation_reviewer")["n"] == 1
    confirmed = decide(api, w, w.editor2, p1, "confirm", note="Known client")
    row = head(api, w, w.editor, kind="client", subject_id=x.p1)
    assert row["id"] == confirmed and row["status"] == "confirmed" and row["actor"] == w.editor2 and row["version"] == 2
    # Outside the reviewer's kinds, nothing.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        decide(api, w, w.editor2, head(api, w, w.editor, kind="contact"), "confirm")
    # Unclear identity stays unresolved until the reviewer chooses the record.
    opinem = head(api, w, w.editor, kind="team", subject_id=x.p3)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        decide(api, w, w.editor2, opinem, "confirm")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        decide(api, w, w.editor2, opinem, "correct", {"id": str(x.ravi)})      # a contact is not a colleague
    decide(api, w, w.editor2, opinem, "correct", {"id": str(w.editor)})
    assert head(api, w, w.editor, kind="team", subject_id=x.p3)["object_id"] == w.editor
    # Counts move; one task, kept current; done when nothing waits.
    assert one(api, w, w.editor2, "select title from pulse.task where id=%s", (task["id"],))["title"] == "Confirm 3 relationships"
    for h in heads(api, w, w.editor2, status="proposed"):
        if h["kind"] in ("client", "team"):
            decide(api, w, w.editor2, h, "reject" if h["kind"] == "team" else "confirm")
    assert one(api, w, w.editor2, "select status from pulse.task where id=%s", (task["id"],))["status"] == "done"
    assert len(notes(worker, w, w.editor2, "task.assigned")) == 1
    # Revoking stops decisions at once.
    name(api, w, w.editor2, [])
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        decide(api, w, w.editor2, head(api, w, w.editor, kind="client", subject_id=x.p1), "reject")


def test_conflicting_reviewers_stale_sources_corrections_and_undo(api, worker, team):
    w = team
    x = rel_world(worker, w)
    refresh(api, w)
    name(api, w, w.editor, ["client"])
    name(api, w, w.editor2, ["client"])
    seen = head(api, w, w.editor, kind="client", subject_id=x.p2)
    decide(api, w, w.editor, seen, "confirm")
    # The second reviewer acted on the version they saw: refused, not overwritten.
    with pytest.raises(psycopg.errors.SerializationFailure):
        decide(api, w, w.editor2, seen, "reject")
    now = head(api, w, w.editor2, kind="client", subject_id=x.p2)
    decide(api, w, w.editor2, now, "reject", note="Different firm")
    history = as_(api, w, w.editor, "select status,actor,action from pulse.relation_edge where thread=%s order by version", (seen["thread"],))
    assert [(h["status"], h["actor"]) for h in history] == [("proposed", None), ("confirmed", w.editor), ("rejected", w.editor2)]
    # Undo the newest decision: the first reviewer's confirmation is current again. Source versions are not undone.
    top = head(api, w, w.editor, kind="client", subject_id=x.p2)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select pulse.relation_undo(%s,%s)", (top["thread"], top["id"]))
    as_(api, w, w.editor2, "select pulse.relation_undo(%s,%s)", (top["thread"], top["id"]))
    back = head(api, w, w.editor, kind="client", subject_id=x.p2)
    assert back["status"] == "confirmed" and back["actor"] == w.editor
    p3 = head(api, w, w.editor, kind="client", subject_id=x.p3)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.relation_undo(%s,%s)", (p3["thread"], p3["id"]))
    # Stale source: the project's client changed after the proposal was made; confirming the old proposal is refused.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.project set client_id=%s where id=%s", (x.sky1, x.p3))
    with pytest.raises(psycopg.errors.SerializationFailure):
        decide(api, w, w.editor, p3, "confirm")
    assert refresh(api, w)["changed"] == 1
    p3 = head(api, w, w.editor, kind="client", subject_id=x.p3)
    assert p3["status"] == "proposed" and p3["object_id"] == x.sky1 and p3["action"] == "source_changed" and p3["standing"] is None
    decide(api, w, w.editor, p3, "confirm")
    # A source that changes after confirmation proposes a correction; the confirmed relationship stands meanwhile.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.project set client_id=%s where id=%s", (x.sky2, x.p3))
    refresh(api, w)
    pending = head(api, w, w.editor, kind="client", subject_id=x.p3)
    standing = one(api, w, w.editor, "select status,object_id from pulse.relation_edge where id=%s", (pending["standing"],))
    assert pending["status"] == "proposed" and pending["object_id"] == x.sky2 and standing == {"status": "confirmed", "object_id": x.sky1}
    decide(api, w, w.editor, pending, "reject", note="The source is wrong")
    kept = head(api, w, w.editor, kind="client", subject_id=x.p3)
    assert kept["status"] == "confirmed" and kept["object_id"] == x.sky1
    assert refresh(api, w)["changed"] == 0                                 # the same source value is not proposed again
    # A reviewer's correction to another record; a later refresh does not re-propose what the source said then.
    decide(api, w, w.editor, kept, "correct", {"id": str(x.north)}, note="Northstar runs it now")
    assert head(api, w, w.editor, kind="client", subject_id=x.p3)["object_id"] == x.north
    assert refresh(api, w)["changed"] == 0
    # A colleague who is not a reviewer suggests a correction: it waits; the confirmed relationship stays confirmed.
    as_(api, w, w.outsider, "select pulse.relation_suggest('client',%s,%s,'I think it is Skyline')", (x.p3, Jsonb({"id": str(x.sky2)})))
    sug = head(api, w, w.editor, kind="client", subject_id=x.p3)
    assert sug["status"] == "proposed" and sug["actor"] == w.outsider and sug["standing"] is not None
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.outsider, "select pulse.relation_suggest('client',%s,%s,null)", (x.p3, Jsonb({"id": str(x.sky2)})))
    # The suggester undoes it themselves.
    as_(api, w, w.outsider, "select pulse.relation_undo(%s,%s)", (sug["thread"], sug["id"]))
    assert head(api, w, w.editor, kind="client", subject_id=x.p3)["object_id"] == x.north
    # Versions are never edited or deleted through the API role.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.manager, "update pulse.relation_edge set status='confirmed' where thread=%s", (sug["thread"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.manager, "delete from pulse.relation_edge where thread=%s", (sug["thread"],))


def test_models_stay_hidden_until_the_owner_defines_them(api, worker, team):
    w = team
    x = rel_world(worker, w)
    refresh(api, w)
    name(api, w, w.editor, ["model", "contact"])
    # No task for model links while they are unconfigured (the contact waits; the model shoot does not count).
    assert one(api, w, w.editor, "select title from pulse.task where source='relation_review' and owner_id=%s", (w.editor,))["title"] == "Confirm 1 relationship"
    model = head(api, w, w.editor, kind="model")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        decide(api, w, w.editor, model, "confirm")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.relation_suggest('model',%s,%s,null)", (x.p2, Jsonb({"id": str(x.asha)})))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.relation_node_type_set('model','People who appear in our ad shoots','synthetic')")
    as_(api, w, w.manager, "select pulse.relation_node_type_set('model','People who appear in our ad shoots, one contact type','synthetic owner note')")
    assert one(api, w, w.editor, "select pulse.relation_model_on() v")["v"] is True
    assert one(api, w, w.editor, "select title from pulse.task where source='relation_review' and owner_id=%s", (w.editor,))["title"] == "Confirm 2 relationships"
    decide(api, w, w.editor, model, "confirm")
    assert head(api, w, w.editor, kind="model")["status"] == "confirmed"
    # Withdrawing the definition hides them again; nothing is deleted.
    as_(api, w, w.manager, "select pulse.relation_node_type_set('model',null,null)")
    assert one(api, w, w.editor, "select pulse.relation_model_on() v")["v"] is False
    assert head(api, w, w.editor, kind="model")["status"] == "confirmed"


def test_no_edge_crosses_a_company_and_signed_out_reads_nothing(api, worker, owner, team):
    w = team
    x = rel_world(worker, w)
    refresh(api, w)
    w2 = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w2.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (w2.org, w2.manager))
    p1 = head(api, w, w.editor, kind="client", subject_id=x.p1)
    assert as_(api, w2, w2.manager, "select * from pulse.relation_head") == []
    as_(api, w2, w2.manager, "select pulse.relation_reviewer_set(%s,%s,null)", (w2.manager, ["client"]))
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w2, w2.manager, "select pulse.relation_decide(%s,%s,'confirm','{}',null)", (p1["thread"], p1["id"]))
    # Another company's client cannot be chosen, and its own client cannot be attached to another company's project.
    own = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w2.org)
        worker.execute("insert into pulse.client(id,org_id,display_name,client_type) values(%s,%s,'Own Client','developer')", (own, w2.org))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="right kind"):
        as_(api, w2, w2.manager, "select pulse.relation_suggest('client',%s,%s,null)", (w2.project, Jsonb({"id": str(x.north)})))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="starts from is not in this company"):
        as_(api, w2, w2.manager, "select pulse.relation_suggest('client',%s,%s,null)", (x.p1, Jsonb({"id": str(own)})))
    assert one(api, w, w.editor, "select count(*)::int n from pulse.relation_edge where object_id=%s", (own,))["n"] == 0
    # Without a signed-in person, nothing is readable.
    assert as_(api, w, None, "select * from pulse.relation_head") == []
    # The worker reads the sources too (hourly); the API role cannot without being an admin.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.relation_refresh()")
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select pulse.relation_refresh() r").fetchone()["r"]["added"] == 0
    # A reviewer whose task the worker creates (a new proposal in their kind) gets the same notification a person's
    # action would send.
    name(api, w, w.editor, ["account_owner"])
    assert one(api, w, w.editor, "select count(*)::int n from pulse.task where source='relation_review' and owner_id=%s", (w.editor,))["n"] == 0
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.client set relationship_owner_id=%s where id=%s", (w.editor2, x.north))
        assert worker.execute("select pulse.relation_refresh() r").fetchone()["r"]["added"] == 1
    sent = notes(worker, w, w.editor, "task.assigned")
    assert len(sent) == 1 and sent[0]["title"] == "A task was assigned to you" and sent[0]["href"].startswith("/tasks/")
