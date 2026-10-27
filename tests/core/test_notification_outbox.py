"""R27 real RLS/transaction acceptance on disposable synthetic tenants; providers are sinks."""
import json
import os
import subprocess
import uuid
from pathlib import Path

from conftest import ADMIN_URL, dsn
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from helpers import build_world
from psycopg.pq import TransactionStatus
from psycopg import sql
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from pulse_sdk import migrate
from pulse_workers import notifications
from test_hr_suite import _staff


def test_populated_upgrade_preserves_each_tenant_under_forced_rls(admin, tmp_path):
    """An empty install cannot exercise the owner-role backfill against existing inbox rows."""
    dbname = "pulse_ci_r27_upgrade_" + uuid.uuid4().hex
    assert dbname.startswith("pulse_ci_r27_upgrade_")
    admin.execute(sql.SQL("create database {}").format(sql.Identifier(dbname)))
    try:
        with psycopg.connect(make_conninfo(ADMIN_URL, dbname=dbname), autocommit=True) as scratch:
            migrate.bootstrap_scratch(scratch)
            directory = tmp_path / "upgrade-migrations"
            directory.mkdir()
            files = migrate.migration_files()
            target = next(path for version, path in files if version == "0135")
            for version, path in files:
                if version < "0135":
                    (directory / path.name).write_text(path.read_text())
            migrate.migrate(scratch, directory, owner="pulse_owner", verbose=False)
            prior = []
            for status, code in (("active", "RA"), ("suspended", "RB")):
                org, person, notice = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
                with scratch.transaction():
                    scratch.execute("set local role pulse_owner")
                    set_tenant(scratch, org)
                    scratch.execute("insert into pulse.org(id,slug,name,code,status) values(%s,%s,'Synthetic upgrade',%s,%s)", (org, str(org), code, status))
                    scratch.execute("insert into pulse.person(id,org_id,display_name,side,status) values(%s,%s,'Synthetic upgrade person','staff','active')", (person, org))
                    scratch.execute("insert into pulse.notification(id,org_id,person_id,title,href,created_at) values(%s,%s,%s,'Synthetic legacy update','/me',clock_timestamp()-interval '3 days')", (notice, org, person))
                prior.append((org, person, notice))
            with scratch.transaction():
                scratch.execute("set local role pulse_owner")
                assert scratch.execute("select count(*) from pulse.notification").fetchone()[0] == 0
            (directory / target.name).write_text(target.read_text())
            assert migrate.migrate(scratch, directory, owner="pulse_owner", verbose=False) == ["0135"]
            assert migrate.migrate(scratch, directory, owner="pulse_owner", verbose=False) == []
            for org, person, notice in prior:
                with scratch.transaction():
                    scratch.execute("set local role pulse_owner")
                    set_tenant(scratch, org)
                    row = scratch.execute("select id,subject_id,event_key,event_type,expires_at=created_at+interval '48 hours' from pulse.notification").fetchone()
                    assert row == (notice, person, str(notice), "update.self", True)
                    assert scratch.execute("select count(*) from pulse.notification").fetchone()[0] == 1
    finally:
        # This uniquely named database contains only the synthetic rows created above.
        admin.execute(sql.SQL("drop database {} with (force)").format(sql.Identifier(dbname)))


@pytest.fixture
def notice_world(worker, owner, api):
    w = build_world(worker, owner, api)
    _staff(worker, w)
    return w


def holiday(api, w):
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        hid = api.execute("insert into pulse.holiday(org_id,day,name) values(%s,current_date+1,'Synthetic holiday') returning id", (w.org,)).fetchone()["id"]
        return hid


def browser(worker, w, person=None):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("insert into pulse.web_push_subscription(org_id,person_id,endpoint,keys,created_at) values(%s,%s,%s,'{}',clock_timestamp()-interval '1 hour') returning id", (w.org, person or w.editor, f"https://fcm.googleapis.com/fcm/send/{w.org}/{person or w.editor}")).fetchone()["id"]


def claim(worker, w, channel="web"):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select * from pulse.notification_outbox_claim(%s)", (channel,)).fetchall()


def dispatch(worker, w, job):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select pulse.notification_outbox_dispatch(%s,%s) p", (job["id"], job["lease_token"])).fetchone()["p"]


def finish(worker, w, job, outcome):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("select pulse.notification_outbox_finish(%s,%s,%s)", (job["id"], job["lease_token"], outcome))


def owner_tx(owner, w):
    owner.execute("set local role pulse_owner")
    set_tenant(owner, w.org)


def test_upgrade_backfills_existing_notifications_with_forced_tenant_rls(worker, owner, api):
    worlds = [build_world(worker, owner, api), build_world(worker, owner, api)]
    source = (Path(__file__).resolve().parents[2] / "db/migrations/0135_notification_outbox.sql").read_text()
    start = "do $$declare tenant uuid;previous_org"
    backfill = start + source.split(start, 1)[1].split("end $$;", 1)[0] + "end $$;"
    # Simulate rows from before 0135, then run its exact upgrade block as the owner with no tenant selected.
    # Roll back the entire schema/data setup so the normal suite keeps the enforced post-upgrade contract.
    with owner.transaction(force_rollback=True):
        owner.execute("set local role pulse_owner")
        owner.execute("alter table pulse.notification alter column subject_id drop not null, alter column event_key drop not null")
        owner.execute("alter table pulse.notification disable trigger notification_z_contract")
        ids = []
        for w in worlds:
            set_tenant(owner, w.org)
            row = owner.execute("insert into pulse.notification(org_id,person_id,title,href) values(%s,%s,'Synthetic legacy update','/me') returning id", (w.org, w.editor)).fetchone()
            ids.append(row["id"])
        owner.execute("alter table pulse.notification enable trigger notification_z_contract")
        owner.execute("select set_config('pulse.org_id','',true)")
        owner.execute(backfill)
        assert owner.execute("select current_setting('pulse.org_id') tenant").fetchone()["tenant"] == ""
        for w, nid in zip(worlds, ids, strict=True):
            set_tenant(owner, w.org)
            row = owner.execute("select subject_id,event_key,expires_at=created_at+interval '48 hours' expiry from pulse.notification where id=%s", (nid,)).fetchone()
            assert row["subject_id"] == w.editor and row["event_key"] == str(nid) and row["expiry"]
        owner.execute("alter table pulse.notification alter column subject_id set not null, alter column event_key set not null")


def test_event_identity_idempotent_announcement_and_current_recipient(worker, owner, api, notice_world):
    w = notice_world
    browser(worker, w)
    hid = holiday(api, w)
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        row = api.execute("select * from pulse.notification where subject_id=%s", (hid,)).fetchone()
        assert row["event_type"] == "holiday.announced"
        assert row["subject_type"] == "holiday" and row["person_id"] == w.editor
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("update pulse.holiday set name=name where id=%s", (hid,))
    jobs = claim(worker, w)
    assert len(jobs) == 1
    assert not claim(worker, w)  # A second worker cannot claim the lease.
    payload = dispatch(worker, w, jobs[0])
    assert payload["id"] == str(row["id"])
    assert "Synthetic holiday" not in json.dumps(payload)
    assert payload["href"] == "/notifications?event=" + str(row["id"])
    finish(worker, w, jobs[0], "accepted")
    finish(worker, w, jobs[0], "retry")  # Stale completion cannot reset accepted.
    assert not claim(worker, w)


def test_upgrade_respects_legacy_provider_acceptance(worker, owner, api, notice_world):
    w = notice_world
    sid = browser(worker, w)
    hid = holiday(api, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.web_push_delivery set status='accepted' where subscription_id=%s", (sid,))
    assert not claim(worker, w)
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("update pulse.holiday set name='New synthetic revision' where id=%s", (hid,))
    job = claim(worker, w)[0]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.web_push_delivery set status='accepted' where notification_id=%s and subscription_id=%s", (job["notification_id"], sid))
    assert dispatch(worker, w, job) is None  # An old worker accepted it during the rolling upgrade.


def test_expired_undispatched_lease_recovers_and_retry_attempts_are_bounded(worker, owner, api, notice_world):
    w = notice_world
    browser(worker, w)
    holiday(api, w)
    first = claim(worker, w)[0]
    with owner.transaction():
        owner_tx(owner, w)
        owner.execute("update pulse.notification_delivery set lease_until=clock_timestamp()-interval '1 second' where id=%s", (first["id"],))
    second = claim(worker, w)[0]
    assert second["lease_token"] != first["lease_token"]
    assert dispatch(worker, w, first) is None
    for index in range(5):
        assert dispatch(worker, w, second)
        finish(worker, w, second, "retry")
        with owner.transaction():
            owner_tx(owner, w)
            owner.execute("update pulse.notification_delivery set retry_at=clock_timestamp()-interval '1 second' where id=%s", (second["id"],))
        rows = claim(worker, w)
        if index < 4:
            assert len(rows) == 1
            second = rows[0]
        else:
            assert not rows
    with worker.transaction():
        set_tenant(worker, w.org)
        row = worker.execute("select status,attempts from pulse.notification_delivery where id=%s", (first["id"],)).fetchone()
        assert row == {"status": "failed", "attempts": 5}


def test_revocation_between_claim_and_dispatch_suppresses(worker, owner, api, notice_world):
    w = notice_world
    sid = browser(worker, w)
    holiday(api, w)
    job = claim(worker, w)[0]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.web_push_subscription set disabled_at=clock_timestamp() where id=%s", (sid,))
    assert dispatch(worker, w, job) is None
    assert not claim(worker, w)


def test_current_hr_role_revoked_before_dispatch(worker, owner, api, notice_world):
    w = notice_world
    browser(worker, w, w.lead)
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("select pulse.hr_flow_defaults()")
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,days) values(%s,%s,current_date+10,current_date+10,'unpaid',1)", (w.org, w.editor))
    job = claim(worker, w)[0]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.role_assignment set valid_to=current_date-1 where person_id=%s and role_key='hr'", (w.lead,))
    assert dispatch(worker, w, job) is None
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        assert not api.execute("select pulse.notification_authorized(%s,%s) ok", (job["notification_id"], w.lead)).fetchone()["ok"]


def test_native_platform_selection_and_revoked_device(worker, owner, api, notice_world):
    w = notice_world
    with owner.transaction():
        owner_tx(owner, w)
        for platform in ("ios", "android", "macos", "windows", "chrome"):
            owner.execute("insert into pulse.native_device(org_id,person_id,name,platform,push_token,created_at) values(%s,%s,'Synthetic',%s,%s,clock_timestamp()-interval '1 hour')", (w.org, w.editor, platform, "a" * 64))
    holiday(api, w)
    jobs = claim(worker, w, "native")
    assert len(jobs) == 2
    with owner.transaction():
        owner_tx(owner, w)
        owner.execute("update pulse.native_device set revoked_at=clock_timestamp() where id=%s", (jobs[0]["destination_id"],))
    assert dispatch(worker, w, jobs[0]) is None
    payload = dispatch(worker, w, jobs[1])
    assert payload["destination"]["platform"] in ("ios", "android")
    finish(worker, w, jobs[1], "expired")
    with worker.transaction():
        set_tenant(worker, w.org)
        row = worker.execute("select id,push_token from pulse.native_device where id=%s", (jobs[1]["destination_id"],)).fetchone()
        assert row and row["push_token"] is None  # The record is retained.


def test_retry_backoff_expiry_and_ambiguous_dispatch_never_replayed(worker, owner, api, notice_world):
    w = notice_world
    browser(worker, w)
    holiday(api, w)
    job = claim(worker, w)[0]
    assert dispatch(worker, w, job)
    finish(worker, w, job, "retry")
    assert not claim(worker, w)
    with owner.transaction():
        owner_tx(owner, w)
        owner.execute("update pulse.notification_delivery set retry_at=clock_timestamp()-interval '1 second' where id=%s", (job["id"],))
    retry = claim(worker, w)[0]
    assert retry["attempts"] == 1 and retry["lease_token"] != job["lease_token"]
    assert dispatch(worker, w, retry)
    with owner.transaction():
        owner_tx(owner, w)
        owner.execute("update pulse.notification_delivery set lease_until=clock_timestamp()-interval '1 second' where id=%s", (job["id"],))
    assert not claim(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select status from pulse.notification_delivery where id=%s", (job["id"],)).fetchone()["status"] == "uncertain"
    # Another event expires while leased; neither provider nor inbox badges may treat it as current.
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("update pulse.holiday set name='Changed synthetic holiday'")
    expired = claim(worker, w)[0]
    with owner.transaction():
        owner_tx(owner, w)
        owner.execute("update pulse.notification set expires_at=clock_timestamp()-interval '1 second' where id=%s", (expired["notification_id"],))
    assert dispatch(worker, w, expired) is None


def test_stale_task_recipient_and_tenant_isolation(worker, owner, api, notice_world):
    w = notice_world
    browser(worker, w)
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        tid = api.execute("insert into pulse.task(org_id,title,owner_id) values(%s,'Synthetic assignment',%s) returning id", (w.org, w.editor)).fetchone()["id"]
    old = claim(worker, w)[0]
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("update pulse.task set owner_id=%s where id=%s", (w.editor2, tid))
    assert dispatch(worker, w, old) is None
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert not api.execute("select pulse.notification_authorized(%s,%s) ok", (old["notification_id"], w.editor)).fetchone()["ok"]
    other = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, other.org)
        assert not worker.execute("select * from pulse.notification_delivery where id=%s", (old["id"],)).fetchall()
        assert worker.execute("select pulse.notification_outbox_dispatch(%s,%s) p", (old["id"], old["lease_token"])).fetchone()["p"] is None


def test_processed_payroll_requires_explicit_accounts_and_idempotent_state(worker, owner, api, notice_world):
    w = notice_world
    for person in (w.editor, w.lead, w.manager):
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            set_tenant(api, w.org, person)
            api.execute("select pulse.payroll_notice_processed(%s,'2026-10-01','test-batch')", (w.editor,))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.payroll_notice_grant(%s,false)", (w.editor2,))
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        first = api.execute("select pulse.payroll_notice_processed(%s,'2026-10-01','test-batch') id", (w.editor,)).fetchone()["id"]
        assert api.execute("select pulse.payroll_notice_processed(%s,'2026-10-01','test-batch') id", (w.editor,)).fetchone()["id"] == first
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        rows = api.execute("select * from pulse.notification where event_type='payroll.processed'").fetchall()
        assert len(rows) == 1 and rows[0]["subject_id"] == first
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.payroll_notice_grant(%s,true)", (w.editor2,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor2)
        api.execute("select pulse.payroll_notice_processed(%s,'2026-11-01','test-batch-2')", (w.editor,))


def test_reminder_gate_bounds_snooze_departure_advisory(worker, owner, api, notice_world):
    w = notice_world
    at = datetime.now(timezone.utc)
    day = at.date()
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        entry = api.execute("insert into pulse.attendance_entry(org_id,person_id,work_date) values(%s,%s,%s) returning id", (w.org, w.editor, day)).fetchone()["id"]
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select pulse.notification_attendance_prompt(%s,%s,'departure',%s) id", (w.editor, day, at)).fetchone()["id"] is None
    with owner.transaction():
        owner_tx(owner, w)
        owner.execute("insert into pulse.notification_reminder_policy(org_id,enabled,approval_ref,timezone) values(%s,true,'synthetic-approved-policy','UTC')", (w.org,))
    with worker.transaction():
        set_tenant(worker, w.org)
        first = worker.execute("select pulse.notification_attendance_prompt(%s,%s,'departure',%s) id", (w.editor, day, at)).fetchone()["id"]
        assert first
        assert worker.execute("select pulse.notification_attendance_prompt(%s,%s,'departure',%s) id", (w.editor, day, at)).fetchone()["id"] is None
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.notification_snooze(%s,60,false)", (first,))
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select pulse.notification_attendance_prompt(%s,%s,'end',%s) id", (w.editor, day, at + timedelta(minutes=20))).fetchone()["id"] is None
        second = worker.execute("select pulse.notification_attendance_prompt(%s,%s,'end',%s) id", (w.editor, day, at + timedelta(minutes=61))).fetchone()["id"]
        assert second
        assert worker.execute("select pulse.notification_attendance_prompt(%s,%s,'done',%s) id", (w.editor, day, at + timedelta(minutes=90))).fetchone()["id"] is None
        assert worker.execute("select checked_out_at from pulse.attendance_entry where id=%s", (entry,)).fetchone()["checked_out_at"] is None


def test_approved_night_shift_quiet_hours_and_channel_preferences(worker, owner, api, notice_world):
    w = notice_world
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.companion_notification_settings(org_id,person_id,settings) values(%s,%s,%s)", (w.org, w.editor, Jsonb({"quiet": True, "timezone": "UTC", "nightShift": True})))
    with owner.transaction():
        owner_tx(owner, w)
        owner.execute("insert into pulse.notification_reminder_policy(org_id,enabled,approval_ref,timezone) values(%s,true,'synthetic-approved-night','UTC')", (w.org,))
        shift = owner.execute("insert into pulse.shift(org_id,name,start_time,end_time,work_days) values(%s,'Synthetic night','22:00','06:00',array[1,2,3,4,5,6,7]) returning id", (w.org,)).fetchone()["id"]
        owner.execute("insert into pulse.person_shift(org_id,person_id,shift_id,valid_from) values(%s,%s,%s,'2026-01-01')", (w.org, w.editor, shift))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        for stamp, allowed in [("2026-10-09T20:59:59Z", True), ("2026-10-09T21:00:00Z", False), ("2026-10-09T23:00:00Z", True), ("2026-10-10T02:00:00Z", True), ("2026-10-10T06:00:00Z", False), ("2026-10-10T08:00:00Z", True)]:
            assert api.execute("select pulse.notification_ping_allowed(%s,'attendance','native',%s) ok", (w.editor, stamp)).fetchone()["ok"] is allowed
        api.execute("update pulse.companion_notification_settings set settings=settings||'{\"channels\":{\"native\":false}}'")
        assert not api.execute("select pulse.notification_ping_allowed(%s,'attendance','native','2026-10-09T23:00:00Z') ok", (w.editor,)).fetchone()["ok"]


def test_scheduler_start_and_end_boundaries_across_approved_midnight(worker, owner, api, notice_world):
    w = notice_world
    with owner.transaction():
        owner_tx(owner, w)
        owner.execute("insert into pulse.notification_reminder_policy(org_id,enabled,approval_ref,timezone) values(%s,true,'synthetic-approved-night','UTC')", (w.org,))
        shift = owner.execute("insert into pulse.shift(org_id,name,start_time,end_time,work_days) values(%s,'Synthetic night','22:00','06:00',array[1,2,3,4,5,6,7]) returning id", (w.org,)).fetchone()["id"]
        for person in (w.editor, w.editor2):
            owner.execute("insert into pulse.person_shift(org_id,person_id,shift_id,valid_from) values(%s,%s,%s,'2026-01-01')", (w.org, person, shift))
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        api.execute("insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at) values(%s,%s,'2026-10-09','2026-10-09T22:00:00Z')", (w.org, w.editor2))
    with worker.transaction():
        set_tenant(worker, w.org)
        # ATT (0861): the end-of-shift "Still working?" is the presence engine's now (it checks out by itself and asks only
        # on a conflict), so the scheduler sends the start reminder alone: none at 06:15.
        for stamp, count in [("2026-10-09T22:14:59Z", 0), ("2026-10-09T22:15:00Z", 1), ("2026-10-09T22:15:00Z", 0), ("2026-10-10T06:00:00Z", 0), ("2026-10-10T06:14:59Z", 0), ("2026-10-10T06:15:00Z", 0), ("2026-10-10T06:15:00Z", 0)]:
            assert worker.execute("select pulse.notification_reminder_tick(%s) n", (stamp,)).fetchone()["n"] == count
        assert worker.execute("select checked_out_at from pulse.attendance_entry where person_id=%s", (w.editor2,)).fetchone()["checked_out_at"] is None


def test_hr_copies_commit_before_sink_and_repeated_job_cannot_send(worker, owner, api, notice_world, monkeypatch):
    w = notice_world
    monkeypatch.setenv("PULSE_CI", "1")
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("select pulse.hr_flow_defaults()")
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,days,reason) values(%s,%s,current_date+10,current_date+10,'unpaid',1,'Private synthetic note')", (w.org, w.editor))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse_priv.telegram_person(org_id,person_id,chat_id,verified_by) values(%s,%s,'123456789',%s)", (w.org, w.editor, w.manager))
        worker.execute("update pulse.notification set telegram_status='queued' where person_id=%s", (w.editor,))
    original = notifications.telegram
    def checked_sink(method, payload):
        assert worker.info.transaction_status == TransactionStatus.IDLE
        return original(method, payload)
    monkeypatch.setattr(notifications, "telegram", checked_sink)
    notifications.test_sink.clear()
    assert notifications.drain(worker, w.org)["sent"] > 0
    assert notifications.drain(worker, w.org)["sent"] == 0
    assert "Private synthetic note" not in json.dumps(notifications.test_sink)


def test_notification_self_controls_api_and_payroll_gate(worker, owner, api, notice_world, tmp_path):
    w = notice_world
    config = conninfo_to_dict(dsn("api")); config["database"] = config.pop("dbname")
    report_path = tmp_path / "api-outbox.json"
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config),
           "R27_REPORT": str(report_path), "TEST_PEOPLE": json.dumps({
               "member": {"id": str(w.editor), "email": w.editor_handle},
               "other": {"id": str(w.editor2), "email": "editor2@" + w.domain},
               "admin": {"id": str(w.manager), "email": "admin@estateautopilots.com"},
           })}
    result = subprocess.run(["node", "test/notification-outbox-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, (result.stdout + result.stderr)[-4000:]
    receipt = json.loads(report_path.read_text())
    assert receipt["apiChecks"] >= 30
    if os.environ.get("R27_RECEIPT_DIR"):
        destination = Path(os.environ["R27_RECEIPT_DIR"]); destination.mkdir(parents=True, exist_ok=True)
        (destination / "notification-outbox-api.json").write_text(json.dumps(receipt, indent=2) + "\n")
