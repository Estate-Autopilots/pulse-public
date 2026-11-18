"""KAZUK-REST slice 4 (1712): in-person meetings recorded in Pulse. A recording starts only with the consent notice
confirmed (kept on the row); the audio and transcript are for the person who recorded it, the people named in it and
leadership; typed notes or the server's transcript give draft action items that become tasks only when a person confirms
them; and nothing crosses to another company. Synthetic tenants, people and words only."""
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import (  # noqa: F401  (erp is a fixture)
    as_,
    erp,
    one,
    person,
)

CONSENT = "Everyone present was told this meeting is recorded in Pulse, transcribed on the company's own server and used to draft tasks, and agreed."


@pytest.fixture
def world(worker, erp):  # noqa: F811
    w = erp
    w.sales = person(worker, w, "Synthetic Sales")
    w.other = person(worker, w, "Synthetic Bystander")
    return w


def start(api, w, who, **p):
    return one(api, w, who, "select pulse.meeting_start(%s) id", (Jsonb({"title": "Synthetic launch review", "consentText": CONSENT, **p}),))["id"]


def test_a_recording_needs_consent_and_stays_with_its_people(api, worker, world):
    w = world
    # No consent, no recording.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        start(api, w, w.sales)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        start(api, w, w.sales, consent="yes")
    mid = start(api, w, w.sales, consent=True, attendees=[str(w.member)], projectId=str(w.project))
    as_(api, w, w.sales, "select pulse.meeting_part_add(%s,0,%s)", (mid, b"synthetic-audio-0"))
    as_(api, w, w.sales, "select pulse.meeting_part_add(%s,0,%s)", (mid, b"synthetic-audio-0"))   # again is harmless
    as_(api, w, w.sales, "select pulse.meeting_part_add(%s,1,%s)", (mid, b"synthetic-audio-1"))
    # Only the person recording adds audio.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.member, "select pulse.meeting_part_add(%s,2,%s)", (mid, b"x"))
    as_(api, w, w.sales, "select pulse.meeting_stop(%s,95,true)", (mid,))
    v = one(api, w, w.sales, "select pulse.meeting_view(%s) v", (mid,))["v"]
    assert (v["state"], v["seconds"], v["transcriptState"], v["kind"]) == ("saved", 95, "queued", "recording")
    assert v["consent"]["by"] == "Synthetic Sales" and v["consent"]["text"] == CONSENT
    assert [a["name"] for a in v["attendees"]] == ["Synthetic Member"]
    assert v["project"]["id"] == str(w.project)
    audio = one(api, w, w.sales, "select mime, bytes from pulse.meeting_audio(%s)", (mid,))
    assert bytes(audio["bytes"]) == b"synthetic-audio-0synthetic-audio-1"
    # The person named in it and leadership see it; a colleague who was not there does not, nor its audio.
    assert one(api, w, w.member, "select pulse.meeting_view(%s) v", (mid,))["v"]["id"] == str(mid)
    assert one(api, w, w.founder, "select pulse.meeting_view(%s) v", (mid,))["v"]["mine"] is False
    assert one(api, w, w.other, "select pulse.meeting_view(%s) v", (mid,))["v"] is None
    assert one(api, w, w.other, "select bytes from pulse.meeting_audio(%s)", (mid,)) is None
    assert one(api, w, w.other, "select pulse.meeting_list() l", ())["l"] == []
    assert [m["id"] for m in one(api, w, w.member, "select pulse.meeting_list() l", ())["l"]] == [str(mid)]
    # pulse_api has no way round the functions: the tables are not granted to it.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.sales, "select id from pulse.meeting")
    # A recording row without consent is refused by the table itself.
    with pytest.raises(psycopg.errors.CheckViolation):
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("insert into pulse.meeting(org_id,title,started_by,kind) values(%s,'Synthetic no consent',%s,'recording')", (w.org, w.sales))
    # The transcriber (pulse_worker) reads the parts and writes the transcript, as tools/voice-transcribe.py does.
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) n from pulse_priv.meeting_part where meeting_id=%s", (mid,)).fetchone()["n"] == 2
        worker.execute("update pulse.meeting set transcript_state='done',transcript='Synthetic Member will send the synthetic brochure by Monday.',actions_state='pending' where id=%s", (mid,))
    assert one(api, w, w.sales, "select pulse.meeting_view(%s) v", (mid,))["v"]["actionsState"] == "pending"
    # Deleting: the recorder or an admin; the audio and transcript go.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.member, "select pulse.meeting_remove(%s)", (mid,))
    as_(api, w, w.sales, "select pulse.meeting_remove(%s)", (mid,))
    assert one(api, w, w.sales, "select pulse.meeting_view(%s) v", (mid,))["v"] is None
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) n from pulse_priv.meeting_part where meeting_id=%s", (mid,)).fetchone()["n"] == 0


def test_notes_give_draft_actions_that_become_tasks_only_when_confirmed(api, world):
    w = world
    mid = start(api, w, w.sales, kind="notes", projectId=str(w.project), attendees=[str(w.member)])
    assert one(api, w, w.sales, "select pulse.meeting_view(%s) v", (mid,))["v"]["consent"] is None   # notes need no consent
    as_(api, w, w.sales, "select pulse.meeting_notes_set(%s,%s)", (mid, "Synthetic Member will send the synthetic brochure by Monday.\nAction: book the synthetic site visit"))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):   # someone else's notes are the recorder's (or leadership's) to write
        as_(api, w, w.member, "select pulse.meeting_notes_set(%s,'x')", (mid,))
    items = [{"title": "Send the synthetic brochure", "quote": "Synthetic Member will send the synthetic brochure by Monday.", "assigneeId": str(w.member), "dueOn": "2026-11-09"},
             {"title": "Book the synthetic site visit", "quote": "Action: book the synthetic site visit", "assigneeId": None, "dueOn": None}]
    as_(api, w, w.sales, "select pulse.meeting_actions_set(%s,%s)", (mid, Jsonb(items)))
    v = one(api, w, w.sales, "select pulse.meeting_view(%s) v", (mid,))["v"]
    assert [(a["title"], a["state"], a["assignee"]) for a in v["actions"]] == [("Send the synthetic brochure", "draft", "Synthetic Member"), ("Book the synthetic site visit", "draft", None)]
    assert v["actionsState"] == "done"
    first, second = (a["id"] for a in v["actions"])
    # No task until a person confirms; then one task, on the meeting's project, with what they changed.
    assert one(api, w, w.sales, "select count(*)::int n from pulse.task where title like '%%synthetic brochure%%'")["n"] == 0
    r = one(api, w, w.sales, "select pulse.meeting_action_decide(%s,%s,true,%s) r", (mid, first, Jsonb({"title": "Send the synthetic brochure to the client"})))["r"]
    t = one(api, w, w.sales, "select title, project_id, assignee_person_id, notes from pulse.task where id=%s", (r["taskId"],))
    assert (t["title"], t["project_id"]) == ("Send the synthetic brochure to the client", w.project)
    # A salesperson may not give a colleague outside their pod a task: it is theirs, and says whom the meeting named.
    assert r["askNeeded"] == "Synthetic Member" and t["assignee_person_id"] == w.sales
    assert "From the meeting “Synthetic launch review”" in t["notes"] and "named Synthetic Member" in t["notes"]
    # A decided item is not decided twice; one from another meeting is refused; a bystander decides nothing.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.sales, "select pulse.meeting_action_decide(%s,%s,false,'{}')", (mid, first))
    other = start(api, w, w.sales, kind="notes")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.sales, "select pulse.meeting_action_decide(%s,%s,true,'{}')", (other, second))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.other, "select pulse.meeting_action_decide(%s,%s,true,'{}')", (mid, second))
    assert one(api, w, w.member, "select pulse.meeting_action_decide(%s,%s,false,'{}') r", (mid, second))["r"]["state"] == "dropped"
    # Reading the notes again replaces only the undecided drafts.
    as_(api, w, w.sales, "select pulse.meeting_actions_set(%s,%s)", (mid, Jsonb([{"title": "Synthetic new step", "quote": None, "assigneeId": None, "dueOn": None}])))
    states = [(a["title"], a["state"]) for a in one(api, w, w.sales, "select pulse.meeting_view(%s) v", (mid,))["v"]["actions"]]
    assert states == [("Send the synthetic brochure to the client", "confirmed"), ("Book the synthetic site visit", "dropped"), ("Synthetic new step", "draft")]


def test_meetings_stay_in_their_company(api, worker, owner, world):
    w = world
    mid = start(api, w, w.sales, consent=True)
    as_(api, w, w.sales, "select pulse.meeting_part_add(%s,0,%s)", (mid, b"synthetic"))
    b = build_world(worker, owner, api)
    b.boss = person(worker, b, "Synthetic Other Boss", "leadership")
    # Leadership of another company sees nothing of it, by id or in its list, and cannot write to it.
    assert one(api, b, b.boss, "select pulse.meeting_view(%s) v", (mid,))["v"] is None
    assert one(api, b, b.boss, "select pulse.meeting_list() l", ())["l"] == []
    assert one(api, b, b.boss, "select bytes from pulse.meeting_audio(%s)", (mid,)) is None
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, b, b.boss, "select pulse.meeting_notes_set(%s,'Synthetic takeover')", (mid,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, b, b.boss, "select pulse.meeting_remove(%s)", (mid,))
    # Row security (forced) hides the rows from the transcriber working for the other company too.
    with worker.transaction():
        set_tenant(worker, b.org)
        assert worker.execute("select count(*) n from pulse.meeting where id=%s", (mid,)).fetchone()["n"] == 0
        assert worker.execute("select count(*) n from pulse_priv.meeting_part where meeting_id=%s", (mid,)).fetchone()["n"] == 0
        with pytest.raises(psycopg.Error):
            with worker.transaction():   # a savepoint: the refusal does not spoil the rest
                worker.execute("insert into pulse.meeting_action(org_id,meeting_id,position,title) values(%s,%s,0,'Synthetic cross-company')", (w.org, mid))
    for t in ("meeting", "meeting_action"):
        assert one(api, w, w.sales, "select relforcerowsecurity f from pg_class where oid=%s::regclass", (f"pulse.{t}",))["f"] is True
    assert one(api, w, w.sales, "select relforcerowsecurity f from pg_class where oid='pulse_priv.meeting_part'::regclass")["f"] is True


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_meetings_in_the_browser(api, worker, world):
    """services/api/test/kazuk-rest-meetings-browser-runner.mjs: consent, record (a fake microphone), stop, notes, draft
    action items, one made a task; Start a meeting from Pip; at 1440 and 390 (PULSE_KR_SCREENSHOTS=<dir> keeps the shots)."""
    w = world
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                       (w.org, f"founder@{w.domain}", w.founder))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_EMAILS": json.dumps({"founder": f"founder@{w.domain}"})}
    env["PULSE_VOICE_TRANSCRIPTS"] = "0"   # transcripts off: the notes path, as on a Pulse without Whisper (on by default since FIX-CHAT-AI)
    p = subprocess.run(["node", "test/kazuk-rest-meetings-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    rows = as_(api, w, w.founder, "select l from pulse.meeting_list() l")
    made = [m for m in rows[0]["l"] if m["title"] == "Synthetic launch review"]
    assert made and made[0]["tasks"] == 1 and made[0]["kind"] == "recording"
