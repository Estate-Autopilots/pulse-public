"""ATT (21 Oct 2026): attendance that is right by itself.

The presence rules (pulse.presence_score, pulse.presence_decide: pure) with real-looking signal timelines, minute by
minute, and the engine (pulse.attendance_presence_tick) on a synthetic tenant: automatic check-in, a lunch break, the
departure checked out at the last confident moment, the shift-end check-out for a session with no signal, one
question only on a real conflict, the person's one-tap answer, and the production regression (a phone's departure from
an earlier day made every new session look left at once: a "Leaving for the day?" and a correction at the check-in
time). Synthetic people only.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_hr_suite import _staff

IST = timezone(timedelta(hours=5, minutes=30))
DAY = datetime(2026, 10, 21, tzinfo=IST)          # a Wednesday
RULES = {"threshold": 60, "dwellMinutes": 3, "leaveMinutes": 15, "breakMaxMinutes": 90, "graceMinutes": 60,
         "autoCheckOut": True, "ask": True, "autoCheckIn": True}


def at(hhmm: str, day: datetime = DAY) -> datetime:
    h, m = map(int, hhmm.split(":"))
    return day.replace(hour=h, minute=m)


def iso(t: datetime) -> str:
    return t.isoformat()


def score(conn, signals, t):
    return conn.execute("select pulse.presence_score(%s::jsonb,%s) s", (json.dumps(signals), t)).fetchone()["s"]


class Day:
    """Runs presence_decide minute by minute over a timeline of signals, as the minute tick does."""

    def __init__(self, conn, rules=None, session=None):
        self.conn, self.rules = conn, {**RULES, **(rules or {})}
        self.state: dict = {}
        self.session = {"open": False, "eligible": True, **(session or {})}
        self.actions: list[tuple[str, dict]] = []

    def run(self, start: str, end: str, signals_at, step=1):
        t, stop = at(start), at(end)
        while t <= stop:
            s = score(self.conn, signals_at(t), t)
            d = self.conn.execute("select pulse.presence_decide(%s,%s::jsonb,%s::jsonb,%s::jsonb,%s::jsonb) d",
                                  (t, json.dumps(s), json.dumps(self.state), json.dumps(self.session),
                                   json.dumps(self.rules))).fetchone()["d"]
            self.state = {**d["state"], "lastScore": s["score"]} if s["score"] else d["state"]
            if d["action"] != "none":
                self.actions.append((t.strftime("%H:%M"), d))
                self.apply(t, d)
            t += timedelta(minutes=step)
        return self

    def apply(self, t, d):
        if d["action"] == "auto_check_in":
            self.session = {"open": True, "checkedIn": d["at"], "mode": "office", "shiftEnd": iso(at("19:00")), "askWindow": True}
        elif d["action"] == "check_out":
            self.session = {"open": False, "eligible": False}
        elif d["action"] == "ask":
            self.state = {**self.state, "askedAt": iso(t)}

    def kinds(self):
        return [(when, d["action"]) for when, d in self.actions]


def laptop_at_desk(*gaps):
    """The laptop on the office access point every 90 seconds, in use, except during `gaps` (start, end) and after 23:59."""
    def signals(t):
        for start, end in gaps:
            if at(start) <= t < at(end):
                return []
        seen = t - timedelta(seconds=(t.minute * 60) % 90)
        return [{"source": "wifi", "strong": True, "at": iso(seen), "fresh": 5}, {"source": "laptop", "at": iso(seen)}]
    return signals


def test_score_weights_freshness_and_agreement(worker):
    t = at("10:00")
    strong = score(worker, [{"source": "wifi", "strong": True, "at": iso(t), "fresh": 5}], t + timedelta(minutes=4))
    assert strong["score"] == 70 and strong["signals"] == ["wifi"], "one strong signal is enough"
    faded = score(worker, [{"source": "wifi", "strong": True, "at": iso(t), "fresh": 5}], t + timedelta(minutes=7, seconds=30))
    assert faded["score"] == 35, "a signal fades over its freshness again, not at once"
    weak = score(worker, [{"source": "wifi", "strong": False, "at": iso(t)}], t)
    assert weak["score"] == 30, "a network name alone is weak"
    two = score(worker, [{"source": "wifi", "strong": False, "at": iso(t)}, {"source": "network", "at": iso(t)}], t)
    assert two["score"] == 70 and two["signals"] == ["network", "wifi"], "two agreeing signals"
    alone = score(worker, [{"source": "laptop", "at": iso(t)}, {"source": "phone", "at": iso(t)}], t)
    assert alone["score"] == 0 and alone["signals"] == [], "a laptop in use says nothing about where it is"
    away = score(worker, [{"source": "laptop", "at": iso(t)}, {"source": "elsewhere", "at": iso(t)}], t)
    assert away["elsewhere"] is True and away["activityAt"] is not None
    future = score(worker, [{"source": "wifi", "strong": True, "at": iso(t + timedelta(minutes=30))}], t)
    assert future["score"] == 0, "a device clock in the future is ignored"


def test_an_office_day_with_lunch_checks_in_takes_a_break_and_checks_out_by_itself(worker):
    # In at 09:52; lunch outside 13:10–13:55; one missed report at 16:00; leaves at 18:40.
    day = Day(worker).run("09:45", "19:30", laptop_at_desk(("00:00", "09:52"), ("13:10", "13:55"), ("16:00", "16:03"), ("18:40", "23:59")))
    kinds = day.kinds()
    assert kinds[0] == ("09:55", "auto_check_in"), kinds
    assert day.actions[0][1]["at"].startswith("2026-10-21T04:22"), "checked in at the arrival (09:52), not after the dwell"
    assert kinds[1] == ("13:55", "break"), kinds
    brk = day.actions[1][1]
    assert brk["from"].startswith("2026-10-21T07:39") and brk["to"].startswith("2026-10-21T08:25"), brk
    assert kinds[2][1] == "check_out" and kinds[2][0] == "18:54", "noticed 15 minutes after the last confident moment"
    out = day.actions[2][1]
    assert out["reason"] == "left" and out["confidence"] >= 60, out
    assert out["at"].startswith("2026-10-21T13:09"), "out at the last confident moment (18:39), not when it was noticed"
    assert len(kinds) == 3, "nothing else: no question, no reminder, the missed report changed nothing"


def test_a_long_absence_in_the_middle_of_the_day_asks_once_and_becomes_a_break_when_back(worker):
    day = Day(worker).run("09:45", "16:00", laptop_at_desk(("00:00", "09:52"), ("11:00", "14:30")))
    kinds = day.kinds()
    assert [k for _, k in kinds] == ["auto_check_in", "ask", "break"], kinds
    assert kinds[1][0] == "12:30" and day.actions[1][1]["kind"] == "left_early"
    assert day.actions[2][1]["long"] is True


def test_the_laptop_busy_elsewhere_after_leaving_is_the_one_conflict(worker):
    def signals(t):
        if t < at("18:40"):
            return laptop_at_desk(("00:00", "09:52"))(t)
        if at("18:45") <= t < at("21:00"):   # the laptop opened again in a café down the road
            return [{"source": "laptop", "at": iso(t)}, {"source": "elsewhere", "at": iso(t)}]
        return []
    day = Day(worker).run("09:45", "21:30", signals)
    kinds = day.kinds()
    assert kinds[0][1] == "auto_check_in"
    assert kinds[1] == ("18:54", "ask") and day.actions[1][1]["kind"] == "left", kinds
    # Never answered: out at the moment they left, for HR to see (lower confidence).
    assert kinds[2][1] == "check_out" and day.actions[2][1]["reason"] == "left_unanswered", kinds
    assert day.actions[2][1]["at"].startswith("2026-10-21T13:09")
    assert len([k for _, k in kinds if k == "ask"]) == 1, "asked once"


def test_still_working_is_believed_until_the_activity_stops(worker):
    def signals(t):
        if t < at("18:40"):
            return laptop_at_desk(("00:00", "09:52"))(t)
        if at("18:45") <= t < at("21:00"):
            return [{"source": "laptop", "at": iso(t)}, {"source": "elsewhere", "at": iso(t)}]
        return []
    day = Day(worker).run("09:45", "19:06", signals)
    assert day.kinds()[-1] == ("18:54", "ask")
    day.state = {**day.state, "answer": "working"}
    day.run("19:07", "22:00", signals)
    out = [d for _, d in day.actions if d["action"] == "check_out"]
    assert len(out) == 1 and out[0]["reason"] == "last_activity" and out[0]["at"].startswith("2026-10-21T15:29"), out
    assert len([1 for _, d in day.actions if d["action"] == "ask"]) == 1


def test_no_signal_at_all_checks_out_at_the_shift_end_after_the_grace(worker):
    day = Day(worker, session={"open": True, "checkedIn": iso(at("10:05")), "mode": "office", "shiftEnd": iso(at("19:00")), "askWindow": True})
    day.run("10:05", "20:30", lambda t: [])
    assert day.kinds() == [("20:00", "check_out")]
    out = day.actions[0][1]
    assert out["reason"] == "shift_end" and out["confidence"] < 60 and out["at"].startswith("2026-10-21T13:30"), out


def test_automatic_check_in_off_asks_once_and_never_checks_in(worker):
    day = Day(worker, rules={"autoCheckIn": False}).run("09:45", "10:30", laptop_at_desk(("00:00", "09:52")))
    assert {k for _, k in day.kinds()} == {"arrival"}, "the arrival question (the tick sends it once a day)"
    assert day.session["open"] is False


def test_a_dwelled_arrival_on_two_agreeing_signals_checks_in_without_asking_first(worker):
    # Android reports the geofence only after its own loitering delay (dwelled: holding since 09:50), here with the
    # office public IP: sure at once (50 + 40). Pulse checks in by itself after the dwell and never asks "Check in?"
    # three minutes before doing it (0942; found end to end on pulse-dev).
    def signals(t):
        return [] if t < at("09:53") else [{"source": "geofence", "at": iso(at("09:53"))}, {"source": "network", "at": iso(t)}]
    day = Day(worker).run("09:45", "09:52", signals)
    day.state = {**day.state, "holdingSince": iso(at("09:50"))}
    day.run("09:53", "10:10", signals)
    assert day.kinds() == [("09:56", "auto_check_in")], day.kinds()
    off = Day(worker, rules={"autoCheckIn": False}).run("09:45", "09:52", signals)
    off.state = {**off.state, "holdingSince": iso(at("09:50"))}
    assert off.run("09:53", "09:53", signals).kinds() == [("09:53", "arrival")], "without automatic check-in it still asks"


def test_automatic_check_out_off_asks_instead(worker):
    day = Day(worker, rules={"autoCheckOut": False}).run("09:45", "20:30", laptop_at_desk(("00:00", "09:52"), ("18:40", "23:59")))
    kinds = [k for _, k in day.kinds()]
    assert kinds == ["auto_check_in", "ask"], kinds


# ------------------------------------------------------------------------------------------- the engine itself

def _setup(worker, owner, api):
    w = build_world(worker, owner, api)
    _staff(worker, w)
    with owner.transaction():
        _as_owner(owner, w)
        owner.execute("select pulse.hr_defaults()")
        owner.execute("update pulse.hr_policy set attendance_enabled=true,shift_start='10:00',shift_end='19:00',grace_minutes=15,"
                      "work_days=array[1,2,3,4,5,6,7],presence_auto_checkin=true")
        office = owner.execute("insert into pulse.presence_office(org_id,name,lat,lng,radius_m,wifi,public_ip_ranges) values"
                                "(%s,'Synthetic Studio',18.52,73.85,150,%s,'{203.0.113.0/24}') returning id",
                                (w.org, json.dumps([{"ssid": "Synth-Office", "bssids": ["a4:2b:b0:11:22:33"]}]))).fetchone()["id"]
        device = owner.execute("insert into pulse.native_device(org_id,person_id,name,platform,purposes) values(%s,%s,'Synthetic laptop','windows','{attendance}') returning id",
                                (w.org, w.editor)).fetchone()["id"]
    return w, office, device


def _as_owner(owner, w):
    role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
    owner.execute(f"set local role {role}")
    set_tenant(owner, w.org)


def _report(owner, w, device, office, t, *, wifi=True, active=True, elsewhere=False):
    with owner.transaction():
        _as_owner(owner, w)
        owner.execute("""insert into pulse.companion_presence(org_id,device_id,person_id,office_id,consent,auto_consent,wifi_strength,wifi_at,active_at,elsewhere_at)
          values(%s,%s,%s,%s,true,true,%s,%s,%s,%s) on conflict(device_id) do update set office_id=excluded.office_id,wifi_strength=excluded.wifi_strength,
          wifi_at=excluded.wifi_at,active_at=coalesce(excluded.active_at,companion_presence.active_at),elsewhere_at=excluded.elsewhere_at,updated_at=%s""",
                      (w.org, device, w.editor, office, 40 if wifi else 0, t if wifi else None, t if active else None, t if elsewhere else None, t))


def _tick(worker, w, t):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select pulse.attendance_presence_tick(%s) n", (t,)).fetchone()["n"]


def _rows(owner, w, sql, args=()):
    with owner.transaction():
        _as_owner(owner, w)
        return owner.execute(sql, args).fetchall()


def test_the_engine_checks_in_records_lunch_and_checks_out_with_how_it_decided(worker, owner, api):
    w, office, device = _setup(worker, owner, api)
    t = datetime.now(timezone.utc).astimezone(IST).replace(hour=9, minute=50, second=0, microsecond=0)
    if t > datetime.now(timezone.utc):
        t -= timedelta(days=1)
    timeline = []
    for minute in range(0, 9 * 60 + 30, 1):
        now = t + timedelta(minutes=minute)
        hhmm = now.strftime("%H:%M")
        if "13:10" <= hhmm < "13:55" or hhmm >= "18:40":
            if hhmm == "18:40" or hhmm == "13:10":
                _report(owner, w, device, office, now, wifi=False, active=False)
        elif minute % 2 == 0:
            _report(owner, w, device, office, now)
        timeline.append(_tick(worker, w, now))
    entry = _rows(owner, w, "select checked_in_at,checked_out_at,client,out_client from pulse.attendance_entry where person_id=%s", (w.editor,))
    assert len(entry) == 1, entry
    e = entry[0]
    assert e["client"]["via"] == "auto" and e["client"]["signals"] == ["laptop", "wifi"], e["client"]
    assert e["checked_in_at"].astimezone(IST).strftime("%H:%M") == "09:50"
    assert e["out_client"]["via"] == "auto" and e["out_client"]["reason"] == "left", e["out_client"]
    assert e["checked_out_at"].astimezone(IST).strftime("%H:%M") in ("18:38", "18:39"), e["checked_out_at"]
    breaks = _rows(owner, w, "select started_at,ended_at,client from pulse.attendance_break where person_id=%s", (w.editor,))
    assert len(breaks) == 1 and breaks[0]["client"]["via"] == "auto", breaks
    assert breaks[0]["started_at"].astimezone(IST).strftime("%H:%M") in ("13:08", "13:09")
    kinds = [r["event_type"] for r in _rows(owner, w, "select event_type from pulse.notification where person_id=%s order by created_at", (w.editor,))]
    assert kinds == ["attendance.auto", "attendance.auto"], kinds
    assert not _rows(owner, w, "select 1 from pulse.attendance_regularisation where person_id=%s", (w.editor,)), "no correction requests"
    assert not _rows(owner, w, "select 1 from pulse.attendance_exception where person_id=%s", (w.editor,)), "a confident day needs no HR"
    quiet = _rows(owner, w, "select quiet,priority from pulse.notification where person_id=%s", (w.editor,))
    assert all(r["quiet"] and r["priority"] == "fyi" for r in quiet), "the confirmations wait in the bell, no ping"


def test_a_departure_from_an_earlier_day_never_makes_a_new_session_look_left(worker, owner, api):
    """Production, 10–21 Oct: every check-in got "Leaving for the day?" and a correction at the check-in time."""
    w, office, device = _setup(worker, owner, api)
    old = datetime.now(timezone.utc) - timedelta(days=12)
    with owner.transaction():
        _as_owner(owner, w)
        owner.execute("""insert into pulse.companion_presence(org_id,device_id,person_id,office_id,consent,auto_consent,wifi_strength,wifi_at,ip_matched,ip_at,last_present_at,left_at)
          values(%s,%s,%s,%s,true,false,40,%s,true,%s,%s,%s)""", (w.org, device, w.editor, office, old, old, old, old + timedelta(hours=4)))
        owner.execute("""insert into pulse.attendance_entry(org_id,person_id,work_date,mode,checked_in_at,client)
          values(%s,%s,(now() at time zone 'Asia/Kolkata')::date,'office',now()-interval '30 minutes','{"via":"web","trigger":"manual"}')""", (w.org, w.editor))
    for minutes in (0, 16, 30):
        _tick(worker, w, datetime.now(timezone.utc) + timedelta(minutes=minutes))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("select pulse.companion_presence_tick(null)")
    assert not _rows(owner, w, "select 1 from pulse.notification where person_id=%s and event_type in ('attendance.departure','attendance.ask','attendance.checkout')", (w.editor,))
    assert not _rows(owner, w, "select 1 from pulse.attendance_regularisation where person_id=%s", (w.editor,))
    assert _rows(owner, w, "select checked_out_at from pulse.attendance_entry where person_id=%s", (w.editor,))[0]["checked_out_at"] is None


def test_the_question_is_answered_in_one_tap_and_never_asked_again(worker, owner, api):
    w, office, device = _setup(worker, owner, api)
    now = datetime.now(timezone.utc)
    with owner.transaction():
        _as_owner(owner, w)
        entry = owner.execute("""insert into pulse.attendance_entry(org_id,person_id,work_date,mode,checked_in_at,client)
          values(%s,%s,(now() at time zone 'Asia/Kolkata')::date,'office',now()-interval '3 hours','{"via":"web"}') returning id""", (w.org, w.editor)).fetchone()["id"]
        owner.execute("""insert into pulse.attendance_presence_state(org_id,person_id,entry_id,work_date,last_confident_at,absent_since,asked_at,ask_kind)
          values(%s,%s,%s,(now() at time zone 'Asia/Kolkata')::date,now()-interval '40 minutes',now()-interval '40 minutes',now()-interval '5 minutes','left')""", (w.org, w.editor, entry))
    with api.transaction():
        set_tenant(api, w.org)
        api.execute("select set_config('pulse.viewer_id',%s,true)", (str(w.editor),))
        r = api.execute("select pulse.attendance_answer(%s,'left') r", (entry,)).fetchone()["r"]
    assert r["ok"] and r["answer"] == "left"
    e = _rows(owner, w, "select checked_out_at,out_client from pulse.attendance_entry where id=%s", (entry,))[0]
    assert e["out_client"]["via"] == "answer" and abs((e["checked_out_at"] - (now - timedelta(minutes=40))).total_seconds()) < 120
    for minutes in (1, 30, 120):
        _tick(worker, w, now + timedelta(minutes=minutes))
    assert not _rows(owner, w, "select 1 from pulse.notification where person_id=%s and event_type='attendance.ask'", (w.editor,)), "never asked again"
    # Someone else cannot answer for them.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="not yours"):
        with api.transaction():
            set_tenant(api, w.org)
            api.execute("select set_config('pulse.viewer_id',%s,true)", (str(w.editor2),))
            api.execute("select pulse.attendance_answer(%s,'working')", (entry,))


# ---------------------------------------------------------------------------------------- HR (0862)

def _hr_viewer(api, w):
    set_tenant(api, w.org)
    api.execute("select set_config('pulse.viewer_id',%s,true)", (str(w.lead),))


def test_hr_confirms_or_fixes_an_exception_in_one_tap_and_withdraws_pulses_mistakes(worker, owner, api):
    w, office, device = _setup(worker, owner, api)
    with owner.transaction():
        _as_owner(owner, w)
        entry = owner.execute("""insert into pulse.attendance_entry(org_id,person_id,work_date,mode,checked_in_at,client)
          values(%s,%s,(now() at time zone 'Asia/Kolkata')::date-1,'office',((now() at time zone 'Asia/Kolkata')::date-1+time '10:05') at time zone 'Asia/Kolkata','{"via":"web"}') returning id""",
                              (w.org, w.editor)).fetchone()["id"]
        # The old device-departure bug's signature: a proposal at the check-in time, waiting on approvers (its approval
        # request is made by the correction's own trigger).
        stale = owner.execute("""insert into pulse.attendance_regularisation(org_id,person_id,work_date,kind,out_time,reason)
          values(%s,%s,(now() at time zone 'Asia/Kolkata')::date-1,'missed_punch','10:05','Auto check-out at last presence — needs confirmation. Confirm the proposed time or ask HR to correct it.') returning id""",
                              (w.org, w.editor2)).fetchone()["id"]
    # The engine closes yesterday's session at the shift's end and opens an exception.
    _tick(worker, w, datetime.now(timezone.utc))
    x = _rows(owner, w, "select id,kind,proposed_out from pulse.attendance_exception where entry_id=%s", (entry,))
    assert len(x) == 1 and x[0]["kind"] == "missing_checkout"
    # Someone who is not HR cannot settle it; HR fixes it to 18:30.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with api.transaction():
            set_tenant(api, w.org)
            api.execute("select set_config('pulse.viewer_id',%s,true)", (str(w.editor2),))
            api.execute("select pulse.attendance_exception_resolve(%s,'confirm')", (x[0]["id"],))
    with api.transaction():
        _hr_viewer(api, w)
        out = api.execute("""select pulse.attendance_exception_resolve(%s,'fix',((now() at time zone 'Asia/Kolkata')::date-1+time '18:30') at time zone 'Asia/Kolkata') r""", (x[0]["id"],)).fetchone()["r"]
        assert out["ok"]
        stale_rows = api.execute("select * from pulse.attendance_stale_proposals()").fetchall()
        assert [r["id"] for r in stale_rows] == [stale] and str(stale_rows[0]["out_time"]) == "10:05:00"
        assert api.execute("select pulse.attendance_stale_withdraw() n").fetchone()["n"] == 1
    e = _rows(owner, w, "select to_char(checked_out_at at time zone 'Asia/Kolkata','HH24:MI') t,out_client from pulse.attendance_entry where id=%s", (entry,))[0]
    assert e["t"] == "18:30" and e["out_client"]["hr"] == "fix" and e["out_client"]["confirmedBy"] == str(w.lead)
    assert _rows(owner, w, "select resolution,resolved_by from pulse.attendance_exception where id=%s", (x[0]["id"],)) == [{"resolution": "fixed", "resolved_by": w.lead}]
    assert _rows(owner, w, "select field from pulse.record_change where entity_id=%s", (entry,)) == [{"field": "checked_out_at"}], "the change is on the record"
    assert _rows(owner, w, "select status from pulse.attendance_regularisation where id=%s", (stale,)) == [{"status": "cancelled"}]
    assert _rows(owner, w, "select status from pulse.hr_flow where source_id=%s", (stale,)) == [{"status": "cancelled"}]


def test_hr_gets_one_digest_a_day_not_a_stream(worker, owner, api):
    w, office, device = _setup(worker, owner, api)
    with owner.transaction():
        _as_owner(owner, w)
        owner.execute("""insert into pulse.attendance_entry(org_id,person_id,work_date,mode,checked_in_at,client)
          values(%s,%s,(now() at time zone 'Asia/Kolkata')::date-1,'office',((now() at time zone 'Asia/Kolkata')::date-1+time '10:05') at time zone 'Asia/Kolkata','{"via":"web"}')""", (w.org, w.editor))
    morning = datetime.now(timezone.utc).astimezone(IST).replace(hour=10, minute=30, second=0, microsecond=0)
    _tick(worker, w, morning - timedelta(hours=1))       # closes yesterday's session (exception)
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select pulse.attendance_digest_tick(%s) n", (morning - timedelta(hours=1),)).fetchone()["n"] == 0, "not before 10:00"
        sent = worker.execute("select pulse.attendance_digest_tick(%s) n", (morning,)).fetchone()["n"]
        again = worker.execute("select pulse.attendance_digest_tick(%s) n", (morning + timedelta(minutes=5),)).fetchone()["n"]
    assert sent >= 1 and again == 0, "once a day"
    digest = _rows(owner, w, "select title,href,priority from pulse.notification where person_id=%s and event_type='attendance.digest'", (w.lead,))
    assert len(digest) == 1 and "1 to check" in digest[0]["title"] and digest[0]["href"] == "/hr?tab=attendance&view=check" and digest[0]["priority"] == "needs_you"
