"""EST-697: HR, presence and task functions count days in each company's time zone (pulse.org.time_zone).

EA sits in Asia/Kolkata and Northwind in Europe/London. At one instant each gets its own day, and EA's results are the
ones the India-only functions gave. Synthetic people only.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from helpers import build_world
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_hr_policy_rules import CONFIG
from test_hr_suite import _staff

KOLKATA, LONDON = "Asia/Kolkata", "Europe/London"
# A zone whose date differs from India's at this instant (UTC-11 before 16:00 in India, UTC+14 from then on), so the
# checks that read now() tell the zones apart at any hour.
APART = "case when (now() at time zone 'Asia/Kolkata')::time<'16:00' then 'Pacific/Pago_Pago' else 'Pacific/Kiritimati' end"


@pytest.fixture
def companies(worker, owner, api):
    """EA in India and Northwind in London, each with HR staff and a seven-day week."""
    ea, north = build_world(worker, owner, api), build_world(worker, owner, api)
    for w, zone in ((ea, KOLKATA), (north, LONDON)):
        w.zone = zone
        _staff(worker, w)
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("update pulse.org set time_zone=%s where id=%s", (zone, w.org))
        with api.transaction():
            set_tenant(api, w.org, w.lead)
            api.execute("select pulse.hr_flow_defaults()")
            api.execute("update pulse.hr_policy set work_days=array[1,2,3,4,5,6,7],tracking_from='2026-01-01'")
    return ea, north


def test_no_pulse_function_names_india(admin):
    assert admin.execute("select count(*) n from pg_proc p join pg_namespace s on s.oid=p.pronamespace "
                         "where s.nspname in ('pulse','pulse_priv','privacy','pulse_route') "
                         "and p.prosrc like '%Asia/Kolkata%'").fetchone()["n"] == 0


def test_no_column_default_names_india(admin):
    """R51 (0390): only the company's own setting, pulse.org.time_zone, may default to India (the wizard always fills it)."""
    rows = admin.execute("select c.relname||'.'||a.attname col from pg_attrdef d join pg_class c on c.oid=d.adrelid "
                         "join pg_namespace s on s.oid=c.relnamespace join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum "
                         "where s.nspname in ('pulse','pulse_priv','privacy') and pg_get_expr(d.adbin,d.adrelid) like '%%Asia/Kolkata%%'").fetchall()
    assert [r["col"] for r in rows] == ["org.time_zone"]


def test_new_rows_default_to_the_company_day(worker, companies):
    """An attendance row without a date and a review calendar without a zone take their company's, at one instant."""
    with worker.transaction():
        for w in companies:
            set_tenant(worker, w.org)
            day = worker.execute("insert into pulse.attendance_entry(org_id,person_id,checked_in_at) values(%s,%s,now()) "
                                 "returning work_date", (w.org, w.editor)).fetchone()["work_date"]
            assert day == worker.execute("select (now() at time zone %s)::date d", (w.zone,)).fetchone()["d"]
            task = worker.execute("insert into pulse.task(id,org_id,title,status) values(gen_random_uuid(),%s,'Synthetic zone task','open') "
                                  "returning review_calendar", (w.org,)).fetchone()["review_calendar"]
            assert task == w.zone


def test_task_due_date_is_six_pm_in_the_company(api, companies):
    due = {}
    for w in companies:
        with api.transaction():
            set_tenant(api, w.org, w.lead)
            task = api.execute("select pulse.task_save(null,%s) id",
                               (Jsonb({"title": "Synthetic due task", "dueOn": "2026-11-10"}),)).fetchone()["id"]
            due[w.zone] = api.execute("select due_at from pulse.task where id=%s", (task,)).fetchone()["due_at"]
    assert due == {KOLKATA: datetime(2026, 11, 10, 12, 30, tzinfo=timezone.utc),
                   LONDON: datetime(2026, 11, 10, 18, 0, tzinfo=timezone.utc)}


def test_half_day_reads_arrival_in_the_company(api, worker, companies):
    """The same arrival instant, 11:45 UTC: 17:15 in India (after the 13:00 cut-off), before noon in London."""
    half = {}
    for w in companies:
        with api.transaction():
            set_tenant(api, w.org, w.lead)
            today = api.execute("select (now() at time zone pulse.org_time_zone())::date d").fetchone()["d"]
            api.execute("select pulse.hr_rule_confirm('half_day',%s,%s,0,null)",
                        (json.dumps({**CONFIG["half_day"], "timezone": w.zone}), today))
        day = today + timedelta(days=1)
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at,checked_out_at) "
                           "values(%s,%s,%s,(%s::date+time '11:45') at time zone 'UTC',(%s::date+time '17:30') at time zone 'UTC')",
                           (w.org, w.editor, day, day, day))
        with api.transaction():
            set_tenant(api, w.org, w.lead)
            half[w.zone] = api.execute("select half_day from pulse.hr_rule_days(%s,%s,%s)", (w.editor, day, day)).fetchone()["half_day"]
    assert half == {KOLKATA: True, LONDON: False}


def _present(admin, w):
    """The editor's phone has held every office signal for ten minutes; HR allows automatic check-in all day."""
    with admin.transaction():
        set_tenant(admin, w.org)
        admin.execute("update pulse.hr_policy set attendance_enabled=true,presence_auto_checkin=true,"
                       "shift_start='00:00',shift_end='00:00'")
        office = admin.execute("insert into pulse.presence_office(org_id,name,lat,lng) values(%s,'Synthetic office',0,0) "
                                "returning id", (w.org,)).fetchone()["id"]
        device = admin.execute("insert into pulse.native_device(org_id,person_id,name,platform) "
                                "values(%s,%s,'Synthetic phone','android') returning id", (w.org, w.editor)).fetchone()["id"]
        admin.execute("insert into pulse.companion_presence(org_id,device_id,person_id,office_id,consent,auto_consent,"
                       "region_inside,region_at,wifi_strength,wifi_at,ip_matched,ip_at,dwell_started_at) "
                       "values(%s,%s,%s,%s,true,true,true,now(),40,now(),true,now(),now()-interval '10 minutes')",
                       (w.org, device, w.editor, office))


def _tick_day(admin, w, zone):
    """The day the worker's presence tick checks w's editor in on, with the company in zone (a savepoint)."""
    with admin.transaction() as sp:
        admin.execute("update pulse.org set time_zone=%s where id=%s", (zone, w.org))
        admin.execute("set local role pulse_worker")
        set_tenant(admin, w.org)
        admin.execute("select pulse.companion_presence_tick(null)")
        # ATT (0861): the engine counts the dwell from its own first confident tick; the phone's ten minutes at the
        # office are that memory, then the next tick checks the editor in.
        admin.execute("reset role")
        admin.execute("update pulse.attendance_presence_state set confident_since=confident_since-interval '10 minutes' where person_id=%s", (w.editor,))
        admin.execute("set local role pulse_worker")
        admin.execute("select pulse.companion_presence_tick(null)")
        row = admin.execute("select work_date from pulse.attendance_entry where person_id=%s", (w.editor,)).fetchone()
        raise psycopg.Rollback(sp)
    return row and row["work_date"]


def _withdrawable(admin, w, zone, start):
    """Whether w's editor may still withdraw approved leave starting on start, with the company in zone (a savepoint)."""
    with admin.transaction() as sp:
        admin.execute("update pulse.org set time_zone=%s where id=%s", (zone, w.org))
        set_tenant(admin, w.org)
        leave = admin.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,status,days) "
                              "values(%s,%s,%s,%s,'casual','approved',1) returning id", (w.org, w.editor, start, start)).fetchone()["id"]
        flow = admin.execute("select id from pulse.hr_flow where source_id=%s", (leave,)).fetchone()["id"]
        admin.execute("set local role pulse_api")
        set_tenant(admin, w.org, w.editor)
        try:
            with admin.transaction():
                admin.execute("select pulse.hr_flow_decide(%s,'cancelled',null)", (flow,))
            allowed = True
        except psycopg.errors.InsufficientPrivilege:
            allowed = False
        raise psycopg.Rollback(sp)
    return allowed


def test_presence_day_and_leave_cut_off_at_one_instant(admin, companies):
    ea, north = companies
    for w in companies:
        _present(admin, w)
    with admin.transaction():          # one transaction, so now() is one instant for every company and zone
        day = lambda zone: admin.execute("select (now() at time zone %s)::date d", (zone,)).fetchone()["d"]
        apart = admin.execute(f"select {APART} z").fetchone()["z"]
        assert day(apart) != day(KOLKATA)
        for w, zone in ((ea, KOLKATA), (north, LONDON), (north, apart)):
            today = day(zone)
            assert _tick_day(admin, w, zone) == today, zone
            assert not _withdrawable(admin, w, zone, today), zone
            assert _withdrawable(admin, w, zone, today + timedelta(days=1)), zone


def test_worker_without_a_company_still_runs(worker, companies):
    with worker.transaction():
        assert worker.execute("select pulse.org_time_zone() z").fetchone()["z"] == "UTC"
        assert worker.execute("select pulse.companion_presence_tick(null) r").fetchone()["r"] == {}
        assert worker.execute("select pulse.onboarding_tick() n").fetchone()["n"] == 0
        assert worker.execute("select pulse.hr_emergency_remind() n").fetchone()["n"] == 0
