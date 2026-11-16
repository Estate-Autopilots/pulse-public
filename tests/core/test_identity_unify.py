"""IDENTITY-UNIFY (1746): one person, one @handle in every company. Every seat of a Pulse account takes the account's
handle as its username, the old username stays an alias in that company (sign-in, codes, Forgot your password, old
@mentions), a handle change, a new seat and a merge are followed, nobody is renamed for someone else, an AI employee
is never renamed, and the person sees their whole profile (career too) in every company. Synthetic tenants and
obviously fake people only."""
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from helpers import build_world
from test_account_security import command, hashof

PW = "Synthetic-unify-pass-2026!"
ACCOUNTS = Path(__file__).resolve().parents[2] / "tools/consolidate/pulse-accounts.py"


def profile(worker, w, person, username, email=None):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.people_profile(org_id, person_id, role, evidence, username, email)
                          values (%s,%s,'Video editor','Synthetic fixture',%s,%s)""", (w.org, person, username, email))


def password(owner, api, worker, w, person):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01') on conflict do nothing", (w.org, w.manager))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.login_issue(%s,%s)", (person, PW))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.login_credential set must_change=false where person_id=%s", (person,))


def account(owner, handle, *seats, name="Fake Unified Person", email=None):
    acct = uuid.uuid4()
    with owner.transaction():
        owner.execute("insert into pulse_priv.pulse_account(id,handle,display_name,email,email_verified_at) values(%s,%s,%s,%s,case when %s::text is not null then now() end)",
                      (acct, handle, name, email, email))
        owner.execute("insert into pulse_priv.handle_name(handle,kind,ref) values(%s,'person',%s)", (handle, acct))
        for w, person in seats:
            owner.execute("insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,'staff')", (acct, w.org, person))
    return acct


def username(worker, w, person):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select username from pulse.people_profile where person_id=%s", (person,)).fetchone()["username"]


def tag():
    return uuid.uuid4().hex[:8]


@pytest.fixture
def three(worker, owner, api):
    """Fake Alpha / Beta / Gamma: one human with a seat in each under three different usernames."""
    a, b, c = (build_world(worker, owner, api) for _ in range(3))
    t = tag()
    olds = {a.org: f"fake{t}", b.org: f"fake{t}123", c.org: f"fake.{t}.person"}
    for w in (a, b, c):
        profile(worker, w, w.editor, olds[w.org])
        profile(worker, w, w.editor2, f"colleague.{tag()}")
    h = f"fake{t}"
    acct = account(owner, h, (a, a.editor), (b, b.editor), (c, c.editor))
    return a, b, c, h, acct, olds


def test_alias_table_forces_row_security_with_a_tenant_policy(worker):
    r = worker.execute("""select c.relrowsecurity rls, c.relforcerowsecurity force,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname='person_username_alias'""").fetchone()
    assert (r["rls"], r["force"], r["tenant"]) == (True, True, True)


def test_every_seat_shows_the_one_handle_and_keeps_the_old_name(worker, owner, three):
    a, b, c, h, _, olds = three
    for w in (a, b, c):
        assert username(worker, w, w.editor) == h
        assert username(worker, w, w.editor2).startswith("colleague."), "a colleague is never renamed"
    for w in (b, c):
        with owner.transaction():
            set_tenant(owner, w.org)
            assert [r["username"] for r in owner.execute("select username from pulse.person_username_alias where person_id=%s", (w.editor,))] == [olds[w.org]]
            ch = owner.execute("select old_value, new_value from pulse.record_change where entity_id=%s and field='username'", (w.editor,)).fetchone()
            assert (ch["old_value"], ch["new_value"]) == (olds[w.org], h), "the rename is in the company's record history"
    with owner.transaction():
        set_tenant(owner, a.org)
        assert owner.execute("select count(*) n from pulse.person_username_alias where person_id=%s", (a.editor,)).fetchone()["n"] == 0, "already the handle: nothing to keep"


def test_old_usernames_still_sign_in_at_the_company_and_the_shared_address(worker, owner, api, three):
    a, b, c, h, _, olds = three
    password(owner, api, worker, b, b.editor)
    # The company's own address: the old name (any case) and the handle read as today's username; "@name" stays the
    # Pulse account's (the account sign-in reads it).
    for typed in (olds[b.org], h, olds[b.org].upper()):
        assert command(api, b, "pulse.auth_login_name('staff',%s)", (typed,)) == h
    assert command(api, b, "pulse.auth_login_name('staff',%s)", ("@" + olds[b.org],)) == "@" + olds[b.org]
    ok = command(api, b, "pulse.auth_login('staff',pulse.auth_login_name('staff',%s),%s,%s,%s,false,'Browser')",
                 (olds[b.org], PW, hashof("ch" + tag()), hashof("se" + tag())))
    assert not ok.get("failed") and ok["actor"] == str(b.editor)
    # Another company's old name is not a name here.
    assert command(api, a, "pulse.auth_login_name('staff',%s)", (olds[c.org],)) == olds[c.org]
    # The shared address and the e-mailed code: an old name of one account is that account's handle.
    for typed in (olds[b.org], olds[c.org], h):
        assert command(api, a, "pulse.login_alias(%s)", (typed,)) == h
    assert command(api, a, "pulse.login_alias(%s)", ("@" + olds[c.org],)) == "@" + h, "an @name stays an @name"
    # Anything else comes back exactly as typed (an e-mail, an unknown name, an old handle that is now someone's username).
    assert command(api, a, "pulse.login_alias(%s)", ("Fake.Person@Example.test",)) == "Fake.Person@Example.test"
    unknown = "@Nobody" + tag()
    assert command(api, a, "pulse.login_alias(%s)", (unknown,)) == unknown
    # Forgot your password / the staff code read the old name the same way; an e-mail stays exactly as typed.
    assert command(api, b, "pulse.auth_old_name('staff',%s)", (olds[b.org],)) == h
    assert command(api, b, "pulse.auth_old_name('staff',%s)", ("Someone@Example.test",)) == "Someone@Example.test"
    assert command(api, b, "pulse.auth_old_name('staff',%s)", ("@" + olds[b.org],)) == "@" + olds[b.org]
    # An old name from another company: the staff code here finds the person's seat here; the account code finds the
    # account when nobody here has the name (the staff code goes first, as LOGIN-OTP set it).
    assert command(api, a, "pulse.auth_old_name('staff',%s)", (olds[c.org],)) == h
    d = build_world(worker, owner, api)
    assert command(api, d, "pulse.account_code_login(%s)", (olds[c.org],)) == h
    assert command(api, d, "pulse.account_code_login(%s)", ("@" + h,)) == "@" + h


def test_someone_using_the_old_name_today_keeps_it(worker, owner, api, three):
    a, b, c, h, _, olds = three
    # A new hire in Gamma is given Beta's old username: in Gamma and at the shared address it is theirs now.
    newcomer = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, c.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Fake Newcomer','staff')", (newcomer, c.org))
    profile(worker, c, newcomer, olds[b.org])
    assert command(api, c, "pulse.auth_login_name('staff',%s)", (olds[b.org],)) == olds[b.org]
    assert command(api, a, "pulse.login_alias(%s)", (olds[b.org],)) == olds[b.org]
    assert command(api, b, "pulse.auth_login_name('staff',%s)", (olds[b.org],)) == h, "in Beta it is still the person's old name"


def test_a_handle_change_moves_every_seat_and_the_old_handle_still_works(worker, api, three):
    a, b, c, h, _, _ = three
    new = "fake.renamed." + tag()
    command(api, a, "pulse.account_claim(%s,null)", (new,), a.editor)
    for w in (a, b, c):
        assert username(worker, w, w.editor) == new
    assert command(api, a, "pulse.auth_login_name('staff',%s)", (h,)) == new
    assert command(api, b, "pulse.login_alias(%s)", (h,)) == new
    names = command(api, b, "pulse.account_names()", (), b.editor)
    assert names["handle"] == new and h in names["old"] and names["kept"] == []


def test_a_clash_keeps_the_seat_own_name_and_says_where(worker, owner, api):
    a, b = build_world(worker, owner, api), build_world(worker, owner, api)
    h = "fakeclash" + tag()
    profile(worker, a, a.editor, h + ".a")
    profile(worker, b, b.editor, h + ".b")
    profile(worker, b, b.editor2, h)  # someone else in Beta already has the handle as username
    account(owner, h, (a, a.editor), (b, b.editor))
    assert username(worker, a, a.editor) == h
    assert username(worker, b, b.editor) == h + ".b"
    assert username(worker, b, b.editor2) == h, "nobody is renamed for another person"
    names = command(api, a, "pulse.account_names()", (), a.editor)
    assert names["kept"] == [{"company": f"Synthetic {b.code}", "username": h + ".b"}]
    # At Beta's address the handle is the other person's username: it stays theirs (their own seat's name is h.b).
    assert command(api, b, "pulse.auth_login_name('staff',%s)", (h,)) == h
    assert command(api, b, "pulse.auth_login_name('staff',%s)", (h + ".b",)) == h + ".b"


def test_a_new_seat_and_a_profile_made_later_take_the_handle(worker, owner, api, three):
    a, _, _, h, acct, _ = three
    d = build_world(worker, owner, api)
    with owner.transaction():
        owner.execute("insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,'staff')", (acct, d.org, d.editor))
    profile(worker, d, d.editor, "fake.generated." + tag())  # the company makes the profile row after the seat
    assert username(worker, d, d.editor) == h


def test_an_ai_employee_seat_is_never_renamed(worker, owner, api):
    a = build_world(worker, owner, api)
    bot = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, a.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Fake AI Helper','agent')", (bot, a.org))
    profile(worker, a, bot, "fake.ai." + tag())
    before = username(worker, a, bot)
    account(owner, "fakebot" + tag(), (a, bot))
    assert username(worker, a, bot) == before


def test_a_merge_gives_the_moved_seat_the_kept_handle(worker, owner, api):
    a, b = build_world(worker, owner, api), build_world(worker, owner, api)
    keep_h, drop_h = "fakekeep" + tag(), "fakedrop" + tag()
    profile(worker, a, a.editor, keep_h)
    profile(worker, b, b.editor, drop_h + ".seat")
    keep = account(owner, keep_h, (a, a.editor))
    drop = account(owner, drop_h, (b, b.editor))
    assert username(worker, b, b.editor) == drop_h
    with owner.transaction():
        owner.execute("select pulse.account_merge(%s,%s,%s,%s)", (keep, drop, keep_h, "test (synthetic)"))
    assert username(worker, b, b.editor) == keep_h
    for old in (drop_h, drop_h + ".seat"):
        assert command(api, a, "pulse.login_alias(%s)", (old,)) == keep_h
        assert command(api, b, "pulse.auth_login_name('staff',%s)", (old,)) == keep_h


def test_the_person_sees_their_career_everywhere_and_others_only_when_shared(api, three):
    a, b, _, _, _, _ = three
    mine = command(api, b, "pulse.account_card(%s)", (b.editor,), b.editor)
    assert mine["self"] is True and isinstance(mine["career"], list) and len(mine["career"]) == 3
    theirs = command(api, b, "pulse.account_card(%s)", (b.editor,), b.editor2)
    assert theirs["self"] is False and theirs["career"] is None and theirs["contact"] is None


def test_a_company_reads_only_its_own_old_names(api, three):
    a, b, _, _, _, _ = three
    with api.transaction():
        set_tenant(api, a.org, a.editor2)
        orgs = {r["org_id"] for r in api.execute("select org_id from pulse.person_username_alias")}
    assert orgs <= {a.org}
    with api.transaction():
        set_tenant(api, b.org, b.editor2)
        assert api.execute("select count(*) n from pulse.person_username_alias where person_id=%s", (b.editor,)).fetchone()["n"] == 1


def letters():
    return uuid.uuid4().hex[:8].translate(str.maketrans("0123456789", "ghijklmnop"))


def test_the_audit_finds_a_shared_email_and_a_same_name_duplicate(worker, owner, api, tmp_path):
    with psycopg.connect(os.environ["PULSE_CI_DATABASE_URL"], autocommit=True) as c:
        if not c.execute("select rolsuper from pg_roles where rolname = current_user").fetchone()[0]:
            pytest.skip("the accounts tool reads every company as the database superuser (as on the server)")
    a, b, c = (build_world(worker, owner, api) for _ in range(3))
    t = letters()
    # The 28 Oct case: a person's account has their e-mail; a second company typed the same e-mail and an e-mail-less
    # second account was made for them.
    email = f"fake.dup.{t}@example.test"
    profile(worker, a, a.editor, f"fakedup{t}", email)
    profile(worker, b, b.editor, f"fake.dup.{t}", email)
    keep = account(owner, f"fakedup{t}", (a, a.editor), email=email)
    drop = account(owner, f"fakeduptwo{t}", (b, b.editor))
    # Two accounts with the same name, one without any e-mail, in different companies.
    profile(worker, a, a.editor2, f"faketwin{t}")
    profile(worker, c, c.editor, f"fake.twin.{t}")
    twin1 = account(owner, f"faketwin{t}", (a, a.editor2), name=f"Fake Twin {t}", email=f"fake.twin.{t}@example.test")
    twin2 = account(owner, f"faketwintwo{t}", (c, c.editor), name=f"Fake Twin {t}")
    db = os.environ["PULSE_CI_DATABASE_URL"]
    run = subprocess.run([sys.executable, str(ACCOUNTS), "audit", "--exec", "", "--db-user", "", "--database", db, "--out-dir", str(tmp_path)],
                         capture_output=True, text=True, check=False, timeout=300)
    assert run.returncode in (0, 3), run.stdout + run.stderr
    assert f"keep @fakedup{t} -> username @fakedup{t}; merge @fakeduptwo{t} (1 seat(s))" in run.stdout
    assert email not in run.stdout, "e-mails are never printed"
    plan = json.loads(next(tmp_path.glob("audit-plan-*.json")).read_text())
    review = json.loads(next(tmp_path.glob("audit-review-*.json")).read_text())
    mine = [e for e in plan if e["keep"]["id"] == str(keep)]
    assert len(mine) == 1 and [d["id"] for d in mine[0]["drop"]] == [str(drop)] and mine[0]["same_org"] == []
    twins = [e for e in review if {e["keep"]["id"], *[d["id"] for d in e["drop"]]} == {str(twin1), str(twin2)}]
    assert len(twins) == 1 and twins[0]["keep"]["id"] == str(twin1), "the account with the e-mail is kept"
    assert not [e for e in plan if e["keep"]["id"] in (str(twin1), str(twin2))], "a name alone never goes in the ready plan"
    assert oct(next(tmp_path.glob("audit-plan-*.json")).stat().st_mode & 0o777) == "0o600"
    # The ready plan is what merge reads: its dry run merges exactly that pair and rolls back.
    dry = subprocess.run([sys.executable, str(ACCOUNTS), "merge", "--exec", "", "--db-user", "", "--database", db, "--out-dir", str(tmp_path),
                          "--plan", str(next(tmp_path.glob("audit-plan-*.json"))), "--only", f"fakedup{t}"],
                         capture_output=True, text=True, check=False, timeout=300)
    assert dry.returncode == 0 and "DRY RUN (rolled back): 1 account(s) merged, 1 seat(s) moved" in dry.stdout, dry.stdout + dry.stderr
    with owner.transaction():
        assert owner.execute("select count(*) n from pulse_priv.pulse_account where id = %s", (drop,)).fetchone()["n"] == 1
