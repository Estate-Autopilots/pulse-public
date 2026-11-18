"""PROFILE-UNIFY (1683): one person, one profile across every company. The account's own details are inherited by every
seat (and an edit in any company travels), a company's own work record stays its own, My career is the person's alone,
the resume link shows only the chosen sections, and moving company keeps the old seat as alumni. Synthetic tenants and
obviously fake people only."""
import json
import random
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from helpers import build_world

PNG_A = b"\x89PNG\r\n\x1a\nSYNTHETIC-PHOTO-A"
PNG_B = b"\x89PNG\r\n\x1a\nSYNTHETIC-PHOTO-B"
LINK = "f" * 64


def run(conn, w, who, sql, args=()):
    with conn.transaction():
        set_tenant(conn, w.org, who)
        cur = conn.execute(sql, args)
        return cur.fetchall() if cur.description else []


def one(conn, w, who, sql, args=()):
    rows = run(conn, w, who, sql, args)
    return rows[0] if rows else None


def profile_row(worker, w, person, **extra):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.people_profile(org_id, person_id, role, evidence, username, user_no, department, notes)
                          values (%s,%s,%s,'Synthetic fixture',%s,%s,%s,%s) on conflict (person_id) do nothing""",
                       (w.org, person, extra.get("role", "Video editor"), f"fake.{uuid.uuid4().hex[:10]}", random.randint(1000, 999999),
                        extra.get("department"), extra.get("notes")))


def make_account(owner, handle):
    acct = uuid.uuid4()
    with owner.transaction():
        owner.execute("insert into pulse_priv.pulse_account(id,handle,display_name) values(%s,%s,%s)", (acct, handle, f"Fake {handle}"))
        owner.execute("insert into pulse_priv.handle_name(handle,kind,ref) values(%s,'person',%s)", (handle, acct))
    return acct


def seat(owner, w, person, acct, kind="staff"):
    with owner.transaction():
        owner.execute("insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,%s)", (acct, w.org, person, kind))


def make_admin(worker, w, person):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (w.org, person))


def handle():
    return "fake" + uuid.uuid4().hex[:12]


@pytest.fixture
def two(worker, owner, api):
    a = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    for w in (a, b):
        for p in (w.editor, w.editor2, w.lead, w.manager):
            profile_row(worker, w, p)
        make_admin(worker, w, w.manager)
    acct = make_account(owner, handle())
    seat(owner, a, a.editor, acct)
    seat(owner, b, b.editor, acct)
    return a, b, acct


def seat_view(worker, w, person):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("""select p.display_name, pp.pronouns, pp.about, pp.languages, pp.skills,
                                        (select bytes from pulse.person_photo ph where ph.person_id = p.id) photo
                                   from pulse.person p join pulse.people_profile pp on pp.person_id = p.id where p.id = %s""", (person,)).fetchone()


def test_account_alumni_forces_row_security_with_a_tenant_policy(worker):
    r = worker.execute("""select c.relrowsecurity rls, c.relforcerowsecurity force,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname='account_alumni'""").fetchone()
    assert (r["rls"], r["force"], r["tenant"]) == (True, True, True)


def test_profile_saved_once_is_inherited_by_every_seat(api, worker, two):
    a, b, _ = two
    one(api, a, a.editor, "select pulse.account_profile_save(%s) p", (Jsonb({
        "name": "Fake Person Unified", "pronouns": "they/them", "about": "Synthetic bio for a fake person.", "headline": "Fake editor",
        "languages": ["English", "Hindi"], "skills": ["Reels", "Colour"], "skillLevels": {"Reels": 4},
        "education": [{"school": "Example Institute of Testing", "degree": "Fake degree"}]}),))
    for w in (a, b):
        v = seat_view(worker, w, w.editor)
        assert v["display_name"] == "Fake Person Unified"
        assert (v["pronouns"], v["about"], v["languages"], sorted(v["skills"])) == ("they/them", "Synthetic bio for a fake person.", ["English", "Hindi"], ["Colour", "Reels"])
    # The company's own work record is untouched (role and department stay per company).
    with worker.transaction():
        set_tenant(worker, b.org)
        assert worker.execute("select role from pulse.people_profile where person_id=%s", (b.editor,)).fetchone()["role"] == "Video editor"


def test_photo_changed_once_changes_everywhere_and_a_company_override_stays_local(api, worker, two):
    a, b, _ = two
    run(api, a, a.editor, "insert into pulse.person_photo(org_id,person_id,mime,bytes,updated_by) values(%s,%s,'image/png',%s,%s)", (a.org, a.editor, PNG_A, a.editor))
    assert bytes(seat_view(worker, b, b.editor)["photo"]) == PNG_A
    # HR or an admin setting a colleague's photo in one company does not travel.
    run(api, b, b.manager, "update pulse.person_photo set bytes=%s, updated_by=%s where person_id=%s", (PNG_B, b.manager, b.editor))
    assert bytes(seat_view(worker, a, a.editor)["photo"]) == PNG_A
    # The person removing their own photo removes it everywhere.
    run(api, a, a.editor, "delete from pulse.person_photo where person_id=%s", (a.editor,))
    assert seat_view(worker, b, b.editor)["photo"] is None


def test_an_edit_on_my_own_profile_in_one_company_travels_to_the_others(worker, owner, two):
    a, b, acct = two
    with owner.transaction():
        set_tenant(owner, b.org, b.editor)
        owner.execute("update pulse.people_profile set pronouns='she/her', skills=array['Motion'] where person_id=%s", (b.editor,))
    v = seat_view(worker, a, a.editor)
    assert (v["pronouns"], v["skills"]) == ("she/her", ["Motion"])
    # An admin editing someone else's record keeps it local.
    with owner.transaction():
        set_tenant(owner, b.org, b.manager)
        owner.execute("update pulse.people_profile set pronouns='he/him' where person_id=%s", (b.editor,))
    assert seat_view(worker, a, a.editor)["pronouns"] == "she/her"


def test_a_new_seat_gets_the_profile_at_once(api, worker, owner, two):
    a, b, acct = two
    one(api, a, a.editor, "select pulse.account_profile_save(%s) p", (Jsonb({"pronouns": "xe/xem", "skills": ["Editing"]}),))
    run(api, a, a.editor, "insert into pulse.person_photo(org_id,person_id,mime,bytes,updated_by) values(%s,%s,'image/png',%s,%s)", (a.org, a.editor, PNG_A, a.editor))
    c = build_world(worker, owner, api)
    profile_row(worker, c, c.editor)
    seat(owner, c, c.editor, acct)
    v = seat_view(worker, c, c.editor)
    assert (v["pronouns"], v["skills"], bytes(v["photo"])) == ("xe/xem", ["Editing"], PNG_A)


def test_company_a_never_sees_company_b_private_data(api, worker, owner, two):
    a, b, acct = two
    with owner.transaction():
        set_tenant(owner, b.org)
        owner.execute("update pulse.people_profile set notes='FAKE-B-HR-NOTE' where person_id=%s", (b.editor,))
        owner.execute("insert into pulse.task(org_id,title,status,assignee_person_id,done_at) values(%s,'FAKE-B-INTERNAL-TASK','done',%s,now())", (b.org, b.editor))
    one(api, a, a.editor, "select pulse.account_profile_save(%s) p", (Jsonb({"contactEmail": "fake.person@example.test", "headline": "Fake headline"}),))
    card = one(api, a, a.manager, "select pulse.account_card(%s) c", (a.editor,))["c"]
    text = json.dumps(card)
    assert card["headline"] == "Fake headline"
    assert "FAKE-B" not in text and card["contact"] is None and card["career"] is None
    # The person publishes their career and contact to A: roles and dates only, never B's counts, notes or tasks.
    one(api, a, a.editor, "select pulse.account_share_save(%s) p", (Jsonb({"org": str(a.org), "career": True, "contact": True}),))
    card = one(api, a, a.manager, "select pulse.account_card(%s) c", (a.editor,))["c"]
    text = json.dumps(card)
    assert card["contact"]["email"] == "fake.person@example.test"
    assert {c["company"] for c in card["career"]} == {f"Synthetic {a.code}", f"Synthetic {b.code}"}
    assert "FAKE-B" not in text and "tasksDone" not in text and "contracts" not in text
    # Only the person reads the full career; A's admin calling it gets their own (no seat in B).
    mine = one(api, a, a.editor, "select pulse.account_career() r", ())["r"]["career"]
    assert {c["company"]: c["tasksDone"] for c in mine}[f"Synthetic {b.code}"] == 1
    theirs = one(api, a, a.manager, "select pulse.account_career() r", ())["r"]["career"]
    assert [c["company"] for c in theirs] == [f"Synthetic {a.code}"]
    # Row security: inside A nothing of B's records is readable, and the account tables are closed to the API role.
    assert run(api, a, a.manager, "select notes from pulse.people_profile where person_id=%s", (b.editor,)) == []
    assert run(api, a, a.manager, "select id from pulse.task where title='FAKE-B-INTERNAL-TASK'") == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        run(api, a, a.editor, "select about from pulse_priv.account_profile")


def test_resume_link_is_off_by_default_and_shows_only_the_chosen_sections(api, two):
    a, b, _ = two
    one(api, a, a.editor, "select pulse.account_profile_save(%s) p", (Jsonb({"about": "Fake about", "contactEmail": "fake.person@example.test", "skills": ["Reels"]}),))
    assert one(api, a, a.editor, "select pulse.account_resume_get() r")["r"]["shareOn"] is False
    assert one(api, a, None, "select pulse.resume_public(%s) r", (LINK,))["r"] is None
    one(api, a, a.editor, "select pulse.account_resume_save(%s,%s) r", (Jsonb({"sections": ["about", "experience", "skills"], "share": "new"}), LINK))
    r = one(api, a, None, "select pulse.resume_public(%s) r", (LINK,))["r"]
    assert r["about"] == "Fake about" and r["skills"] == ["Reels"] and "contact" not in r
    assert {x["company"] for x in r["experience"]} == {f"Synthetic {a.code}", f"Synthetic {b.code}"}
    assert all("tasksDone" not in x for x in r["experience"])
    one(api, a, a.editor, "select pulse.account_resume_save(%s,null) r", (Jsonb({"share": "off"}),))
    assert one(api, a, None, "select pulse.resume_public(%s) r", (LINK,))["r"] is None


def test_moving_company_carries_the_profile_and_keeps_the_old_seat_as_alumni(api, worker, owner):
    a = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    for w in (a, b):
        for p in (w.editor, w.manager):
            profile_row(worker, w, p)
        make_admin(worker, w, w.manager)
    boss = make_account(owner, handle())
    seat(owner, a, a.manager, boss)
    seat(owner, b, b.manager, boss)
    mover = make_account(owner, handle())
    seat(owner, a, a.editor, mover)
    one(api, a, a.editor, "select pulse.account_profile_save(%s) p", (Jsonb({"pronouns": "they/them", "skills": ["Reels"]}),))
    # A member cannot invite anyone elsewhere; the admin of both companies can.
    assert one(api, a, a.editor2, "select pulse.account_invite_targets(%s) r", (a.editor,))["r"]["targets"] == []
    targets = one(api, a, a.manager, "select pulse.account_invite_targets(%s) r", (a.editor,))["r"]["targets"]
    assert [t["id"] for t in targets] == [str(b.org)]
    inv = one(api, a, a.manager, "select pulse.account_invite_elsewhere(%s,%s,'Fake editor',true) r", (a.editor, b.org))["r"]
    moves = one(api, a, a.editor, "select pulse.account_career() r")["r"]["moves"]
    assert [m["id"] for m in moves] == [inv["id"]]
    r = one(api, a, a.editor, "select pulse.org_invite_accept(%s,null,%s,'Synthetic device') r", (inv["id"], "e" * 64))["r"]
    assert r["org"] == str(b.org) and r["movedFrom"] == f"Synthetic {a.code}"
    new_person = uuid.UUID(r["person"])
    v = seat_view(worker, b, new_person)
    assert (v["pronouns"], v["skills"]) == ("they/them", ["Reels"])
    with worker.transaction():
        set_tenant(worker, b.org)
        assert worker.execute("select role from pulse.people_profile where person_id=%s", (new_person,)).fetchone()["role"] == "Fake editor"
    with worker.transaction():
        set_tenant(worker, a.org)
        assert worker.execute("select status from pulse.person where id=%s", (a.editor,)).fetchone()["status"] == "offboarded"
    with owner.transaction():
        set_tenant(owner, a.org)
        al = owner.execute("select how, moved_to from pulse.account_alumni where person_id=%s", (a.editor,)).fetchone()
        assert (al["how"], al["moved_to"]) == ("moved", b.org)
    career = one(api, b, new_person, "select pulse.account_career() r")["r"]["career"]
    assert [(c["company"], c["current"], c["how"]) for c in career] == [(f"Synthetic {b.code}", True, None), (f"Synthetic {a.code}", False, "moved")]
