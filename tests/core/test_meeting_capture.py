"""MEETING-CAPTURE (1946): a transcript pasted or uploaded becomes a meeting kept line by line, searchable only by the people
who may see that meeting (row security per meeting, for every role, the SECURITY DEFINER functions included); its drafts
become tasks only when a person confirms them, and a task links back to its line; a narrated problem's draft is
confirmed as the person's own bug report (or a task); nothing crosses to another company. Synthetic words only."""
import uuid

import psycopg
import pytest
from helpers import build_world
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import (  # noqa: F401  (erp is a fixture)
    as_,
    erp,
    one,
    person,
)

LINES = [{"speaker": "Synthetic Member", "at": 2, "text": "Welcome to the synthetic pricing review."},
         {"speaker": "Synthetic Sales", "at": 15, "text": "I will send the synthetic brochure by Monday."},
         {"speaker": "Synthetic Member", "at": 40, "text": "We agreed to keep the zebracorn price."}]


@pytest.fixture
def world(worker, erp):  # noqa: F811
    w = erp
    w.sales = person(worker, w, "Synthetic Sales")
    w.other = person(worker, w, "Synthetic Bystander")
    return w


def imported(api, w, who, **p):
    body = {"title": "Synthetic pricing review, 9 Nov 2026", "transcript": "\n".join(x["text"] for x in LINES), "lines": LINES, "format": "vtt",
            "source": "file", "sourceName": "pricing.vtt", "summary": "2 people spoke.", "speakers": ["Synthetic Member", "Synthetic Sales"], "heldOn": "2026-11-05", **p}
    return one(api, w, who, "select pulse.meeting_import(%s) id", (Jsonb(body),))["id"]


def test_an_imported_transcript_is_kept_line_by_line_for_its_people_only(api, worker, owner, world):
    w = world
    mid = imported(api, w, w.sales, attendees=[str(w.member)])
    v = one(api, w, w.sales, "select pulse.meeting_view(%s) v", (mid,))["v"]
    assert (v["source"], v["sourceFormat"], v["sourceName"], v["purpose"], v["heldOn"], v["kind"], v["consent"]) == ("file", "vtt", "pricing.vtt", "meeting", "2026-11-05", "notes", None)
    assert (v["transcriptState"], v["actionsState"], v["summary"], v["speakers"]) == ("done", "pending", "2 people spoke.", ["Synthetic Member", "Synthetic Sales"])
    assert [(x["n"], x.get("speaker"), x.get("at")) for x in v["lines"]] == [(1, "Synthetic Member", 2), (2, "Synthetic Sales", 15), (3, "Synthetic Member", 40)]
    # Search: the people in it and leadership find the line; a colleague who was not there finds nothing.
    for who in (w.sales, w.member, w.founder):
        hits = one(api, w, who, "select pulse.meeting_search('zebracorn') r")["r"]
        assert [(h["meetingId"], h["n"]) for h in hits] == [(str(mid), 3)], who
    assert one(api, w, w.other, "select pulse.meeting_search('zebracorn') r")["r"] == []
    assert one(api, w, w.member, "select pulse.meeting_search('brochure') r")["r"][0]["speaker"] == "Synthetic Sales"
    assert one(api, w, w.sales, "select pulse.meeting_search('z') r")["r"] == []      # too short
    assert one(api, w, w.sales, "select pulse.meeting_search('100%%_') r")["r"] == []   # wildcards are words
    # Row security per meeting, for every role: the table owner (the functions' own role) reads only the lines of
    # meetings the viewer may see, even with no WHERE; the API role has no table grant at all.
    with owner.transaction():
        set_tenant(owner, w.org, w.other)
        assert owner.execute("select count(*) n from pulse.meeting_line").fetchone()["n"] == 0
        set_tenant(owner, w.org, w.member)
        assert owner.execute("select count(*) n from pulse.meeting_line").fetchone()["n"] == 3
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.sales, "select count(*) from pulse.meeting_line")
    for t in ("meeting_line",):
        f = one(api, w, w.sales, "select relrowsecurity r, relforcerowsecurity f from pg_class where oid=%s::regclass", (f"pulse.{t}",))
        assert f["r"] is True and f["f"] is True
    # Only the person who brought it in (or leadership/admins) rewrites its lines; the first fill is anyone's who sees it.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.member, "select pulse.meeting_lines_set(%s,'[]'::jsonb,null,'{}')", (mid,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.other, "select pulse.meeting_lines_set(%s,'[]'::jsonb,null,'{}')", (mid,))
    # Notes written again clear the lines (the API reads them again from the new text).
    as_(api, w, w.sales, "select pulse.meeting_notes_set(%s,%s)", (mid, "Synthetic corrected line."))
    v = one(api, w, w.sales, "select pulse.meeting_view(%s) v", (mid,))["v"]
    assert v["lines"] == [] and v["summary"] is None
    as_(api, w, w.member, "select pulse.meeting_lines_set(%s,%s,%s,%s)", (mid, Jsonb([{"text": "Synthetic corrected line."}]), "One line.", ["Synthetic Sales"]))
    assert one(api, w, w.member, "select pulse.meeting_view(%s) v", (mid,))["v"]["lines"] == [{"n": 1, "text": "Synthetic corrected line."}]
    # Deleting takes the lines too.
    as_(api, w, w.sales, "select pulse.meeting_remove(%s)", (mid,))
    with owner.transaction():
        set_tenant(owner, w.org, w.sales)
        assert owner.execute("select count(*) n from pulse.meeting_line where meeting_id=%s", (mid,)).fetchone()["n"] == 0


def test_imports_are_checked(api, world):
    w = world
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        imported(api, w, w.sales, transcript="   ")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        imported(api, w, w.sales, source="email")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        imported(api, w, w.sales, purpose="gossip")
    mid = imported(api, w, w.sales, title=" ", format="pdf", sourceName="bad\u0007name.txt", heldOn="05/11/2026",
                   lines=[{"speaker": "x" * 200, "at": 999999, "text": "Synthetic long speaker."}, {"text": "  "}])
    v = one(api, w, w.sales, "select pulse.meeting_view(%s) v", (mid,))["v"]
    assert (v["title"], v["sourceFormat"], v["sourceName"], v["heldOn"]) == ("Meeting", None, "bad name.txt", None)
    assert v["lines"] == [{"n": 1, "speaker": "x" * 80, "text": "Synthetic long speaker."}]
    # Only staff bring meetings in.
    client_person = uuid.uuid4()
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        imported(api, w, client_person)


def test_drafts_link_tasks_back_to_their_line_and_a_problem_files_a_bug(api, owner, world):
    w = world
    mid = imported(api, w, w.sales, projectId=str(w.project))
    as_(api, w, w.sales, "select pulse.meeting_actions_set(%s,%s)", (mid, Jsonb([
        {"title": "Send the synthetic brochure", "quote": "I will send the synthetic brochure by Monday.", "assigneeId": str(w.sales), "dueOn": "2026-11-09", "lineNo": 2},
        {"title": "Tasks: the synthetic list does not scroll", "quote": "The synthetic list does not scroll on tasks.", "kind": "bug", "route": "/tasks", "lineNo": 3},
        {"title": "Synthetic bad route", "kind": "bug", "route": "javascript:alert(1)", "lineNo": 0}])))
    acts = one(api, w, w.sales, "select pulse.meeting_view(%s) v", (mid,))["v"]["actions"]
    assert [(a["kind"], a["route"], a["lineNo"]) for a in acts] == [("task", None, 2), ("bug", "/tasks", 3), ("bug", None, None)]
    task, bug, bad = (a["id"] for a in acts)
    # A task draft: one task, its notes link to the transcript's line; the task page finds the meeting.
    r = one(api, w, w.sales, "select pulse.meeting_action_decide(%s,%s,true,'{}') r", (mid, task))["r"]
    notes = one(api, w, w.sales, "select notes from pulse.task where id=%s", (r["taskId"],))["notes"]
    assert "From the meeting “Synthetic pricing review, 9 Nov 2026” on 05 Nov 2026" in notes and "/meetings/" not in notes
    got = one(api, w, w.member, "select pulse.meeting_for_task(%s) m", (r["taskId"],))["m"]
    assert got is None                                                   # the member was not in it
    got = one(api, w, w.sales, "select pulse.meeting_for_task(%s) m", (r["taskId"],))["m"]
    assert (got["id"], got["line"], got["kind"]) == (str(mid), 2, "task")
    # A bug draft is confirmed only with the viewer's own report in this company.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.sales, "select pulse.meeting_action_decide(%s,%s,true,'{}')", (mid, bug))
    rid, theirs = uuid.uuid4(), uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, w.org)
        for i, (bid, who) in enumerate(((rid, w.sales), (theirs, w.member))):
            owner.execute("insert into pulse.reported_bug(id,org_id,number,person_id,command_id,words,route,fingerprint) values(%s,%s,%s,%s,%s,'Synthetic narrated bug','/tasks',repeat('a',64))",
                          (bid, w.org, 9000 + i, who, f"meeting-synthetic-{i}"))
    with pytest.raises(psycopg.errors.InvalidParameterValue):            # someone else's report
        as_(api, w, w.sales, "select pulse.meeting_action_decide(%s,%s,true,%s)", (mid, bug, Jsonb({"bugId": str(theirs)})))
    r = one(api, w, w.sales, "select pulse.meeting_action_decide(%s,%s,true,%s) r", (mid, bug, Jsonb({"bugId": str(rid)})))["r"]
    assert (r["state"], r["bugId"], r["bugNumber"]) == ("confirmed", str(rid), 9000)
    # A bug draft made a task instead: a task, with the page it named.
    r = one(api, w, w.sales, "select pulse.meeting_action_decide(%s,%s,true,%s) r", (mid, bad, Jsonb({"kind": "task"})))["r"]
    assert one(api, w, w.sales, "select count(*)::int n from pulse.task where id=%s", (r["taskId"],))["n"] == 1
    kinds = [(a["kind"], a["state"], a.get("bugNumber")) for a in one(api, w, w.sales, "select pulse.meeting_view(%s) v", (mid,))["v"]["actions"]]
    assert kinds == [("task", "confirmed", None), ("bug", "confirmed", 9000), ("task", "confirmed", None)]


def test_a_narrated_problem_recording_and_another_company(api, worker, owner, world):
    w = world
    # A recorded narration: only the person's own voice, so its own consent words; purpose 'problem'.
    pid = one(api, w, w.sales, "select pulse.meeting_start(%s) id", (Jsonb({"purpose": "problem", "consent": True, "consentText": "Synthetic: only me."}),))["id"]
    v = one(api, w, w.sales, "select pulse.meeting_view(%s) v", (pid,))["v"]
    assert (v["purpose"], v["source"], v["kind"], v["consent"]["text"]) == ("problem", "recorder", "recording", "Synthetic: only me.")
    mid = imported(api, w, w.sales)
    b = build_world(worker, owner, api)
    b.boss = person(worker, b, "Synthetic Other Boss", "leadership")
    assert one(api, b, b.boss, "select pulse.meeting_search('zebracorn') r")["r"] == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, b, b.boss, "select pulse.meeting_lines_set(%s,'[]'::jsonb,null,'{}')", (mid,))
    with owner.transaction():
        set_tenant(owner, b.org, b.boss)
        assert owner.execute("select count(*) n from pulse.meeting_line where meeting_id=%s", (mid,)).fetchone()["n"] == 0
    with worker.transaction():
        set_tenant(worker, b.org)
        with pytest.raises(psycopg.Error):
            with worker.transaction():
                worker.execute("insert into pulse.meeting_line(org_id,meeting_id,n,words) values(%s,%s,99,'Synthetic cross-company')", (w.org, mid))
