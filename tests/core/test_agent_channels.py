"""AGENT-CHANNELS (1685): an AI employee on Telegram (/agent switch), on WhatsApp (link code, inbound into its chat,
replies through the outbox inside the 24-hour window) and listening (opt-in, consent, transcript per company with
row security, the AI employee gets the transcript in its chat, the hook's events, retention). Synthetic data only;
nothing is sent anywhere."""
import base64
import hashlib
import json
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_agent_coworkers import make_agent, owner_sql
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

WA = "919000000123"  # the synthetic numbers the WA tests already use
CHAT = "700000001"


def worker_one(worker, w, sql, args=()):
    with worker.transaction():
        set_tenant(worker, w.org)
        cur = worker.execute(sql, args)
        return cur.fetchone() if cur.description else None


def settings(api, w, who, change):
    return one(api, w, who, "select pulse.agent_channels_settings_set(%s) s", (Jsonb(change),))["s"]


def wa_hash(code):
    return hashlib.sha256(f"WA{code}".upper().encode()).hexdigest()


def test_settings_are_admins_and_off_by_default(api, owner, worker, team):  # noqa: F811
    w = team
    s = one(api, w, w.editor, "select pulse.agent_channels_settings() s")["s"]
    assert s["listen"] == {"on": False, "retentionDays": 30} and s["whatsapp"]["on"] is False and s["telegram"]["bot"] == "shared"
    assert s["canEdit"] is False and s["telegram"]["running"] is False
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        settings(api, w, w.editor, {"listenOn": True})
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        settings(api, w, w.manager, {"listenRetentionDays": 0})
    s = settings(api, w, w.manager, {"listenOn": True, "listenRetentionDays": 7, "telegramBot": "own", "telegramOwnUsername": "@SyntheticCoBot"})
    assert s["listen"] == {"on": True, "retentionDays": 7} and s["telegram"]["bot"] == "own" and s["telegram"]["ownUsername"] == "SyntheticCoBot"
    # The bot's worker says it runs; until then Vitals shows "waiting for the token".
    worker_one(worker, w, "select pulse.agent_channel_heartbeat('telegram','SyntheticCoBot')")
    s = one(api, w, w.editor, "select pulse.agent_channels_settings() s")["s"]
    assert s["telegram"]["running"] is True and s["telegram"]["runningBot"] == "SyntheticCoBot"
    assert worker_one(worker, w, "select pulse.agent_channel_telegram_mode() m")["m"] == "own"


def test_telegram_agent_switch_as_the_linked_person(api, owner, worker, team):  # noqa: F811
    w = team
    a1, _ = make_agent(api, w, "bharata-synthetic")
    make_agent(api, w, "scribe-synthetic")
    assert worker_one(worker, w, "select pulse.channel_agent_switch('telegram',%s,'bharata') r", (CHAT,))["r"] == {"error": "not_linked"}
    owner_sql(owner, w, "insert into pulse_priv.telegram_person (org_id, person_id, chat_id, verified_by, via) values (%s,%s,%s,%s,'self')",
              (w.org, w.manager, CHAT, w.manager))
    choices = worker_one(worker, w, "select pulse.channel_agent_choices('telegram',%s) r", (CHAT,))["r"]
    names = [a["name"] for a in choices["agents"]]
    assert "Bharata Synthetic" in names and "Scribe Synthetic" in names and choices["current"] is None
    assert worker_one(worker, w, "select pulse.channel_agent_switch('telegram',%s,'nobody-here') r", (CHAT,))["r"] == {"error": "unknown"}
    assert worker_one(worker, w, "select pulse.channel_agent_switch('telegram',%s,'bharata') r", (CHAT,))["r"] == {"agent": "Bharata Synthetic"}
    link = owner_sql(owner, w, "select person_id, agent_id, channel_id from pulse_priv.telegram_agent_link where chat_id=%s", (CHAT,))
    assert len(link) == 1 and link[0]["person_id"] == w.manager and link[0]["agent_id"] == a1
    # What the person writes is mirrored into their Pulse chat with it (1598's relay), as them.
    worker_one(worker, w, "select pulse.telegram_agent_inbound(%s,'Synthetic: draft the quote please')", (CHAT,))
    msg = owner_sql(owner, w, "select author_id from pulse.chat_message where channel_id=%s and body like 'Synthetic: draft%%'", (link[0]["channel_id"],))
    assert msg and msg[0]["author_id"] == w.manager
    # Switching again moves the chat to the other AI employee (one at a time per chat).
    assert worker_one(worker, w, "select pulse.channel_agent_switch('telegram',%s,'Scribe') r", (CHAT,))["r"]["agent"] == "Scribe Synthetic"
    assert len(owner_sql(owner, w, "select 1 from pulse_priv.telegram_agent_link where chat_id=%s", (CHAT,))) == 1


def test_whatsapp_link_inbound_reply_window_and_switch(api, owner, worker, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "bharata-wa-synthetic")
    with pytest.raises(psycopg.errors.ProgramLimitExceeded):  # WhatsApp not on for the company yet
        one(api, w, w.manager, "select pulse.whatsapp_link_begin(%s,%s)", (wa_hash("ABCDEFGH23"), agent))
    settings(api, w, w.manager, {"whatsappOn": True})
    one(api, w, w.manager, "select pulse.whatsapp_link_begin(%s,%s)", (wa_hash("ABCDEFGH23"), agent))
    # An unknown number gets nothing back.
    assert one(api, w, w.manager, "select pulse.whatsapp_inbound('919000000456','hello',null) r")["r"] == {"kind": "unknown"}
    # The code links this number to the person's chat with the AI employee.
    r = one(api, w, w.manager, "select pulse.whatsapp_inbound(%s,'link ABCDEFGH23',%s) r", (WA, wa_hash("ABCDEFGH23")))["r"]
    assert r == {"kind": "link", "ok": True}
    assert one(api, w, w.manager, "select pulse.whatsapp_link_status() s")["s"]["agents"][0]["number"] == "…0123"
    # A spent code does not link again.
    assert one(api, w, w.manager, "select pulse.whatsapp_inbound('919000000456','link ABCDEFGH23',%s) r", (wa_hash("ABCDEFGH23"),))["r"]["ok"] is False
    one(api, w, w.manager, "select pulse.whatsapp_inbound(%s,'Synthetic: 40 signboards by Friday',null)", (WA,))
    ch = owner_sql(owner, w, "select channel_id from pulse_priv.whatsapp_agent_link where wa_id=%s", (WA,))[0]["channel_id"]
    assert owner_sql(owner, w, "select author_id from pulse.chat_message where channel_id=%s and body like 'Synthetic: 40%%'", (ch,))[0]["author_id"] == w.manager
    # The AI employee answers in Vitals; the reply goes to the outbox (with the link's "Linked" note before it).
    owner_sql(owner, w, "insert into pulse.chat_message (org_id, channel_id, author_id, body, client_id) values (%s,%s,%s,'Draft quote ready (synthetic)',%s)",
              (w.org, ch, agent, uuid.uuid4()))
    out = worker_one(worker, w, "select pulse.whatsapp_outbound_claim(20) r")["r"]
    bodies = [o["body"] for o in out]
    assert any(b.startswith("Linked.") for b in bodies) and "Bharata Wa Synthetic: Draft quote ready (synthetic)" in bodies
    assert all(o["to"] == WA or o["to"] == "919000000456" for o in out)
    for o in out:
        worker_one(worker, w, "select pulse.channel_outbox_done(%s,true)", (o["id"],))
    assert worker_one(worker, w, "select pulse.whatsapp_outbound_claim(20) r")["r"] == []
    # Outside the 24-hour window a reply stays in Vitals.
    owner_sql(owner, w, "update pulse_priv.whatsapp_agent_link set last_inbound_at = now() - interval '25 hours' where wa_id=%s", (WA,))
    owner_sql(owner, w, "insert into pulse.chat_message (org_id, channel_id, author_id, body, client_id) values (%s,%s,%s,'Late reply (synthetic)',%s)",
              (w.org, ch, agent, uuid.uuid4()))
    assert worker_one(worker, w, "select pulse.whatsapp_outbound_claim(20) r")["r"] == []
    # /agent lists and switches.
    one(api, w, w.manager, "select pulse.whatsapp_inbound(%s,'/agent',null)", (WA,))
    listed = worker_one(worker, w, "select pulse.whatsapp_outbound_claim(20) r")["r"]
    assert listed and listed[0]["body"].startswith("You are talking to Bharata Wa Synthetic.")
    one(api, w, w.manager, "select pulse.whatsapp_unlink(%s)", (agent,))
    assert one(api, w, w.manager, "select pulse.whatsapp_link_status() s")["s"]["agents"] == []


def test_listening_consent_transcript_agent_hook_and_retention(api, owner, worker, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "bharata-listen-synthetic")
    with pytest.raises(psycopg.errors.ProgramLimitExceeded):  # off until an admin opts the company in
        one(api, w, w.manager, "select pulse.listen_start(%s,'Synthetic call','quotation',true) r", (agent,))
    settings(api, w, w.manager, {"listenOn": True, "listenRetentionDays": 30})
    with pytest.raises(psycopg.errors.InvalidParameterValue):  # consent first
        one(api, w, w.manager, "select pulse.listen_start(%s,'Synthetic call','quotation',false) r", (agent,))
    sid = one(api, w, w.manager, "select pulse.listen_start(%s,'Synthetic call','quotation',true) r", (agent,))["r"]["id"]
    audio = b"RIFF-synthetic-audio"
    one(api, w, w.manager, "select pulse.listen_chunk_add(%s,0,'audio/webm',10000,%s)", (sid, audio))
    with pytest.raises(psycopg.errors.NoDataFound):  # only the person listening adds audio
        one(api, w, w.editor, "select pulse.listen_chunk_add(%s,1,'audio/webm',10000,%s)", (sid, audio))
    with pytest.raises(psycopg.errors.NoDataFound):  # and only they (or an admin) read the transcript
        one(api, w, w.editor, "select pulse.listen_view(%s,-1)", (sid,))
    job = worker_one(worker, w, "select pulse.listen_chunk_claim() j")["j"]
    assert job["sessionId"] == str(sid) and base64.b64decode(job["audio"]) == audio
    segs = [{"s": 0.0, "e": 9.5, "t": "Synthetic client: we need 40 signboards by Friday."}]
    worker_one(worker, w, "select pulse.listen_chunk_done(%s,0,%s::jsonb,null)", (sid, json.dumps(segs)))
    assert owner_sql(owner, w, "select bytes is null gone, state from pulse_priv.listen_chunk where session_id=%s", (sid,))[0] == {"gone": True, "state": "done"}
    v = one(api, w, w.manager, "select pulse.listen_view(%s,-1) v", (sid,))["v"]
    assert v["live"] is True and v["segments"][0]["text"].startswith("Synthetic client") and v["agent"] == "Bharata Listen Synthetic"
    assert one(api, w, w.manager, "select pulse.listen_view(%s,0) v", (sid,))["v"]["segments"] == []
    # Under 30 seconds of new speech nothing is forwarded while live; on stop the rest goes to the AI employee.
    assert worker_one(worker, w, "select pulse.listen_forward() n")["n"] == 0
    one(api, w, w.manager, "select pulse.listen_stop(%s)", (sid,))
    assert worker_one(worker, w, "select pulse.listen_forward() n")["n"] == 1
    ch = owner_sql(owner, w, "select channel_id from pulse.listen_session where id=%s", (sid,))[0]["channel_id"]
    posted = owner_sql(owner, w, "select author_id, body from pulse.chat_message where channel_id=%s and body like '%%Live transcript%%'", (ch,))
    assert posted[0]["author_id"] == w.manager and "40 signboards" in posted[0]["body"] and "quotation" in posted[0]["body"]
    assert worker_one(worker, w, "select pulse.listen_forward() n")["n"] == 0, "once"
    # The hook: started, window, stopped (with the purpose, for the quotation flow).
    events = worker_one(worker, w, "select pulse.listen_events(0,100) e")["e"]
    mine = [e for e in events if e["sessionId"] == str(sid)]
    assert [e["type"] for e in mine] == ["listen.started", "listen.window", "listen.stopped"]
    assert mine[-1]["data"]["purpose"] == "quotation" and mine[-1]["data"]["segments"] == 1
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.listen_events(0,100)")
    # Retention: past its days the session, its transcript and the chat copy go.
    owner_sql(owner, w, "update pulse.listen_session set purge_after = now() - interval '1 minute' where id=%s", (sid,))
    assert worker_one(worker, w, "select pulse.listen_purge() n")["n"] == 1
    assert owner_sql(owner, w, "select 1 from pulse.listen_segment where session_id=%s", (sid,)) == []
    assert owner_sql(owner, w, "select removed_at is not null gone from pulse.chat_message where channel_id=%s and body like '%%Live transcript%%'", (ch,))[0]["gone"]


def test_listening_rows_stay_in_their_company(api, owner, worker, team):  # noqa: F811
    w = team
    settings(api, w, w.manager, {"listenOn": True})
    sid = one(api, w, w.manager, "select pulse.listen_start(null,'Synthetic solo','general',true) r")["r"]["id"]
    other = uuid.uuid4()  # another company (row security compares the company id only)
    # The API's login has no table rights at all (functions only); even the owner's login sees another company's rows
    # only inside that company (forced row security).
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with api.transaction():
            set_tenant(api, w.org)
            api.execute("select count(*) from pulse.listen_session")
    with owner.transaction():
        set_tenant(owner, other)
        assert owner.execute("select count(*) n from pulse.listen_session where id=%s", (sid,)).fetchone()["n"] == 0
        assert owner.execute("select count(*) n from pulse.agent_channel_settings").fetchone()["n"] == 0
    assert owner_sql(owner, w, "select count(*) n from pulse.listen_session where id=%s", (sid,))[0]["n"] == 1
