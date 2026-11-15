"""CONSOLIDATION (1535, tools/consolidate): one Pulse for every organisation, one account per human (synthetic only).

- pulse.handle_check answers only available / taken / invalid, and a handle kept as a redirect after a merge is taken;
- pulse.account_merge moves every seat and every row that points at the dropped account, keeps one username, keeps
  every old handle pointing at the merged account, refuses two seats in one organisation unless told to unlink, and
  pulse.account_unmerge puts it all back from the record;
- pulse.account_merge_candidates groups accounts and people by a verified e-mail only;
- tools/consolidate/pulse-org-move.py imports an organisation idempotently: dry run first, ids the target already
  uses remapped everywhere (uuid columns and ids inside text), the members' accounts joined, and the same bundle
  twice is one move.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

import psycopg
import pytest
from helpers import build_world, new_code
from pulse_sdk.db import set_tenant

ROOT = Path(__file__).resolve().parents[2]
ORG_MOVE = ROOT / "tools/consolidate/pulse-org-move.py"
ACCOUNTS = ROOT / "tools/consolidate/pulse-accounts.py"


def _handle() -> str:
    return "syn" + uuid.uuid4().hex[:10]


def _account(owner, handle, *, email=None, verified=False, password=None, last_org=None):
    aid = uuid.uuid4()
    with owner.transaction():
        owner.execute(
            """insert into pulse_priv.pulse_account(id, handle, display_name, email, email_verified_at, password_hash, last_org)
               values (%s, %s, 'Synthetic Human', %s, case when %s then now() end,
                       case when %s::text is null then null else crypt(%s, gen_salt('bf', 4)) end, %s)""",
            (aid, handle, email, verified, password, password, last_org))
        owner.execute("insert into pulse_priv.handle_name(handle, kind, ref) values (%s, 'person', %s)", (handle, aid))
    return aid


def _seat(owner, account, org, person):
    with owner.transaction():
        owner.execute("insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (%s, %s, %s, 'staff')",
                      (account, org, person))


def test_handle_check_says_only_available_taken_or_invalid(api, owner, worker):
    w = build_world(worker, owner, api)
    h = _handle()
    _account(owner, h)
    with owner.transaction():
        set_tenant(owner, w.org)
        org_handle = owner.execute("select handle from pulse.org where id = %s", (w.org,)).fetchone()
    with api.transaction():
        set_tenant(api, w.org)
        said = {x: api.execute("select pulse.handle_check(%s) s", (x,)).fetchone()["s"]
                for x in (h, "@" + h.upper(), _handle(), "ab", "Bad Handle", "", org_handle["handle"] or h)}
    assert said[h] == "taken" and said["@" + h.upper()] == "taken"
    assert list(said.values()).count("available") == 1
    assert said["ab"] == "invalid" and said["Bad Handle"] == "invalid" and said[""] == "invalid"
    assert said[org_handle["handle"] or h] == "taken"


@pytest.fixture
def two_accounts(worker, owner, api):
    """One human with an account in each of two organisations (different handles, one password), plus a profile."""
    a = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    ha, hb = _handle(), _handle() + "2"
    acc_a = _account(owner, ha, last_org=a.org)
    acc_b = _account(owner, hb, email=f"{hb}@example.test", verified=True, password="Synthetic-merge-2026!", last_org=b.org)
    _seat(owner, acc_a, a.org, a.editor)
    _seat(owner, acc_b, b.org, b.editor)
    with owner.transaction():
        owner.execute("insert into pulse_priv.account_profile(account_id, headline) values (%s, 'Synthetic headline')", (acc_b,))
        owner.execute("insert into pulse_priv.account_auth_event(account_id, action) values (%s, 'synthetic')", (acc_b,))
    return a, b, ha, hb, acc_a, acc_b


def test_merge_moves_every_seat_keeps_one_username_and_redirects_the_old_one(owner, api, two_accounts):
    a, b, ha, hb, acc_a, acc_b = two_accounts
    with owner.transaction():
        rec = owner.execute("select pulse.account_merge(%s, %s, %s, 'test: synthetic merge') r", (acc_a, acc_b, ha)).fetchone()["r"]
    assert rec["contract"] == "pulse-account-merge.v1" and rec["handle"] == ha
    assert {s["org"] for s in rec["seats"]} == {str(b.org)} and rec["unlinked"] == []
    assert rec["password_moved"] is True and rec["email_moved"] is True
    assert "password_hash" not in json.dumps(rec)
    with owner.transaction():
        acct = owner.execute("select handle, email, password_hash is not null pw from pulse_priv.pulse_account where id = %s", (acc_a,)).fetchone()
        seats = owner.execute("select member_org, person_id from pulse_priv.account_member where account_id = %s order by member_org", (acc_a,)).fetchall()
        refs = owner.execute("select handle from pulse_priv.handle_name where ref = %s order by handle", (acc_a,)).fetchall()
        assert owner.execute("select count(*) n from pulse_priv.pulse_account where id = %s", (acc_b,)).fetchone()["n"] == 0
        assert owner.execute("select headline from pulse_priv.account_profile where account_id = %s", (acc_a,)).fetchone()["headline"] == "Synthetic headline"
        assert owner.execute("select count(*) n from pulse_priv.account_auth_event where account_id = %s and action = 'synthetic'", (acc_a,)).fetchone()["n"] == 1
    assert acct["handle"] == ha and acct["email"] == f"{hb}@example.test" and acct["pw"] is True
    assert {(s["member_org"], s["person_id"]) for s in seats} == {(a.org, a.editor), (b.org, b.editor)}
    assert {r["handle"] for r in refs} == {ha, hb}
    with api.transaction():
        set_tenant(api, a.org)
        assert api.execute("select pulse.handle_check(%s) s", (hb,)).fetchone()["s"] == "taken"
    for w in (a, b):
        with owner.transaction():
            set_tenant(owner, w.org)
            assert owner.execute("select count(*) n from pulse.audit_event where org_id = %s and action = 'account_merge' and resource_id = %s",
                                 (w.org, str(acc_a))).fetchone()["n"] == 1

    # and back, from the record
    with owner.transaction():
        back = owner.execute("select pulse.account_unmerge(%s, 'test: synthetic unmerge') r", (json.dumps(rec),)).fetchone()["r"]
    assert back["restored"] == str(acc_b) and back["not_restored"] == []
    with owner.transaction():
        rows = {r["id"]: r for r in owner.execute(
            "select id, handle, email, password_hash is not null pw from pulse_priv.pulse_account where id in (%s, %s)", (acc_a, acc_b)).fetchall()}
        assert rows[acc_a]["handle"] == ha and rows[acc_a]["email"] is None and rows[acc_a]["pw"] is False
        assert rows[acc_b]["handle"] == hb and rows[acc_b]["email"] == f"{hb}@example.test" and rows[acc_b]["pw"] is True
        assert owner.execute("select account_id from pulse_priv.account_member where person_id = %s", (b.editor,)).fetchone()["account_id"] == acc_b
        assert owner.execute("select ref from pulse_priv.handle_name where handle = %s", (hb,)).fetchone()["ref"] == acc_b
        assert owner.execute("select account_id from pulse_priv.account_profile where headline = 'Synthetic headline' and account_id in (%s, %s)",
                             (acc_a, acc_b)).fetchone()["account_id"] == acc_b
        assert owner.execute("select count(*) n from pulse_priv.account_auth_event where account_id = %s and action = 'synthetic'", (acc_b,)).fetchone()["n"] == 1


def test_merge_takes_the_dropped_accounts_handle_when_asked(owner, two_accounts):
    _a, _b, ha, hb, acc_a, acc_b = two_accounts
    with owner.transaction():
        owner.execute("select pulse.account_merge(%s, %s, %s, 'test')", (acc_a, acc_b, hb))
        assert owner.execute("select handle from pulse_priv.pulse_account where id = %s", (acc_a,)).fetchone()["handle"] == hb
        assert {r["handle"] for r in owner.execute("select handle from pulse_priv.handle_name where ref = %s", (acc_a,)).fetchall()} == {ha, hb}


def test_merge_refuses_two_seats_in_one_organisation_unless_unlinked(owner, worker, api):
    a = build_world(worker, owner, api)
    h1, h2 = _handle(), _handle()
    acc1, acc2 = _account(owner, h1), _account(owner, h2)
    _seat(owner, acc1, a.org, a.editor)
    _seat(owner, acc2, a.org, a.editor2)
    with pytest.raises(psycopg.errors.UniqueViolation, match="both accounts have a seat"), owner.transaction():
        owner.execute("select pulse.account_merge(%s, %s, %s, 'test')", (acc1, acc2, h1))
    with owner.transaction():
        rec = owner.execute("select pulse.account_merge(%s, %s, %s, 'test', 'unlink') r", (acc1, acc2, h1)).fetchone()["r"]
    assert rec["unlinked"][0]["person"] == str(a.editor2) and rec["seats"] == []
    with owner.transaction():
        assert owner.execute("select count(*) n from pulse_priv.account_member where person_id = %s", (a.editor2,)).fetchone()["n"] == 0
        owner.execute("select pulse.account_unmerge(%s, 'test')", (json.dumps(rec),))
        assert owner.execute("select account_id from pulse_priv.account_member where person_id = %s", (a.editor2,)).fetchone()["account_id"] == acc2


def test_runtime_roles_cannot_merge(api, worker, owner, two_accounts):
    a, _b, ha, _hb, acc_a, acc_b = two_accounts
    for conn in (api, worker):
        with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
            set_tenant(conn, a.org)
            conn.execute("select pulse.account_merge(%s, %s, %s, 'test')", (acc_a, acc_b, ha))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        api.execute("select pulse.account_merge_candidates()")


def test_candidates_join_on_a_verified_email_only(owner, worker, api):
    a = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    h = _handle()
    email = f"{h}@example.test"
    acc = _account(owner, h, email=email, verified=True)
    _seat(owner, acc, a.org, a.editor)
    other = _account(owner, _handle(), email=f"other.{email}", verified=False)    # unverified: never joined
    _seat(owner, other, a.org, a.editor2)
    with worker.transaction():
        set_tenant(worker, b.org)
        worker.execute("insert into pulse.people_profile(org_id, person_id, role, email, evidence) values (%s, %s, 'Editor', %s, '{}')",
                       (b.org, b.editor, email))
    with owner.transaction():
        set_tenant(owner, b.org)
        owner.execute("""insert into pulse_priv.google_identity(org_id, person_id, issuer, subject, email, domain)
                         values (%s, %s, 'https://accounts.google.com', %s, %s, 'example.test')""", (b.org, b.editor, h, email))
    with owner.transaction():
        groups = owner.execute("select pulse.account_merge_candidates() g").fetchone()["g"]
    mine = [g for g in groups if g["email"] == email]
    assert len(mine) == 1
    assert [x["id"] for x in mine[0]["accounts"]] == [str(acc)]
    assert mine[0]["unlinked"] == [{"org": str(b.org), "person": str(b.editor)}]
    assert not [g for g in groups if g["email"] == f"other.{email}"]


# ------------------------------------------------------------------------------------------------ the org import
def _superuser() -> bool:
    with psycopg.connect(os.environ["PULSE_CI_DATABASE_URL"], autocommit=True) as c:
        return c.execute("select rolsuper from pg_roles where rolname = current_user").fetchone()[0]


def _tool(*argv, ok=(0,)):
    db = os.environ["PULSE_CI_DATABASE_URL"]
    p = subprocess.run([sys.executable, str(ORG_MOVE), argv[0], "--exec", "", "--db-user", "", "--database", db, *argv[1:]],
                       capture_output=True, text=True, check=False, timeout=600)
    assert p.returncode in ok, p.stdout[-3000:] + p.stderr[-3000:]
    return p


@pytest.fixture
def small_org(worker, owner):
    """A small synthetic organisation, as a separate install would hold it: people, profiles, roles, an audit trail
    naming a person by id (text), and one member with a Pulse account."""
    org, people = uuid.uuid4(), [uuid.uuid4() for _ in range(3)]
    code = new_code()
    with worker.transaction():
        set_tenant(worker, org)
        worker.execute("insert into pulse.org (id, slug, name, code) values (%s, %s, %s, %s)", (org, f"syn-{org}", f"Synthetic {code}", code))
        for i, p in enumerate(people):
            worker.execute("insert into pulse.person (id, org_id, display_name, side) values (%s, %s, %s, 'staff')", (p, org, f"Synthetic {i}"))
            worker.execute("insert into pulse.people_profile(org_id, person_id, role, username, evidence) values (%s, %s, 'Editor', %s, '{}')",
                           (org, p, f"syn.{code.lower()}.{i}"))
        worker.execute("insert into pulse.role_assignment(org_id, person_id, role_key, valid_from) values (%s, %s, 'admin', '2026-01-01')", (org, people[0]))
        worker.execute("select pulse.audit_write('synthetic', 'person', %s, '{}')", (str(people[1]),))
    # work, chats and file metadata (and bytes kept in the database), as WL's install holds them
    project, task = uuid.uuid4(), uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, org)
        owner.execute("insert into pulse.project(id, org_id, registry_no, name, lead_person_id, storage_root) values (%s, %s, 1, 'Synthetic project', %s, 'synthetic:move')",
                      (project, org, people[0]))
        owner.execute("insert into pulse.task(id, org_id, title, owner_id, assignee_person_id, created_by, status) values (%s, %s, 'Synthetic task', %s, %s, %s, 'open')",
                      (task, org, people[0], people[1], people[0]))
        owner.execute("insert into pulse.task_attachment(org_id, task_id, kind, label, url, added_by) values (%s, %s, 'link', 'Synthetic link', 'https://example.test/brief', %s)",
                      (org, task, people[0]))
        channel = owner.execute("insert into pulse.chat_channel(org_id, key, name, kind) values (%s, 'synthetic-move', 'Synthetic chat', 'custom') returning id",
                                (org,)).fetchone()["id"]
        for p in people[:2]:
            owner.execute("insert into pulse.chat_member(org_id, channel_id, person_id) values (%s, %s, %s)", (org, channel, p))
        owner.execute("insert into pulse.chat_message(org_id, channel_id, author_id, body, client_id) values (%s, %s, %s, 'Synthetic hello', %s)",
                      (org, channel, people[0], str(uuid.uuid4())))
        owner.execute("insert into pulse_priv.chat_file(org_id, channel_id, person_id, name, mime, bytes) values (%s, %s, %s, 'synthetic.txt', 'text/plain', 'synthetic')",
                      (org, channel, people[1]))
    h = _handle()
    acc = _account(owner, h, email=f"{h}@example.test", verified=True)
    _seat(owner, acc, org, people[0])
    return org, people, code, acc, h


def _count(owner, org, table):
    with owner.transaction():
        set_tenant(owner, org)
        return owner.execute(f"select count(*) n from {table} where org_id = %s", (org,)).fetchone()["n"]


def test_org_import_is_dry_run_first_remaps_taken_ids_and_runs_once(owner, admin, small_org, tmp_path):
    if not _superuser():
        pytest.skip("the import pauses triggers (session_replication_role): a superuser scratch database only")
    org, people, _code, acc, h = small_org
    bundle = tmp_path / "bundle"
    _tool("export", "--org", str(org), "--out", str(bundle), "--carry-accounts")
    manifest = json.loads((bundle / "manifest.json").read_text())
    assert manifest["contract"] == "pulse-org-move.v2" and manifest["accounts"]
    # Into the same database: every id is taken, so without --remap-ids the move stops (nothing written).
    blocked = _tool("import", "--bundle", str(bundle), ok=(2,))
    assert "--remap-ids" in blocked.stdout
    renames = ["--remap-ids", "--as-slug", f"syn-moved-{org}", "--as-code", new_code(), "--as-handle", "m" + _handle()]
    dry = _tool("import", "--bundle", str(bundle), *renames)
    assert "DRY RUN: rolled back" in dry.stdout and "remapped ids:" in dry.stdout
    assert admin.execute("select count(*) n from pulse.org where slug = %s", (f"syn-moved-{org}",)).fetchone()["n"] == 0
    applied = _tool("import", "--bundle", str(bundle), *renames, "--apply", "--no-snapshot", "--approver", "test",
                    "--issue", "TEST-1", "--words", "synthetic test")
    assert "APPLIED" in applied.stdout
    new = admin.execute("select id from pulse.org where slug = %s", (f"syn-moved-{org}",)).fetchone()["id"]
    assert new != org
    for table in ("pulse.person", "pulse.people_profile", "pulse.role_assignment", "pulse.project", "pulse.task",
                  "pulse.task_attachment", "pulse.chat_channel", "pulse.chat_member", "pulse.chat_message", "pulse_priv.chat_file"):
        assert _count(owner, new, table) == _count(owner, org, table) > 0, table
    with owner.transaction():
        set_tenant(owner, new)
        work = owner.execute("""select t.assignee_person_id, (select count(*) from pulse.chat_member m join pulse.chat_channel c on c.id = m.channel_id
                                 where c.org_id = %s) members, (select person_id from pulse_priv.chat_file where org_id = %s) file_by
                                from pulse.task t where t.org_id = %s""", (new, new, new)).fetchone()
        assert work["assignee_person_id"] not in people and work["members"] == 2 and work["file_by"] not in people
    with owner.transaction():
        set_tenant(owner, new)
        moved = {r["id"] for r in owner.execute("select id from pulse.person where org_id = %s", (new,)).fetchall()}
        assert not moved & set(people)                                  # new ids, none shared with the source
        audit = owner.execute("select resource_id from pulse.audit_event where org_id = %s and action = 'synthetic'", (new,)).fetchone()
        assert audit["resource_id"] != str(people[1]) and uuid.UUID(audit["resource_id"]) in moved   # the id inside text, remapped
        admin_person = owner.execute("select person_id from pulse.role_assignment where org_id = %s and role_key = 'admin'", (new,)).fetchone()["person_id"]
        assert admin_person in moved
    with owner.transaction():
        # the member's account is the same human: it keeps its handle and gains the seat in the moved organisation
        seats = owner.execute("select member_org, person_id from pulse_priv.account_member where account_id = %s", (acc,)).fetchall()
        assert {s["member_org"] for s in seats} == {org, new}
        assert {s["person_id"] for s in seats if s["member_org"] == new} == {admin_person}
        assert owner.execute("select handle from pulse_priv.pulse_account where id = %s", (acc,)).fetchone()["handle"] == h
    # the source is untouched
    assert _count(owner, org, "pulse.person") == 3
    # the same bundle again: one move, nothing changes
    again = _tool("import", "--bundle", str(bundle), *renames, "--apply", "--no-snapshot", "--approver", "test",
                  "--issue", "TEST-1", "--words", "synthetic test")
    assert "already imported" in again.stdout
    assert admin.execute("select count(*) n from pulse.org where slug like %s", (f"syn-moved-{org}%",)).fetchone()["n"] == 1
    # a newer export of the same organisation is not a second copy either: it stops, nothing written
    with owner.transaction():
        set_tenant(owner, org)
        owner.execute("insert into pulse.person (org_id, display_name, side) values (%s, 'Synthetic later', 'staff')", (org,))
    newer = tmp_path / "newer"
    _tool("export", "--org", str(org), "--out", str(newer), "--carry-accounts")
    second = _tool("import", "--bundle", str(newer), "--remap-ids", "--as-slug", f"syn-moved2-{org}", "--as-code", new_code(),
                   "--as-handle", "m" + _handle(), ok=(2,))
    assert "already imported into" in second.stdout
    assert admin.execute("select count(*) n from pulse.org where slug = %s", (f"syn-moved2-{org}",)).fetchone()["n"] == 0


def test_accounts_tool_plans_and_dry_runs_a_merge(owner, tmp_path, two_accounts):
    if not _superuser():
        pytest.skip("the accounts tool runs as the database superuser (as on the server)")
    a, b, ha, _hb, _acc_a, acc_b = two_accounts
    with owner.transaction():
        owner.execute("update pulse_priv.pulse_account set email = null where id = %s", (acc_b,))
    # one verified e-mail on both: a Google identity for each person
    email = f"{ha}@example.test"
    for w in (a, b):
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute("""insert into pulse_priv.google_identity(org_id, person_id, issuer, subject, email, domain)
                             values (%s, %s, 'https://accounts.google.com', %s, %s, 'example.test')""", (w.org, w.editor, uuid.uuid4().hex, email))
    db = os.environ["PULSE_CI_DATABASE_URL"]
    base = [sys.executable, str(ACCOUNTS)]
    conn = ["--exec", "", "--db-user", "", "--database", db, "--out-dir", str(tmp_path)]
    plan = subprocess.run([*base, "plan", *conn], capture_output=True, text=True, check=False, timeout=300)
    assert plan.returncode in (0, 3), plan.stdout + plan.stderr          # 3: another test's human needs a decision
    assert f"username @{ha}" in plan.stdout                     # no trailing number beats "…2"
    dry = subprocess.run([*base, "merge", *conn, "--only", ha], capture_output=True, text=True, check=False, timeout=300)
    assert dry.returncode == 0, dry.stdout + dry.stderr
    assert "DRY RUN (rolled back): 1 account(s) merged, 1 seat(s) moved" in dry.stdout
    with owner.transaction():
        assert owner.execute("select count(*) n from pulse_priv.pulse_account where id = %s", (acc_b,)).fetchone()["n"] == 1


def test_inventory_prints_counts_and_groups_only(owner, worker, tmp_path, two_accounts):
    if not _superuser():
        pytest.skip("the inventory reads every organisation as the database superuser (as on the server)")
    a, b, _ha, hb, _acc_a, _acc_b = two_accounts
    # one human on two organisations by e-mail and phone; the "owner" with a profile of their own
    email, owner_email = f"dup.{hb}@example.test", f"owner.{hb}@example.test"
    for w, mail in ((a, email), (b, email.upper()), (b, owner_email)):
        with worker.transaction():
            set_tenant(worker, w.org)
            person = w.lead if mail == owner_email else w.editor2
            worker.execute("insert into pulse.people_profile(org_id, person_id, role, email, phone, evidence) values (%s, %s, 'Editor', %s, '+91 90000 00001', '{}')",
                           (w.org, person, mail))
    key = tmp_path / "inventory.key"
    key.write_text(uuid.uuid4().hex + uuid.uuid4().hex)
    db = os.environ["PULSE_CI_DATABASE_URL"]
    run = subprocess.run([sys.executable, str(ACCOUNTS), "inventory", "--exec", "", "--db-user", "", "--database", db, "--label", "dev",
                          "--key-file", str(key), "--out", str(tmp_path / "inv-dev.jsonl"), "--owner-email", owner_email],
                         capture_output=True, text=True, check=False, timeout=300)
    assert run.returncode == 0, run.stdout + run.stderr
    lines = (tmp_path / "inv-dev.jsonl").read_text()
    assert email not in lines.lower() and "90000" not in lines            # only keyed hashes of other people
    report = subprocess.run([sys.executable, str(ACCOUNTS), "inventory-report", str(tmp_path / "inv-dev.jsonl")],
                            capture_output=True, text=True, check=False, timeout=300)
    assert report.returncode == 0, report.stderr
    out = report.stdout
    assert "== People inventory (counts only)" in out and "dev: organisations" in out
    assert email not in out.lower() and "Editor Two" not in out and "90000" not in out
    assert "across organisations" in out and "groups 0 " not in out.split("== Duplicate groups among all person records")[1]
    assert owner_email in out                                            # the owner's own records, in full
