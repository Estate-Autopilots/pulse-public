"""LISTEN-FAST (migration 2092): live words. The company's switch, the install-wide monthly budget (read one company at
a time under row security), the stream's meter, finished sentences as transcript lines, Whisper pieces after live words
starting where the words ended, and the AI helper reading new words sooner. Synthetic data only."""
import json

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_agent_coworkers import make_agent, owner_sql
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def worker_one(worker, w, sql, args=()):
    with worker.transaction():
        set_tenant(worker, w.org)
        cur = worker.execute(sql, args)
        return cur.fetchone() if cur.description else None


def settings(api, w, who, change):
    return one(api, w, who, "select pulse.agent_channels_settings_set(%s) s", (Jsonb(change),))["s"]


def test_live_words_switch_budget_meter_and_lines(api, owner, worker, team):  # noqa: F811
    w = team
    s = settings(api, w, w.manager, {"listenOn": True})
    assert s["listen"]["live"] is True, "live words on by default (when the server has a key)"
    sid = one(api, w, w.manager, "select pulse.listen_start(null,'Synthetic live call','meeting',true) r")["r"]["id"]

    # Only the person listening starts a stream; the company can keep the sound on its own server.
    with pytest.raises(psycopg.errors.NoDataFound):
        one(api, w, w.editor, "select pulse.listen_live_begin(%s,2400) r", (sid,))
    settings(api, w, w.manager, {"listenLive": False})
    assert one(api, w, w.manager, "select pulse.listen_live_begin(%s,2400) r", (sid,))["r"] == {"ok": False, "why": "off"}
    assert settings(api, w, w.manager, {"listenLive": True})["listen"]["live"] is True

    # The budget: a stream needs 10 minutes left under the cap.
    assert one(api, w, w.manager, "select pulse.listen_live_begin(%s,5) r", (sid,))["r"]["why"] == "budget"
    r = one(api, w, w.manager, "select pulse.listen_live_begin(%s,2400) r", (sid,))["r"]
    assert r["ok"] is True and r["capMinutes"] == 2400
    use = r["useId"]
    # Another company's streams count too (the owner pays one bill): 30 minutes elsewhere this month.
    other = owner_sql(owner, w, "select id from pulse.org where id <> %s order by id limit 1", (w.org,))
    if other:
        o = other[0]["id"]
        with owner.transaction():
            set_tenant(owner, o)
            p = owner.execute("select id from pulse.person where org_id=%s limit 1", (o,)).fetchone()
            if p:
                owner.execute("""insert into pulse_priv.listen_live_use (org_id, session_id, person_id, started_at, last_at)
                                 values (%s, gen_random_uuid(), %s, now() - interval '11 minutes', now() - interval '1 minute')""", (o, p["id"]))
                used = one(api, w, w.manager, "select pulse.listen_live_beat(%s,2400) r", (use,))["r"]["usedMinutes"]
                assert float(used) >= 10, "minutes streamed in another company count against the same cap"
    # The meter stops at 12 minutes per stream, whatever the browser says.
    owner_sql(owner, w, "update pulse_priv.listen_live_use set started_at = now() - interval '20 minutes', last_at = now() - interval '9 minutes' where id=%s", (use,))
    b = one(api, w, w.manager, "select pulse.listen_live_beat(%s,2400) r", (use,))["r"]
    assert b["stop"] is True, "past 12 minutes the stream must be replaced"
    assert owner_sql(owner, w, "select extract(epoch from last_at - started_at)::int s from pulse_priv.listen_live_use where id=%s", (use,))[0]["s"] == 720
    with pytest.raises(psycopg.errors.NoDataFound):  # only the listener beats their stream
        one(api, w, w.editor, "select pulse.listen_live_beat(%s,2400) r", (use,))

    # Finished sentences are transcript lines (in order, once); only the listener adds them.
    one(api, w, w.manager, "select pulse.listen_words_add(%s,0,800,2600,%s)", (sid, "Synthetic: we agreed the budget is two lakh."))
    one(api, w, w.manager, "select pulse.listen_words_add(%s,1,3000,5200,%s)", (sid, "राहुल कल सुबह फोन करेगा।"))
    one(api, w, w.manager, "select pulse.listen_words_add(%s,1,3000,5200,%s)", (sid, "a repeat is ignored"))
    assert one(api, w, w.manager, "select pulse.listen_words_add(%s,2,0,0,'  ') r", (sid,))["r"] == {"ok": True, "empty": True}
    with pytest.raises(psycopg.errors.NoDataFound):
        one(api, w, w.editor, "select pulse.listen_words_add(%s,3,0,10,'x')", (sid,))
    v = one(api, w, w.manager, "select pulse.listen_view(%s,-1) v", (sid,))["v"]
    assert [(g["seq"], g["startMs"], g["text"][:10]) for g in v["segments"]] == [(0, 800, "Synthetic:"), (1, 3000, "राहुल कल स")]

    # Live words failed: Whisper pieces go on from there, timed after the last word (not from zero).
    one(api, w, w.manager, "select pulse.listen_chunk_add(%s,2,'audio/webm',4000,%s)", (sid, b"RIFF-synthetic"))
    job = worker_one(worker, w, "select pulse.listen_chunk_claim() j")["j"]
    assert job["seq"] == 2
    worker_one(worker, w, "select pulse.listen_chunk_done(%s,2,%s::jsonb,null)", (sid, json.dumps([{"s": 0.5, "e": 3.5, "t": "Synthetic after the switch."}])))
    seg = owner_sql(owner, w, "select start_ms, end_ms from pulse.listen_segment where session_id=%s and seq=2", (sid,))[0]
    assert seg == {"start_ms": 5700, "end_ms": 8700}

    # The helper reads new words once 20 seconds of speech are new (was 30).
    assert worker_one(worker, w, "select pulse.listen_forward() n")["n"] == 0  # no helper on this session, and under 20 s
    src = owner_sql(owner, w, "select pg_get_functiondef('pulse.listen_forward()'::regprocedure) d")[0]["d"]
    assert "span < 20000" in src and "interval '30 seconds'" in src and "listen_quote_intent(body)" in src

    # A sentence may land just after Stop; after two minutes the session takes no more.
    one(api, w, w.manager, "select pulse.listen_stop(%s)", (sid,))
    one(api, w, w.manager, "select pulse.listen_words_add(%s,3,9000,9500,'Synthetic last words.')", (sid,))
    owner_sql(owner, w, "update pulse.listen_session set stopped_at = now() - interval '3 minutes' where id=%s", (sid,))
    with pytest.raises(psycopg.errors.ProgramLimitExceeded):
        one(api, w, w.manager, "select pulse.listen_words_add(%s,4,9600,9900,'too late')", (sid,))
    with pytest.raises(psycopg.errors.ProgramLimitExceeded):
        one(api, w, w.manager, "select pulse.listen_live_begin(%s,2400) r", (sid,))

    # Deleting the transcript never gives budget back: the meter's rows stay (times only, no words).
    one(api, w, w.manager, "select pulse.listen_delete(%s)", (sid,))
    assert owner_sql(owner, w, "select count(*) n from pulse_priv.listen_live_use where session_id=%s", (sid,))[0]["n"] == 1


def test_live_words_meter_is_forced_row_security(owner, api, team):  # noqa: F811
    w = team
    r = owner.execute("""select relrowsecurity r, relforcerowsecurity f, (select count(*) from pg_policy where polrelid=c.oid) p
                           from pg_class c where oid='pulse_priv.listen_live_use'::regclass""").fetchone()
    assert (r["r"], r["f"], r["p"]) == (True, True, 1)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with api.transaction():
            set_tenant(api, w.org)
            api.execute("select count(*) from pulse_priv.listen_live_use")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with api.transaction():
            set_tenant(api, w.org)
            api.execute("select pulse.listen_live_minutes_month()")
