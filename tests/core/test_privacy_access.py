"""PRIVACY (owner, 2 Nov 2026: "who sees what"): one seat of each kind signs in with a real password and the API is asked
what it shows them. Projects by visibility (everyone / members / leadership), the tasks, time, files, discussion and
asks inside them, leadership-only tasks, a freelancer's seat (their projects and tasks only, no directory or company
figures), a client's seat, and sales reps' own Sales X-Ray calls and leads (their manager and leadership see them;
the team's totals for everyone). Negative cases are asserted as firmly as the positive ones.
services/api/test/privacy-access-runner.mjs holds the API matrix; this file builds the world and checks row security
on the tables the API does not read directly."""

import json
import os
import subprocess
import uuid
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant

SEATS = ["leadership", "admin", "hr", "manager", "staff", "freelancer", "client"]
PASSWORD = "Synthetic-issued-2026!"


def owner_sql(owner, org, sql, args=()):
    with owner.transaction():
        set_tenant(owner, org)
        cur = owner.execute(sql, args)
        return cur.fetchall() if cur.description else None


def seen(api, org, viewer, sql, args=()):
    """What row security shows `viewer` (the API's database role)."""
    with api.transaction():
        set_tenant(api, org, viewer)
        return [tuple(r.values()) if isinstance(r, dict) else tuple(r) for r in api.execute(sql, args).fetchall()]


def test_privacy_seats_see_only_their_share(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    org = w.org
    seat = {s: uuid.uuid4() for s in SEATS}
    rep_b = w.editor2                      # another sales rep, outside the manager's team (Pod 2)
    side = {"freelancer": "freelancer", "client": "client"}
    role = {"leadership": "leadership", "admin": "admin", "hr": "hr", "manager": "manager"}
    for s, pid in seat.items():
        # Every seat starts as staff (a password is issued to staff only); the freelancer and client seats are set below.
        owner_sql(owner, org, "insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')",
                  (pid, org, f"Synthetic {s}"))
        owner_sql(owner, org, "insert into pulse.people_profile(org_id,person_id,role,pod,username,department,evidence,user_no) values(%s,%s,%s,'Pod 1',%s,'Creative','{}',%s)",
                  (org, pid, role.get(s, "Graphic Designer"), "synthetic." + s, 200 + SEATS.index(s)))
        if s in role:
            owner_sql(owner, org, "insert into pulse.role_assignment(org_id,person_id,role_key,unit_id,valid_from) values(%s,%s,%s,%s,'2020-01-01')",
                      (org, pid, role[s], w.pod if s == "manager" else None))
    with api.transaction():
        set_tenant(api, org, seat["admin"])
        for pid in seat.values():
            api.execute("select pulse.login_issue(%s,%s)", (pid, PASSWORD))
    for s, kind in side.items():
        owner_sql(owner, org, "update pulse.person set side=%s where id=%s", (kind, seat[s]))
        owner_sql(owner, org, "update pulse.people_profile set pod=null where person_id=%s", (seat[s],))   # not in a staff pod
    owner_sql(owner, org, "insert into pulse.people_profile(org_id,person_id,role,pod,username,evidence) values(%s,%s,'Editor','Pod 2','editor.two','{}') on conflict do nothing", (org, rep_b))
    owner_sql(owner, org, "update pulse.people_profile set pod='Pod 2' where person_id=%s", (rep_b,))
    owner_sql(owner, org, "update pulse.people_profile set manager_id=%s where person_id=%s", (seat["manager"], seat["staff"]))

    # Projects: everyone (the freelancer is on it), members-only (staff is a member), leadership-only (the manager is on it).
    p_org, p_mem, p_lead = w.project, uuid.uuid4(), uuid.uuid4()
    for pid, name, n, vis in [(p_mem, "Synthetic members project", 1, "members"), (p_lead, "Synthetic leadership project", 2, "leadership")]:
        owner_sql(owner, org, "insert into pulse.project(id,org_id,registry_no,name,title,kind,storage_root,visibility) values(%s,%s,%s,%s,%s,'internal',%s,%s)",
                  (pid, org, w.registry_no + 100 + n, name, name, f"synthetic:{vis}", vis))
    for pid in (p_org, p_mem, p_lead):
        owner_sql(owner, org, "insert into pulse.work_project(org_id,project_id,kind,set_up_at) values(%s,%s,'internal',now()) on conflict (project_id) do update set set_up_at=now()", (org, pid))
    for pid, person in [(p_org, seat["freelancer"]), (p_mem, seat["staff"]), (p_lead, seat["manager"])]:
        owner_sql(owner, org, "insert into pulse.project_member(org_id,project_id,person_id,role) values(%s,%s,%s,'member')", (org, pid, person))

    # Tasks.
    t = {k: uuid.uuid4() for k in ["org_free", "org_other", "mem", "mem_outsider", "lead_proj", "lead_only", "free_own"]}
    rows = [("org_free", p_org, seat["freelancer"], False), ("org_other", p_org, rep_b, False), ("mem", p_mem, seat["staff"], False),
            ("mem_outsider", p_mem, w.editor, False), ("lead_proj", p_lead, seat["manager"], False), ("lead_only", None, seat["leadership"], True),
            ("free_own", None, seat["freelancer"], False)]
    for key, project, person, lead_only in rows:
        owner_sql(owner, org, "insert into pulse.task(id,org_id,project_id,title,assignee_person_id,created_by,status,leadership_only) values(%s,%s,%s,%s,%s,%s,'open',%s)",
                  (t[key], org, project, f"Synthetic task {key}", person, seat["leadership"] if key == "lead_only" else person, lead_only))
    # What hangs off a members-only task and project: time, an attachment, a discussion, an ask, a file.
    owner_sql(owner, org, "insert into pulse.time_entry(org_id,person_id,task_id,project_id,work_date,minutes,source,status) values(%s,%s,%s,%s,current_date,30,'manual','confirmed')",
              (org, seat["staff"], t["mem"], p_mem))
    owner_sql(owner, org, "insert into pulse.work_comment(org_id,project_id,author_id,body) values(%s,%s,%s,'Synthetic private discussion')", (org, p_mem, seat["staff"]))
    owner_sql(owner, org, "insert into pulse.work_comment(org_id,task_id,author_id,body) values(%s,%s,%s,'Synthetic leadership note')", (org, t["lead_only"], seat["leadership"]))
    owner_sql(owner, org, "insert into pulse.index_file(org_id,file_id,name,mime,path,project_id,account_basis,observed_at,event_seq) values(%s,'privacy-mem-file','Private.png','image/png','/Private',%s,'synthetic',now(),1)",
              (org, p_mem))

    # Sales X-Ray: one call and one lead for each rep (staff is in the manager's team; rep B is not).
    calls = {"staff": uuid.uuid4(), "rep_b": uuid.uuid4()}
    for key, person in [("staff", seat["staff"]), ("rep_b", rep_b)]:
        owner_sql(owner, org, "insert into pulse.sales_xray_call(org_id,sx_call_id,title,person_id,linked_by,status) values(%s,%s,%s,%s,%s,'ready')",
                  (org, calls[key], f"Synthetic call {key}", person, person))
        owner_sql(owner, org, "insert into pulse.sales_xray_lead(org_id,sx_lead_id,name,stage,owner_name) values(%s,%s,%s,'new',%s)",
                  (org, uuid.uuid4(), f"Synthetic lead {key}", "Synthetic staff" if key == "staff" else "Editor Two"))

    # Row security straight on the tables the screens read (the API runner checks the screens).
    def count(viewer, sql, args=()):
        return seen(api, org, viewer, sql, args)[0][0]
    for s in SEATS:
        v = seat[s]
        mem_ok = s in ("admin", "staff")
        assert count(v, "select count(*) from pulse.time_entry where project_id=%s", (p_mem,)) == (1 if s in ("admin", "staff") else 0), s
        assert count(v, "select count(*) from pulse.work_comment where project_id=%s", (p_mem,)) == (1 if mem_ok else 0), s
        assert count(v, "select count(*) from pulse.index_file where file_id='privacy-mem-file'") == (1 if mem_ok else 0), s
        assert count(v, "select count(*) from pulse.project_member where project_id=%s", (p_mem,)) == (1 if mem_ok else 0), s
        assert count(v, "select count(*) from pulse.work_comment where task_id=%s", (t["lead_only"],)) == (1 if s in ("leadership", "admin") else 0), s
        assert count(v, "select count(*) from pulse.work_project where project_id=%s", (p_lead,)) == (1 if s in ("leadership", "admin", "manager") else 0), s
        # A freelancer's seat: only their project and their own tasks.
        if s == "freelancer":
            assert {r[0] for r in seen(api, org, v, "select id from pulse.project")} == {p_org}
            assert {r[0] for r in seen(api, org, v, "select id from pulse.task")} == {t["org_free"], t["free_own"]}
        if s == "client":
            assert seen(api, org, v, "select id from pulse.project") == [] and seen(api, org, v, "select id from pulse.task") == []
    # The person doing a task in a members-only project keeps seeing that task (not the project).
    assert count(w.editor, "select count(*) from pulse.task where id=%s", (t["mem_outsider"],)) == 1
    assert count(w.editor, "select count(*) from pulse.project where id=%s", (p_mem,)) == 0
    assert count(w.editor, "select count(*) from pulse.task where id=%s", (t["mem"],)) == 0
    # Sales: own, the manager's team, leadership.
    sx = lambda v: {r[0] for r in seen(api, org, v, "select title from pulse.sales_xray_call")}
    assert sx(seat["staff"]) == {"Synthetic call staff"}
    assert sx(rep_b) == {"Synthetic call rep_b"}
    assert sx(seat["manager"]) == {"Synthetic call staff"}
    assert sx(seat["leadership"]) == sx(seat["admin"]) == {"Synthetic call staff", "Synthetic call rep_b"}
    assert sx(seat["hr"]) == set()
    leads = lambda v: {r[0] for r in seen(api, org, v, "select name from pulse.sales_xray_lead")}
    assert leads(seat["staff"]) == {"Synthetic lead staff"} and leads(rep_b) == {"Synthetic lead rep_b"} and leads(seat["manager"]) == {"Synthetic lead staff"}
    assert leads(seat["leadership"]) == {"Synthetic lead staff", "Synthetic lead rep_b"}
    assert seen(api, org, seat["staff"], "select sum(n)::int from pulse.sales_xray_stage_totals()")[0][0] == 2, "the team's totals for everyone"
    # Defaults keep today's behaviour: an everyone project is seen by every staff seat.
    for s in ("leadership", "admin", "hr", "manager", "staff"):
        assert count(seat[s], "select count(*) from pulse.project where id=%s", (p_org,)) == 1, s

    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(org),
           "TEST_SEATS": json.dumps({s: str(p) for s, p in seat.items()}),
           "TEST_PROJECTS": json.dumps({"org": str(p_org), "members": str(p_mem), "leadership": str(p_lead)}),
           "TEST_TASKS": json.dumps({k: str(v) for k, v in t.items()}), "TEST_REP_B": str(rep_b),
           "PULSE_GMAIL_SEND_ENABLED": "0", "PULSE_DRIVE_UPLOAD_ENABLED": "0"}
    root = Path(__file__).resolve().parents[2]
    env["TEST_TOKENS"] = str(tmp_path / "tokens.json")

    def runner(phase):
        proc = subprocess.run(["node", "test/privacy-access-runner.mjs"], cwd=root / "services/api", env={**env, "TEST_PHASE": phase}, capture_output=True,
                              text=True, timeout=int(os.environ.get("PULSE_MATRIX_TIMEOUT") or 600), check=False)
        assert proc.returncode == 0, proc.stderr[-12000:] + "\n" + proc.stdout[-8000:]
        return proc
    # Passwords are issued to and used by staff; the freelancer and client seats then work through the session they have
    # (in production: their Pulse account's session in this organisation), their side read again on every request.
    for s in side:
        owner_sql(owner, org, "update pulse.person set side='staff' where id=%s", (seat[s],))
    runner("sign-in")
    for s, kind in side.items():
        owner_sql(owner, org, "update pulse.person set side=%s where id=%s", (kind, seat[s]))
    proc = runner("check")
    assert "privacy matrix:" in proc.stdout, proc.stdout[-4000:]
