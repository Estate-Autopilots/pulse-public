"""QA-E2E: the whole product driven end to end by synthetic people on a disposable agency (owner-approved, 11 Oct 2026).

The scenario driver (tests/e2e/scenarios/driver.mjs) starts the real API on a local port against this database and
scripts personas through it: sign-in, attendance across midnight, leave and corrections, office presence from a
paired phone, chats of every kind, tasks, asks and the pool, and every notification channel through the outbox (in-app,
web push and native push in sink mode; Telegram and e-mail are only counted). Every request is recorded with its
response time. With PULSE_AUTH_BROWSER=1 the browser journeys (tests/e2e/scenarios/browser.mjs) run two and three
personas side by side on the production web build (NEXT_DIST_DIR=.next-build), desktop 1440 and phone 390, light and dark.

Reports: PULSE_QA_E2E_OUT=<dir> keeps report.json, report.md, requests.jsonl and screenshots (default: pytest's tmp dir).
Every person, message and office here is invented; nothing is sent anywhere."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest
from conftest import ADMIN_URL, GROUPS, MODE, dsn, role_url
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_chats_browser import _seed_chats
from test_tasks_rt1 import as_, team  # noqa: F401  (team is a fixture)

ROOT = Path(__file__).resolve().parents[2]
PASSWORD = "Synthetic-issued-2026!"
# Synthetic HQ, a made-up point in Pune; the phone's geofence and Wi-Fi rules are tested against it.
HQ = {"lat": 18.5204, "lng": 73.8567, "ssid": "Synthetic-HQ", "bssid": "a4:2b:b0:11:22:33", "ip": "203.0.113.0/24"}


def _config(value):
    d = conninfo_to_dict(value)
    d["database"] = d.pop("dbname")
    return json.dumps(d)


def _seed_qa(api, worker, owner, w):
    """The CHATS-2 synthetic agency (two pods, departments, clients, tasks, chats, presence), plus what a full run needs:
    password sign-ins for every persona, a department chat, an office with Wi-Fi and a public network, today as a
    working day (the suite runs on Sundays too), reminder timing approved, and a sensible HR flow."""
    seeded = _seed_chats(api, worker, owner, w)
    people = seeded["people"]
    # Two people with nothing recorded today: Zoya works from a laptop (the desktop's own office presence), Rifob
    # arrives just after a scheduled check-in reminder.
    extra = {"zoya": ("Zoya Sheikh", "Designer", 31), "rifob": ("Rifob Desai", "Editor", 32)}
    with worker.transaction():
        set_tenant(worker, w.org)
        for key, (name, role, no) in extra.items():
            pid = uuid.uuid4()
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, name))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,user_no,username,pod,department) values(%s,%s,%s,'test',%s,%s,'Pod 2','Creative')", (w.org, pid, role, no, key))
            people = {**people, key: str(pid)}
    with owner.transaction():
        set_tenant(owner, w.org)
        # Every weekday is a working day for this synthetic company, so check-in tests do not depend on the calendar;
        # the weekly-off path is exercised by the driver on its own.
        owner.execute("update pulse.hr_policy set work_days='{1,2,3,4,5,6,7}',presence_dwell_minutes=1,presence_leave_minutes=5 where org_id=%s", (w.org,))
        owner.execute("""insert into pulse.notification_reminder_policy(org_id,enabled,approval_ref) values(%s,true,'qa-e2e synthetic')
                         on conflict(org_id) do update set enabled=true,approval_ref=excluded.approval_ref""", (w.org,))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        for pid in people.values():
            api.execute("select pulse.login_issue(%s,%s)", (pid, PASSWORD))
        office = api.execute(
            """insert into pulse.presence_office(org_id,name,lat,lng,radius_m,wifi,active,updated_by,public_ip_ranges)
               values(%s,'Synthetic HQ',%s,%s,150,%s,true,%s,%s::cidr[]) returning id""",
            (w.org, HQ["lat"], HQ["lng"], json.dumps([{"ssid": HQ["ssid"], "bssids": [HQ["bssid"]]}]), w.manager, [HQ["ip"]]),
        ).fetchone()["id"]
    with worker.transaction():
        set_tenant(worker, w.org)
        usernames = {r["person_id"]: r["username"] for r in worker.execute("select person_id,username from pulse.people_profile where org_id=%s", (w.org,))}
        roles = {str(r["person_id"]): r["roles"] for r in worker.execute(
            "select person_id,array_agg(role_key order by role_key) roles from pulse.role_assignment where org_id=%s and current_date between valid_from and coalesce(valid_to,'infinity') group by 1", (w.org,))}
    personas = {key: {"id": pid, "username": usernames[uuid.UUID(pid)], "roles": roles.get(pid, [])} for key, pid in people.items()}
    return {**seeded, "personas": personas, "office": str(office), "hq": HQ, "password": PASSWORD, "org": str(w.org)}


def _run(script, env, timeout):
    p = subprocess.run(["node", script], cwd=ROOT / "tests/e2e/scenarios", env=env, capture_output=True, text=True, timeout=timeout, check=False)
    return p


def _owner_config():
    """The owner role as conftest's owner fixture connects (fixtures only: moving stored times the worker may not touch)."""
    if MODE["value"] == "superuser":
        return _config(role_url("migrate"))
    d = json.loads(_config(ADMIN_URL))
    d["options"] = f"-c role={GROUPS['owner']}"
    return json.dumps(d)


def _env(w, seeded, out):
    # POLISH-2: keep what a later walk through the same disposable database needs (KEEP=1 runs keep the database):
    # the seed and the scratch logins of this run (synthetic, never a production credential).
    if os.environ.get("PULSE_QA_E2E_SEED_FILE"):
        Path(os.environ["PULSE_QA_E2E_SEED_FILE"]).write_text(json.dumps({"seed": seeded, "api": _config(dsn("api")), "worker": _config(dsn("worker")),
                                                                         "owner": _owner_config()}, default=str))
    return {**os.environ, "PULSE_CI": "1", "PULSE_NOTIFICATION_MODE": "sink", "PULSE_AUTH_MAIL_MODE": "sink",
            "TEST_API_CONFIG": _config(dsn("api")), "TEST_WORKER_CONFIG": _config(dsn("worker")), "TEST_OWNER_CONFIG": _owner_config(),
            "TEST_SEED": json.dumps(seeded, default=str), "PULSE_QA_E2E_OUT": str(out)}


def test_qa_e2e_backend_scenarios(worker, owner, api, team, tmp_path):  # noqa: F811
    w = team
    seeded = _seed_qa(api, worker, owner, w)
    out = Path(os.environ.get("PULSE_QA_E2E_OUT") or tmp_path) / "backend"
    out.mkdir(parents=True, exist_ok=True)
    p = _run("driver.mjs", _env(w, seeded, out), 1500)
    report = json.loads((out / "report.json").read_text()) if (out / "report.json").exists() else None
    assert p.returncode == 0 and report and not report["failed"], (p.stderr + p.stdout)[-8000:]
    assert report["requests"] >= 250, report["requests"]


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser journeys run in CI with PULSE_AUTH_BROWSER=1")
def test_qa_e2e_browser_journeys(worker, owner, api, team, tmp_path):  # noqa: F811
    w = team
    seeded = _seed_qa(api, worker, owner, w)
    out = Path(os.environ.get("PULSE_QA_E2E_OUT") or tmp_path) / "browser"
    out.mkdir(parents=True, exist_ok=True)
    p = _run("browser.mjs", {**_env(w, seeded, out), "PULSE_PUBLIC_LOGIN_ENABLED": "1"}, 2400)
    report = json.loads((out / "report.json").read_text()) if (out / "report.json").exists() else None
    assert p.returncode == 0 and report and not report["failed"], (p.stderr + p.stdout)[-8000:]
