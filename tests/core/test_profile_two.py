"""PROFILE-2 (2215): a profile names real, active companies only; a platform admin retires a test company (and puts it
back); the skills library (type-ahead, suggestions by role, structured links on a person's own skills).

* account_profile_get's "What each company sees" and account_roles leave out test, demo, archived and suspended
  companies and the personal space (a test company lists itself only while it is the one open).
* pulse.platform_org_retire: platform admins only, with a reason; refuses a real active company, the install's own, a
  personal space, a merged organisation; archives it as test, ends its sign-ins and the named seats (alumni row,
  person inactive, account_leave note); pulse.platform_org_restore puts back the status, purpose and seats.
* pulse.skill_library_search / _suggest / skill_refs_of and the skill_refs triggers; the library tables are owner-only.
Synthetic organisations, people and skills only."""
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from helpers import build_world
from test_investor_metrics import admin, as_, member, new_account, person


@pytest.fixture
def three(worker, owner, api):
    """One account with a seat in a real company (a), a second real company (b) and a third (c)."""
    a, b, c = (build_world(worker, owner, api) for _ in range(3))
    admin(worker, a.org, a.manager)
    acct = new_account(owner, f"ptwo{uuid.uuid4().hex[:8]}")
    member(owner, acct, a.org, a.manager)
    member(owner, acct, b.org, b.manager)
    member(owner, acct, c.org, c.manager)
    return a, b, c, acct


def set_org(owner, org, **cols):
    with owner.transaction():
        set_tenant(owner, org)
        for k, v in cols.items():
            owner.execute(f"update pulse.org set {k}=%s where id=%s", (v, org))


def platform_seat(worker, owner):
    install = owner.execute("select pulse.install_org() o").fetchone()["o"]
    seat = person(worker, install, "Synthetic Platform Owner")
    admin(worker, install, seat)
    with owner.transaction():
        owner.execute("insert into pulse_priv.platform_admin(person_id,granted_by) values(%s,'test:synthetic')", (seat,))
    return install, seat


def test_profile_lists_only_real_active_companies(three, api, owner):
    a, b, c, acct = three
    names = lambda r: {s["org"] for s in r}  # noqa: E731
    p = as_(api, a.org, a.manager, "select pulse.account_profile_get() p")[0]["p"]
    assert names(p["shares"]) == {str(a.org), str(b.org), str(c.org)}
    set_org(owner, b.org, purpose="test")
    set_org(owner, c.org, status="archived")
    p = as_(api, a.org, a.manager, "select pulse.account_profile_get() p")[0]["p"]
    assert names(p["shares"]) == {str(a.org)}
    roles = as_(api, a.org, a.manager, "select pulse.account_roles() r")[0]["r"]
    assert {r["org"] for r in roles} == {str(a.org)}
    # Inside the test company itself, it still lists itself (so it can be managed there); never the archived one.
    p = as_(api, b.org, b.manager, "select pulse.account_profile_get() p")[0]["p"]
    assert names(p["shares"]) == {str(a.org), str(b.org)}


def test_retire_and_restore_a_test_company(three, worker, owner, api):
    a, b, c, acct = three
    install, seat = platform_seat(worker, owner)
    handle = owner.execute("select handle from pulse_priv.pulse_account where id=%s", (acct,)).fetchone()["handle"]
    # Not a platform admin: refused. A real, active company: refused. No reason: refused.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, a.org, a.manager, "select pulse.platform_org_retire(%s,%s,'synthetic reason')", (b.org, [handle]))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, install, seat, "select pulse.platform_org_retire(%s,%s,'synthetic reason')", (b.org, [handle]))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, install, seat, "select pulse.platform_org_retire(%s,%s,'synthetic reason')", (install, [handle]))
    set_org(owner, b.org, purpose="demo")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, install, seat, "select pulse.platform_org_retire(%s,%s,'')", (b.org, [handle]))
    r = as_(api, install, seat, "select pulse.platform_org_retire(%s,%s,'synthetic: retire the demo company') r", (b.org, [handle]))[0]["r"]
    assert r["status"] == ["active", "archived"] and r["purpose"] == ["demo", "test"] and [s["handle"] for s in r["seatsEnded"]] == [handle]
    with owner.transaction():
        set_tenant(owner, b.org)
        org = owner.execute("select status, purpose from pulse.org where id=%s", (b.org,)).fetchone()
        assert (org["status"], org["purpose"]) == ("archived", "test")
        assert owner.execute("select status from pulse.person where id=%s", (b.manager,)).fetchone()["status"] == "inactive"
        assert owner.execute("select count(*) n from pulse.account_alumni where org_id=%s and account_id=%s", (b.org, acct)).fetchone()["n"] == 1
        actions = {x["action"] for x in owner.execute("select action from pulse.audit_event where org_id=%s", (b.org,)).fetchall()}
        assert {"platform.org.retired", "account_leave"} <= actions
        assert owner.execute("select count(*) n from pulse.org_retired where org_id=%s", (b.org,)).fetchone()["n"] == 1
    assert owner.execute("select count(*) n from pulse_priv.account_member where account_id=%s and member_org=%s", (acct, b.org)).fetchone()["n"] == 0
    assert owner.execute("select count(*) n from pulse_priv.platform_audit where action='org.retired' and target_org=%s", (b.org,)).fetchone()["n"] == 1
    me = as_(api, a.org, a.manager, "select pulse.account_me() m")[0]["m"]
    assert str(b.org) not in {o["id"] for o in me["orgs"]}
    # Already archived: refused. The API role reads no retire record directly (only the platform functions do).
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, install, seat, "select pulse.platform_org_retire(%s,%s,'synthetic reason')", (b.org, [handle]))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, a.org, a.manager, "select count(*) n from pulse.org_retired")
    # Restore: the status and purpose it had, and the seat.
    back = as_(api, install, seat, "select pulse.platform_org_restore(%s,'synthetic: put it back') r", (b.org,))[0]["r"]
    assert back["status"] == "active" and back["purpose"] == "demo" and back["seatsBack"] == 1
    assert owner.execute("select count(*) n from pulse_priv.account_member where account_id=%s and member_org=%s", (acct, b.org)).fetchone()["n"] == 1
    with owner.transaction():
        set_tenant(owner, b.org)
        assert owner.execute("select status from pulse.person where id=%s", (b.manager,)).fetchone()["status"] == "active"
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, install, seat, "select pulse.platform_org_restore(%s,'synthetic: again')", (b.org,))


def _retire_tool(*argv, hosts=None):
    """tools/admin/org-retire.py as production runs it: the migrator login (a member of the schema owner, neither the
    superuser nor able to read past row security), never the suite's superuser URL, which reads past row security."""
    import os
    import socket
    import subprocess
    import sys
    from pathlib import Path
    from conftest import ADMIN_URL, MODE, role_url
    url = role_url("migrate") if MODE["value"] == "superuser" else ADMIN_URL
    tool = Path(__file__).resolve().parents[2] / "tools/admin/org-retire.py"
    env = {**os.environ, "PULSE_ADMIN_TOOL_HOSTS": hosts if hosts is not None else socket.gethostname()}
    return subprocess.run([sys.executable, str(tool), "--database", url, "--approver", "Synthetic Owner (owner)", *argv],
                          capture_output=True, text=True, check=False, timeout=300, env=env)


def test_the_retire_tool_finds_the_platform_owner_through_row_security(three, worker, owner, api):
    """ORG-RETIRE (18 Nov 2026): on production every org-retire.py run was refused with "no active staff seat in the
    install's organisation": the seat lookup read pulse.org and pulse.person (forced row security) from outside any
    organisation. Who may act is unchanged: only an admin of the install's organisation named a platform admin."""
    a, b, c, acct = three
    install, seat = platform_seat(worker, owner)
    tag = uuid.uuid4().hex[:8]
    boss, plain_h, listed_h = f"ptboss{tag}", f"ptadm{tag}", f"ptlst{tag}"
    member(owner, new_account(owner, boss), install, seat)
    # An admin of the install's organisation who is not named a platform admin, and a named one who is no admin there.
    plain = person(worker, install, "Synthetic Install Admin")
    admin(worker, install, plain)
    member(owner, new_account(owner, plain_h), install, plain)
    listed = person(worker, install, "Synthetic Listed Non-admin")
    with owner.transaction():
        owner.execute("insert into pulse_priv.platform_admin(person_id,granted_by) values(%s,'test:synthetic')", (listed,))
    member(owner, new_account(owner, listed_h), install, listed)
    nobody = f"ptnos{tag}"
    new_account(owner, nobody)  # no seat anywhere (on a fresh database a, built first, IS the install's organisation)
    set_org(owner, c.org, handle=f"ptc{tag}")
    set_org(owner, b.org, purpose="test", handle=f"ptb{tag}")
    who = owner.execute("select handle from pulse_priv.pulse_account where id=%s", (acct,)).fetchone()["handle"]
    words = ("--words", "synthetic: retire the test company")
    retire = ("--org", f"ptb{tag}", "--accounts", who, *words)

    def b_state():
        with owner.transaction():
            set_tenant(owner, b.org)
            o = owner.execute("select status, purpose from pulse.org where id=%s", (b.org,)).fetchone()
            return o["status"], o["purpose"], owner.execute("select status from pulse.person where id=%s", (b.manager,)).fetchone()["status"]

    def logged(action):
        return owner.execute("select count(*) n from pulse_priv.platform_audit where action=%s and target_org=%s", (action, b.org)).fetchone()["n"]

    # Refused, nothing written: another host, no words, an account with no seat in the install's organisation, an
    # install admin who is not a platform admin, a platform admin whose seat is not an admin one, a real active company.
    refused = {
        "host": _retire_tool(*retire, "--as", boss, hosts="not-this-host"),
        "words": _retire_tool("--org", f"ptb{tag}", "--as", boss, "--words", ""),
        "no seat": _retire_tool(*retire, "--as", nobody, "--apply"),
        "not listed": _retire_tool(*retire, "--as", plain_h, "--apply"),
        "not admin": _retire_tool(*retire, "--as", listed_h, "--apply"),
        "real": _retire_tool("--org", f"ptc{tag}", *words, "--as", boss, "--apply"),
        "unknown": _retire_tool("--org", f"ptnone{tag}", *words, "--as", boss, "--apply"),
    }
    assert {k: r.returncode for k, r in refused.items()} == {k: 2 for k in refused}, {k: r.stderr for k, r in refused.items()}
    assert "no active staff seat in the install's organisation" in refused["no seat"].stderr
    assert "is not a Pulse platform admin" in refused["not listed"].stderr and "is not a Pulse platform admin" in refused["not admin"].stderr
    assert "real, active company" in refused["real"].stderr and "no organisation" in refused["unknown"].stderr
    assert b_state() == ("active", "test", "active") and logged("org.retired") == 0
    # The platform owner: the dry run does it all and rolls back; --apply archives it and ends the named seat.
    dry = _retire_tool(*retire, "--as", boss)
    assert dry.returncode == 0 and '"applied": false' in dry.stdout, dry.stderr
    assert b_state() == ("active", "test", "active") and logged("org.retired") == 0
    done = _retire_tool(*retire, "--as", boss, "--apply")
    assert done.returncode == 0 and '"applied": true' in done.stdout, done.stderr
    assert b_state() == ("archived", "test", "inactive") and logged("org.retired") == 1
    reason = owner.execute("select reason from pulse_priv.platform_audit where action='org.retired' and target_org=%s", (b.org,)).fetchone()["reason"]
    assert "approved by Synthetic Owner (owner)" in reason
    assert owner.execute("select count(*) n from pulse_priv.account_member where account_id=%s and member_org=%s", (acct, b.org)).fetchone()["n"] == 0
    me = as_(api, a.org, a.manager, "select pulse.account_me() m")[0]["m"]
    assert str(b.org) not in {o["id"] for o in me["orgs"]}
    # The undo: the status, purpose and seat it had.
    back = _retire_tool("--org", f"ptb{tag}", "--restore", "--words", "synthetic: put it back", "--as", boss, "--apply")
    assert back.returncode == 0 and '"seatsBack": 1' in back.stdout, back.stderr
    assert b_state() == ("active", "test", "active") and logged("org.restored") == 1
    assert owner.execute("select count(*) n from pulse_priv.account_member where account_id=%s and member_org=%s", (acct, b.org)).fetchone()["n"] == 1


def test_skill_library_search_suggest_and_links(three, owner, api, worker):
    a, b, c, acct = three
    found = as_(api, a.org, a.manager, "select pulse.skill_library_search('video', 12) s")[0]["s"]
    labels = [s["label"] for s in found]
    assert "Video editing" in labels and labels.index("Video editing") < 3
    assert as_(api, a.org, a.manager, "select pulse.skill_library_search('vdeo editing', 5) s")[0]["s"][0]["label"] == "Video editing"
    # A role's words suggest skills; what the person has is left out.
    s = as_(api, a.org, a.manager, "select pulse.skill_library_suggest('Video editor', array['Video editing'], 12) s")[0]["s"]
    got = {x["label"] for x in s}
    assert "Adobe Premiere Pro" in got and "Video editing" not in got
    assert all(x["why"] in ("role", "industry", "occupation", "common") for x in s)
    # An occupation's skills (as the O*NET import adds them), matched by a job title.
    with owner.transaction():
        owner.execute("""insert into pulse_priv.skill_library_source(id,name,version,licence,attribution,adapted)
            values ('onet-test','Synthetic list','0','Synthetic licence','Synthetic attribution words.','Synthetic adaptation words.')""")
        owner.execute("""insert into pulse_priv.skill_library(id,source,kind,label,label_key,weight) values ('onet:t:zz-synthetic-tool','onet-test','software','ZZ Synthetic Tool','zz synthetic tool',3)""")
        owner.execute("insert into pulse_priv.skill_library_role(occupation,title,title_key,source) values ('99-9999.00','Synthetic Wrangler','synthetic wrangler','onet-test')")
        owner.execute("insert into pulse_priv.skill_library_link(occupation,skill_id,weight) values ('99-9999.00','onet:t:zz-synthetic-tool',1)")
    s = as_(api, a.org, a.manager, "select pulse.skill_library_suggest('Synthetic Wrangler', '{}', 20) s")[0]["s"]
    assert {"label": "ZZ Synthetic Tool", "why": "occupation"}.items() <= next(x for x in s if x["label"] == "ZZ Synthetic Tool").items()
    # A person's own words stay; each label also gets its library id (null: a custom skill).
    refs = as_(api, a.org, a.manager, "select pulse.skill_refs_of(array['video editing','My own odd skill']) r")[0]["r"]
    assert refs["video editing"].startswith("pulse:") and refs["My own odd skill"] is None
    with owner.transaction():
        owner.execute("insert into pulse_priv.account_profile(account_id, skills) values (%s, array['Figma','Knitting robots']) on conflict (account_id) do update set skills = excluded.skills", (acct,))
        row = owner.execute("select skill_refs from pulse_priv.account_profile where account_id=%s", (acct,)).fetchone()["skill_refs"]
    assert row["Figma"] == "pulse:figma" and row["Knitting robots"] is None
    with worker.transaction():
        set_tenant(worker, a.org)
        worker.execute("update pulse.people_profile set skills = array['Copywriting'] where person_id=%s", (a.manager,))
        pr = worker.execute("select skill_refs from pulse.people_profile where person_id=%s", (a.manager,)).fetchone()
    if pr:  # the world builder makes a profile row for its people
        assert pr["skill_refs"] == {"Copywriting": "pulse:copywriting"}
    about = as_(api, a.org, a.manager, "select pulse.skill_library_about() s")[0]["s"]
    assert any(x["id"] == "pulse-1" and x["skills"] >= 100 for x in about)
    # The library tables themselves are owner-only: the API role cannot read them directly.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, a.org, a.manager, "select count(*) from pulse_priv.skill_library")
