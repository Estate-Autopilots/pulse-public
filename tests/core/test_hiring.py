"""READY (0972): Hiring joins a candidate to an internal job and carries them through an interview stage. HR and
admins only; the interview needs a time and keeps one task for the interviewer, moved when the time moves. Synthetic
people and jobs only."""
import psycopg
import pytest
from psycopg.types.json import Jsonb
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def r(api, w, who, sql, args):
    return one(api, w, who, sql, args)["r"]


def test_a_candidate_is_linked_to_a_job_and_interviewed(api, team):
    w = team
    job = r(api, w, w.lead, "select pulse.ats_job_save(%s,%s) r", (None, Jsonb({"title": "Synthetic reel editor"})))
    cand = r(api, w, w.lead, "select pulse.lifecycle_candidate(%s) r", (Jsonb({"name": "Synthetic Candidate", "role": "Video Editor"}),))
    listed = r(api, w, w.lead, "select pulse.hiring_list(%s) r", (job,))
    assert listed["applications"] == [] and str(cand) in {p["id"] for p in listed["pool"]}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.hiring_list(%s)", (job,))
    app = r(api, w, w.lead, "select pulse.hiring_link(%s,%s) r", (job, cand))
    assert r(api, w, w.lead, "select pulse.hiring_link(%s,%s) r", (job, cand)) == app  # linking twice is one link
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="date and time"):
        as_(api, w, w.lead, "select pulse.hiring_update(%s,%s)", (app, Jsonb({"stage": "interview"})))
    out = r(api, w, w.lead, "select pulse.hiring_update(%s,%s) r", (app, Jsonb({"stage": "interview", "interviewAt": "2026-11-02T11:00:00+05:30",
                                                                               "interviewerId": str(w.editor2), "place": "Synthetic room"})))
    task = one(api, w, w.lead, "select title,assignee_person_id who,due_at from pulse.task where id=%s", (out["taskId"],))
    assert task["title"] == "Interview Synthetic Candidate for Synthetic reel editor" and task["who"] == w.editor2
    moved = r(api, w, w.lead, "select pulse.hiring_update(%s,%s) r", (app, Jsonb({"interviewAt": "2026-11-03T15:00:00+05:30"})))
    assert moved["taskId"] == out["taskId"]  # one task, moved with the interview
    row = r(api, w, w.lead, "select pulse.hiring_list(%s) r", (job,))["applications"][0]
    assert (row["stage"], row["interviewer"] is not None, row["place"]) == ("interview", True, "Synthetic room")
    assert r(api, w, w.lead, "select pulse.hiring_update(%s,%s) r", (app, Jsonb({"stage": "offer"})))["stage"] == "offer"
