"""CONNECTIONS part B (2200; spec reports/CONNECT-MAP.md §3): a connection between two parties, read per seat, with its
derived agreement, a draft agreement (never sent), a task given across that lands in the doer's own space, a doc shared
across through a guest seat, AI helpers that read as their person and change nothing, and ending it.
Synthetic organisations, people and accounts only."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from helpers import build_world, new_code
from test_investor_metrics import admin, as_, member, new_account, person


def _personal(worker, owner, acct, name):
    """A personal space of an account, with its one staff seat (an admin there)."""
    org, me = uuid.uuid4(), uuid.uuid4()
    code = new_code()
    with worker.transaction():
        set_tenant(worker, org)
        worker.execute("insert into pulse.org(id,slug,name,code,kind,personal_account) values(%s,%s,%s,%s,'personal',%s)", (org, f"org-{org}", name, code, acct))
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (me, org, name))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (org, me))
    member(owner, acct, org, me)
    return org, me


@pytest.fixture
def world(worker, owner, api):
    """Asha: her personal space and admin of company V. Ravi: his personal space. Nisha: admin of company N. Ken: staff in V."""
    v, n = build_world(worker, owner, api), build_world(worker, owner, api)
    tag = uuid.uuid4().hex[:6]
    asha, ravi, nisha, ken = (new_account(owner, f"{x}{tag}") for x in ("asha", "ravi", "nisha", "ken"))
    ap, ap_me = _personal(worker, owner, asha, "Synthetic Asha")
    rp, rp_me = _personal(worker, owner, ravi, "Synthetic Ravi")
    admin(worker, v.org, v.manager); member(owner, asha, v.org, v.manager)
    admin(worker, n.org, n.manager); member(owner, nisha, n.org, n.manager)
    member(owner, ken, v.org, v.editor)
    with owner.transaction():
        set_tenant(owner, n.org)
        owner.execute("update pulse.org set handle=%s where id=%s", (f"nature{tag}", n.org))
    return dict(v=v, n=n, tag=tag, asha=asha, ravi=ravi, nisha=nisha, ken=ken, ap=ap, ap_me=ap_me, rp=rp, rp_me=rp_me)


def _make(api, org, who, p):
    return as_(api, org, who, "select pulse.connection_make(%s) r", (Jsonb(p),))[0]["r"]


def test_tables_stay_owner_only_and_widened(owner):
    for t in ("org_connection", "connect_share"):
        assert owner.execute("select has_table_privilege('pulse_api', %s, 'select') p", (f"pulse_priv.{t}",)).fetchone()["p"] is False
    src = owner.execute("select pg_get_constraintdef(oid) d from pg_constraint where conname='org_connection_kind_check'").fetchone()["d"]
    assert "'freelancer'" in src and "'cofounder'" in src


def test_making_reading_and_confirming_a_connection(world, api, owner):
    w = world; v, n = w["v"], w["n"]
    # Only admins, leadership and HR make one for a company; the owner for a personal space.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        _make(api, v.org, v.editor, {"kind": "client", "orgHandle": f"nature{w['tag']}"})
    r = _make(api, v.org, v.manager, {"kind": "client", "orgHandle": f"@nature{w['tag']}", "source": "backfill", "note": "synthetic backfill"})
    assert r["existed"] is False
    # Made twice: found, not made again.
    assert _make(api, v.org, v.manager, {"kind": "client", "orgHandle": f"nature{w['tag']}", "source": "backfill"}) == {"id": r["id"], "existed": True}
    here = as_(api, v.org, v.manager, "select pulse.connection_here() h")[0]["h"]
    row = next(x for x in here["direct"] if x["id"] == r["id"])
    assert row["status"] == "suggested" and row["mySide"] == "a" and row["b"]["org"] == str(n.org) and row["agreement"] == {"state": "none"}
    # The other company's admin sees it from inside her company, as side b; a plain member of V and a stranger do not.
    there = as_(api, n.org, n.manager, "select pulse.connection_here() h")[0]["h"]
    assert [x["mySide"] for x in there["direct"] if x["id"] == r["id"]] == ["b"]
    assert not [x for x in as_(api, v.org, v.editor2, "select pulse.connection_here() h")[0]["h"]["direct"] if x["id"] == r["id"]]
    assert as_(api, n.org, n.editor, "select pulse.connection_get(%s) d", (r["id"],))[0]["d"] is None
    # Side b cannot confirm; side a confirms, and a draft agreement is made at once (never sent).
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, n.org, n.manager, "select pulse.connection_confirm(%s,null)", (r["id"],))
    c = as_(api, v.org, v.manager, "select pulse.connection_confirm(%s,'synthetic: we work together') r", (r["id"],))[0]["r"]
    assert c["status"] == "active" and c["draft"]["state"] == "draft" and c["draft"]["made"] is True
    with owner.transaction():
        set_tenant(owner, v.org)
        k = owner.execute("select t.status, t.kind, s.notes from pulse.contract t join pulse.contract_side s on s.contract_id=t.id where t.id=%s", (c["draft"]["contract"],)).fetchone()
        parties = [x["role"] for x in owner.execute("select role from pulse.contract_party where contract_id=%s order by position", (c["draft"]["contract"],))]
        notes = [x["action"] for x in owner.execute("select action from pulse.audit_event where org_id=%s and resource='connection' and resource_id=%s order by at", (v.org, r["id"]))]
    assert k["status"] == "draft" and k["kind"] == "services" and "Nothing is sent until a person presses Send" in k["notes"]
    assert parties == ["provider", "client"]
    # Confirm and its draft are one transaction (one timestamp): compare as a set, made first.
    assert notes[0] == "connection.made" and sorted(notes) == sorted(["connection.made", "connection.confirmed", "connection.agreement_drafted"])
    # Drafting again keeps the one draft.
    again = as_(api, v.org, v.manager, "select pulse.connection_agreement_draft(%s) r", (r["id"],))[0]["r"]
    assert again["made"] is False and again["contract"] == c["draft"]["contract"]
    # The draft never reached the other company (drafts are not pushed).
    with owner.transaction():
        set_tenant(owner, n.org)
        assert owner.execute("select count(*) n from pulse.contract where org_id=%s", (n.org,)).fetchone()["n"] == 0


def test_seat_ties_for_a_company_admin(world, api):
    w = world; v = w["v"]
    here = as_(api, v.org, v.manager, "select pulse.connection_here() h")[0]["h"]
    assert [t["account"] for t in here["seats"]] == [str(w["ken"])] and here["seats"][0]["agreement"] == "none"
    # A member who is not a leader sees no seat ties.
    assert as_(api, v.org, v.editor, "select pulse.connection_here() h")[0]["h"]["seats"] == []


def test_a_task_given_across_lands_in_the_doers_own_space(world, api, owner):
    w = world
    r = _make(api, w["ap"], w["ap_me"], {"kind": "freelancer", "accountHandle": f"ravi{w['tag']}", "bRole": "Freelancer"})
    row = next(x for x in as_(api, w["ap"], w["ap_me"], "select pulse.connection_here() h")[0]["h"]["direct"] if x["id"] == r["id"])
    assert row["status"] == "active" and row["b"]["org"] == str(w["rp"]) and row["b"]["account"] == str(w["ravi"])
    g = as_(api, w["ap"], w["ap_me"], "select pulse.connection_task_give(%s,%s) r", (r["id"], Jsonb({"title": "Synthetic: draw the site plan", "dueOn": "2026-12-01"})))[0]["r"]
    assert g["landed"] == "theirs" and g["org"] == str(w["rp"])
    # In Ravi's space, as his own task, with Asha's guest seat as its reviewer.
    t = as_(api, w["rp"], w["rp_me"], "select id, title, assignee_person_id, review_owner_id from pulse.task where id=%s", (g["task"],))[0]
    assert t["assignee_person_id"] == w["rp_me"] and t["title"] == "Synthetic: draw the site plan"
    with owner.transaction():
        seat = owner.execute("select seat_person from pulse_priv.connect_seat where connection_id=%s and account_id=%s", (r["id"], w["asha"])).fetchone()["seat_person"]
        set_tenant(owner, w["rp"])
        assert owner.execute("select side from pulse.person where id=%s", (seat,)).fetchone()["side"] == "client"
    assert t["review_owner_id"] == seat
    # Both sides see it on the connection.
    for org, me in ((w["ap"], w["ap_me"]), (w["rp"], w["rp_me"])):
        d = as_(api, org, me, "select pulse.connection_get(%s) d", (r["id"],))[0]["d"]
        assert [(i["kind"], i["title"]) for i in d["items"] if i["kind"] == "task"] == [("task", "Synthetic: draw the site plan")]


def test_a_doc_shared_across_is_seen_only_through_the_share(world, api, owner):
    w = world; v, n = w["v"], w["n"]
    r = _make(api, v.org, v.manager, {"kind": "client", "orgHandle": f"nature{w['tag']}"})
    doc = uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, v.org)
        owner.execute("insert into pulse.doc(id,org_id,title,created_by) values(%s,%s,'Synthetic proposal for Nature',%s)", (doc, v.org, v.manager))
        other = uuid.uuid4()
        owner.execute("insert into pulse.doc(id,org_id,title,created_by,access) values(%s,%s,'Synthetic company handbook',%s,'company')", (other, v.org, v.manager))
    # Without a contact on the other side, a handle is needed; with Nisha named it goes to her guest seat in V.
    s = as_(api, v.org, v.manager, "select pulse.connection_doc_share(%s,%s,'comment',%s) r", (r["id"], doc, f"nisha{w['tag']}"))[0]["r"]
    seat = s["seat"]
    with owner.transaction():
        set_tenant(owner, v.org)
        share = owner.execute("select can_edit, can_comment from pulse.doc_share where doc_id=%s and person_id=%s", (doc, seat)).fetchone()
    assert share == {"can_edit": False, "can_comment": True}
    # As her guest seat in V: that doc only (not the company handbook), and not editable.
    seen = as_(api, v.org, seat, "select id from pulse.doc")
    assert [x["id"] for x in seen] == [doc]
    assert as_(api, v.org, seat, "select pulse.doc_id_can_edit(%s) e", (doc,))[0]["e"] is False
    # Her side sees it on the connection, from her own company.
    d = as_(api, n.org, n.manager, "select pulse.connection_get(%s) d", (r["id"],))[0]["d"]
    assert [(i["kind"], i["title"], i["access"]) for i in d["items"] if i["kind"] == "doc"] == [("doc", "Synthetic proposal for Nature", "comment")]
    # Stop sharing: gone for the guest seat; the ledger keeps the history.
    as_(api, v.org, v.manager, "select pulse.connection_doc_unshare(%s,%s)", (r["id"], doc))
    assert as_(api, v.org, seat, "select id from pulse.doc") == []
    d = as_(api, v.org, v.manager, "select pulse.connection_get(%s) d", (r["id"],))[0]["d"]
    assert [i["revokedAt"] is not None for i in d["items"] if i["kind"] == "doc"] == [True]


def test_ai_helpers_read_as_their_person_and_change_nothing(world, api, owner, worker):
    w = world; v = w["v"]
    r = _make(api, v.org, v.manager, {"kind": "client", "orgHandle": f"nature{w['tag']}"})
    ai = person(worker, v.org, "Synthetic AI helper", side="agent")
    with owner.transaction():
        set_tenant(owner, v.org)
        owner.execute("""insert into pulse.agent_member(org_id,person_id,owner_person_id,employee_no,employee_id)
            values(%s,%s,%s,(select coalesce(max(employee_no),0)+1 from pulse.agent_member where org_id=%s),%s)""", (v.org, ai, v.manager, v.org, f"{v.code}-AI-{uuid.uuid4().hex[:4]}"))

    def as_ai(sql, args=()):
        with api.transaction():
            set_tenant(api, v.org, ai)
            api.execute("select set_config('pulse.agent_session','on',true)")
            return api.execute(sql, args).fetchall()
    here = as_ai("select pulse.connection_here() h")[0]["h"]
    assert [x["id"] for x in here["direct"]] == [r["id"]]
    for sql, args in (("select pulse.connection_confirm(%s,null)", (r["id"],)), ("select pulse.connection_agreement_draft(%s)", (r["id"],)),
                      ("select pulse.connection_end(%s,'x')", (r["id"],)), ("select pulse.connection_make(%s)", (Jsonb({"kind": "client", "orgHandle": f"nature{w['tag']}"}),))):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_ai(sql, args)


def test_ending_closes_the_shares_and_keeps_the_history(world, api, owner):
    w = world; v, n = w["v"], w["n"]
    r = _make(api, v.org, v.manager, {"kind": "client", "orgHandle": f"nature{w['tag']}"})
    doc = uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, v.org)
        owner.execute("insert into pulse.doc(id,org_id,title,created_by) values(%s,%s,'Synthetic scope',%s)", (doc, v.org, v.manager))
    seat = as_(api, v.org, v.manager, "select pulse.connection_doc_share(%s,%s,'edit',%s) r", (r["id"], doc, f"nisha{w['tag']}"))[0]["r"]["seat"]
    assert as_(api, v.org, seat, "select pulse.doc_id_can_edit(%s) e", (doc,))[0]["e"] is True
    # The other side may end it too.
    as_(api, n.org, n.manager, "select pulse.connection_end(%s,'synthetic: the work is done')", (r["id"],))
    assert as_(api, v.org, seat, "select id from pulse.doc") == []
    d = as_(api, v.org, v.manager, "select pulse.connection_get(%s) d", (r["id"],))[0]["d"]
    assert d["status"] == "ended" and d["endReason"] == "synthetic: the work is done" and d["agreement"]["state"] == "ended"
    assert any(a["action"] == "connection.ended" for a in d["activity"])
    # Giving work through an ended connection is refused.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, v.org, v.manager, "select pulse.connection_task_give(%s,%s)", (r["id"], Jsonb({"title": "Synthetic late work", "toHandle": f"nisha{w['tag']}"})))


def test_ai_never_sends_or_signs_an_agreement(world, api, owner, worker):
    w = world; v = w["v"]
    r = _make(api, v.org, v.manager, {"kind": "client", "orgHandle": f"nature{w['tag']}"})
    cid = as_(api, v.org, v.manager, "select pulse.connection_agreement_draft(%s) r", (r["id"],))[0]["r"]["contract"]
    ai = person(worker, v.org, "Synthetic AI helper", side="agent")
    with owner.transaction():
        set_tenant(owner, v.org)
        owner.execute("""insert into pulse.agent_member(org_id,person_id,owner_person_id,employee_no,employee_id)
            values(%s,%s,%s,(select coalesce(max(employee_no),0)+1 from pulse.agent_member where org_id=%s),%s)""", (v.org, ai, v.manager, v.org, f"{v.code}-AI-{uuid.uuid4().hex[:4]}"))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with owner.transaction():
            set_tenant(owner, v.org, ai)
            owner.execute("select set_config('pulse.agent_session','on',true)")
            owner.execute("update pulse.contract set status='proposed' where id=%s", (cid,))


def test_a_freelancer_in_my_personal_space_gets_a_draft(world, api, owner):
    """Asha's own space hires Ken (no space of his own): the draft is in her space, Asha as the client, Ken the provider."""
    w = world
    r = _make(api, w["ap"], w["ap_me"], {"kind": "freelancer", "accountHandle": f"ken{w['tag']}", "bRole": "Designer"})
    d = as_(api, w["ap"], w["ap_me"], "select pulse.connection_agreement_draft(%s) r", (r["id"],))[0]["r"]
    assert d["state"] == "draft" and d["made"] is True
    with owner.transaction():
        set_tenant(owner, w["ap"])
        parties = owner.execute("select kind, role, party_person_id, party_account from pulse.contract_party where contract_id=%s order by position", (d["contract"],)).fetchall()
    assert [(p["kind"], p["role"]) for p in parties] == [("person", "client"), ("person", "provider")]
    assert parties[0]["party_person_id"] == w["ap_me"] and parties[1]["party_account"] == w["ken"]


def test_a_side_acts_only_from_inside_its_own_space(world, api):
    """Asha sees her personal connection from company V too, but acts on it only from her own space."""
    w = world
    r = _make(api, w["ap"], w["ap_me"], {"kind": "freelancer", "accountHandle": f"ken{w['tag']}"})
    row = next(x for x in as_(api, w["v"].org, w["v"].manager, "select pulse.connection_here() h")[0]["h"]["direct"] if x["id"] == r["id"])
    assert row["mySide"] is None
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w["v"].org, w["v"].manager, "select pulse.connection_agreement_draft(%s)", (r["id"],))
