"""AC-CONTACTS-2: tools/admin/sync-testers.py, a tester register (CSV) kept in step with an organisation's Contacts
through API v1's own add_contact and update_contact (owner, 18 Nov 2026: "file the tester register as contacts ... and keep
it syncing"). New testers are added with tags, status, phone type and a dated note; a person already there is updated,
never copied; our own staff are never filed; a client's people are not prospects; a status a person set is kept; the
dry run writes nothing; the same register twice writes nothing the second time. Needs services/api built
(SYNC_TESTERS_TREE, default this checkout). Synthetic data only."""
import os
import socket
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from conftest import dsn
from helpers import build_world
from pulse_sdk.db import set_tenant

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools/admin/sync-testers.py"
TREE = Path(os.environ.get("SYNC_TESTERS_TREE", ROOT))
HEADER = "name,email,phone,platform,company,invited,installed,app_version,last_active,status\n"
BUILT = TREE / "services/api/dist/v1-money.js"
pytestmark = pytest.mark.skipif(not (BUILT.is_file() and "addContact" in BUILT.read_text(encoding="utf-8")),
                                reason="services/api is not built from a tree with add_contact (AC-CONTACTS)")


def run(register, org, as_user, *argv, hosts=None):
    env = {**os.environ, "PULSE_ADMIN_TOOL_HOSTS": hosts if hosts is not None else socket.gethostname()}
    return subprocess.run([sys.executable, str(TOOL), str(register), "--org", str(org), "--as", as_user, "--approver", "Synthetic Owner (owner)",
                           "--came-from", "Synthetic app testers", "--own-domain", "own.example", "--own-label", "owner",
                           "--database", dsn("api"), "--tree", str(TREE), *argv],
                          capture_output=True, text=True, check=False, timeout=300, env=env)


def contact(worker, org, name, *, email=None, phone=None, company=None, tags=None, status=None):
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'other')", (pid, org, name))
        worker.execute("""insert into pulse.contact_profile(org_id,person_id,source,email,phone,company_id,tags,contact_status,contact_status_at)
                          values(%s,%s,'manual',%s,%s,%s,coalesce(%s,'{}'::text[]),%s,case when %s::text is null then null else now() end)""",
                       (org, pid, email, phone, company, tags, status, status))
    return pid


def state(worker, org):
    with worker.transaction():
        set_tenant(worker, org)
        rows = worker.execute("""select p.display_name name,cp.email,cp.tags,cp.contact_status status,cp.device,cp.came_from,co.name company,
              (select count(*)::int from pulse.contact_note n where n.person_id=p.id and n.removed_at is null) notes
            from pulse.contact_profile cp join pulse.person p on p.id=cp.person_id left join pulse.company co on co.id=cp.company_id
            where p.org_id=%s""", (org,)).fetchall()
        changes = worker.execute("select count(*)::int n from pulse.record_change where org_id=%s", (org,)).fetchone()["n"]
    return {r["email"] or r["name"]: r for r in rows}, changes


@pytest.fixture
def org(worker, owner, api):
    """A synthetic organisation: an admin with a username, a staff member with an e-mail, a client company with its
    client contact, an earlier tester, one of our own accounts in Contacts and a namesake at another company."""
    w = build_world(worker, owner, api)
    client_co, other_co = uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, w.manager))
        for pid, user, mail in ((w.manager, f"synth-admin-{w.code.lower()}", None), (w.editor, f"synth-ed-{w.code.lower()}", "staff1@mail.example")):
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,username,evidence,email) values(%s,%s,'Editor','Pod 1',%s,'{}',%s)",
                           (w.org, pid, user, mail))
        for cid, name in ((client_co, "Synthetic Client Co"), (other_co, "Synthetic Other Co")):
            worker.execute("insert into pulse.company(id,org_id,name) values(%s,%s,%s)", (cid, w.org, name))
    contact(worker, w.org, "Synthetic Client Boss", company=client_co, tags=["client"], status="client")
    contact(worker, w.org, "Synthetic Old Tester", email="old@mail.example", phone="+91 90000 11111")
    contact(worker, w.org, "Synthetic Shared Phone", email="phone@own.example")
    contact(worker, w.org, "Synthetic Namesake", company=other_co)
    return w


def test_a_register_files_testers_once_through_add_and_update_contact(worker, org, tmp_path):
    admin = f"synth-admin-{org.code.lower()}"
    reg = tmp_path / "register.csv"
    lines = [
        ",new1@mail.example,,Android,,2026-10-27,unknown (Play stats pending),,,invited (in tester group)",   # no name: filed under the e-mail
        ",old@mail.example,,Android,,2026-10-27,unknown,,,invited (in tester group)",                        # an earlier tester: updated
        "Synthetic Client Boss,boss@client.example,,Android,Synthetic Client Co,2026-10-30,unknown,,,invited (in tester group)",
        "Synthetic Seller,seller@client.example,,Android,Synthetic Client Co (Boss),2026-10-30,unknown,,,invited (in tester group)",
        "Synthetic Pending,pending@mail.example,+91 90000 22222,Android,prospect (owner),,no,,,to add (owner click)",
        ",staff1@mail.example,,Android,,2026-10-27,unknown,,,invited (in tester group)",                    # our staff: never filed
        ",me@own.example,,Android,owner,2026-10-27,unknown,,,invited (in tester group)",                      # our own, not in Contacts
        ",phone@own.example,,Android,,2026-10-27,unknown,,,invited (in tester group)",                        # our own, in Contacts: staff
        "Synthetic Namesake,namesake@mail.example,,Android,Synthetic Third Co,2026-10-27,unknown,,,invited (in tester group)",
    ]
    reg.write_text(HEADER + "\n".join(lines) + "\n", encoding="utf-8")
    before, changes0 = state(worker, org.org)

    dry = run(reg, org.org, admin)
    assert dry.returncode == 0, dry.stderr + dry.stdout
    assert "Dry run" in dry.stdout
    assert state(worker, org.org) == (before, changes0)

    done = run(reg, org.org, admin, "--apply", "--log", str(tmp_path / "log.jsonl"))
    assert done.returncode == 0, done.stderr + done.stdout
    rows, changes1 = state(worker, org.org)
    new1 = rows["new1@mail.example"]
    assert (new1["name"], new1["tags"], new1["status"], new1["device"], new1["came_from"], new1["notes"]) == (
        "new1@mail.example", ["tester", "prospect"], "invited", "android", "Synthetic app testers", 1)
    old = rows["old@mail.example"]
    assert (old["name"], old["tags"], old["status"], old["device"], old["notes"]) == ("Synthetic Old Tester", ["tester", "prospect"], "invited", "android", 1)
    boss = rows["boss@client.example"]                     # matched by name and company; e-mail filled in; client status kept
    assert (boss["name"], boss["tags"], boss["status"], boss["company"]) == ("Synthetic Client Boss", ["client", "tester"], "client", "Synthetic Client Co")
    seller = rows["seller@client.example"]                 # a client's person is not a prospect
    assert (seller["tags"], seller["status"], seller["company"]) == (["tester"], "invited", "Synthetic Client Co")
    pending = rows["pending@mail.example"]
    assert (pending["tags"], pending["status"], pending["company"]) == (["tester", "prospect"], "new", None)
    assert rows["phone@own.example"]["tags"] == ["tester", "staff"]
    assert "staff1@mail.example" not in rows and "me@own.example" not in rows
    assert "namesake@mail.example" not in rows and rows["Synthetic Namesake"]["tags"] == []   # name only, other company: left alone
    for word in ("skip-staff", "skip-own", "check-by-hand", "created", "updated"):
        assert word in done.stdout
    assert (tmp_path / "log.jsonl").stat().st_mode & 0o077 == 0

    again = run(reg, org.org, admin, "--apply")
    assert again.returncode == 0, again.stderr
    assert state(worker, org.org) == (rows, changes1)      # nothing changes the second time
    assert "created" not in again.stdout.split("{")[0] and "updated" not in again.stdout.split("{")[0]

    # The register moves a status forward (installed); a later step set by a person is not moved back.
    reg.write_text(HEADER + ",new1@mail.example,,Android,,2026-10-27,yes,,,invited (in tester group)\n"
                   + ",old@mail.example,,Android,,2026-10-27,unknown,,,invited (in tester group)\n", encoding="utf-8")
    with worker.transaction():
        set_tenant(worker, org.org)
        worker.execute("update pulse.contact_profile set contact_status='active' where email='old@mail.example'")
    third = run(reg, org.org, admin, "--apply")
    assert third.returncode == 0, third.stderr
    rows3, _ = state(worker, org.org)
    assert (rows3["new1@mail.example"]["status"], rows3["new1@mail.example"]["notes"]) == ("installed", 2)
    assert (rows3["old@mail.example"]["status"], rows3["old@mail.example"]["notes"]) == ("active", 1)


def test_only_a_contact_writer_on_the_server_syncs(worker, org, tmp_path):
    reg = tmp_path / "register.csv"
    reg.write_text(HEADER + ",x1@mail.example,,Android,,2026-10-27,unknown,,,invited (in tester group)\n", encoding="utf-8")
    before = state(worker, org.org)
    editor = run(reg, org.org, f"synth-ed-{org.code.lower()}", "--apply")      # staff, not an admin, leadership or Finance
    assert editor.returncode == 1 and "nothing was written" in editor.stderr
    assert "error" in editor.stdout and "added and changed by admins, leadership and the Finance role" in editor.stdout
    elsewhere = run(reg, org.org, f"synth-admin-{org.code.lower()}", "--apply", hosts="not-this-host")
    assert elsewhere.returncode == 2 and "runs only on the Pulse server" in elsewhere.stderr
    twice = tmp_path / "twice.csv"
    twice.write_text(HEADER + ",x1@mail.example,,Android,,,,,,\n,X1@mail.example,,Android,,,,,,\n", encoding="utf-8")
    dup = run(twice, org.org, f"synth-admin-{org.code.lower()}", "--apply")
    assert dup.returncode == 2 and "same person" in dup.stderr
    assert state(worker, org.org) == before
