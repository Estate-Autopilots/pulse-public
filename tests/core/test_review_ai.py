"""SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.3; migration 2044): the company's own AI checks Review data's suggestions
before a person does. Only an AI co-worker's session (its key, /api/v0/agent/*) gets the unchecked ones and keeps a
confidence and a reason on them; suggestions read from WhatsApp groups are never handed out or scored; a score
decides nothing. Synthetic tenants, people and suggestions only."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant

from test_agent_coworkers import as_agent, make_agent
from test_tasks_rt1 import as_, team  # noqa: F401  (team is a fixture)


def seed(worker, w):
    ids = {k: uuid.uuid4() for k in ("dup", "gap", "wa", "talent", "chat", "done")}
    rows = [
        ("dup", "synthetic-dup-1", "duplicate", "Synthetic Co and Synthetic Co.", "pending"),
        ("gap", "synthetic-gap-1", "data_gap", "Synthetic person has no joining date", "pending"),
        ("wa", "synthetic-wa-1", "wa_contact", "A role seen in a synthetic group", "pending"),
        ("talent", "synthetic-talent-1", "talent", "Which synthetic model", "pending"),
        ("chat", "chat:synthetic-1", "duplicate", "From a synthetic chat", "pending"),
        ("done", "synthetic-done-1", "duplicate", "Already decided", "accepted"),
    ]
    with worker.transaction():
        set_tenant(worker, w.org)
        for k, source, kind, title, status in rows:
            worker.execute("""insert into pulse.review_item(id,org_id,source_key,kind,title,proposed,confidence,evidence,status)
                              values(%s,%s,%s,%s,%s,%s,0.7,%s,%s)""", (ids[k], w.org, source, kind, title, Jsonb({}), Jsonb({"why": "synthetic"}), status))
    return ids


def test_the_company_ai_scores_suggestions_and_nothing_private(api, worker, owner, team):  # noqa: F811
    w = team
    ids = seed(worker, w)
    agent, _key = make_agent(api, w, username="data-reviewer")

    queue = as_agent(api, w, agent, "select pulse.review_ai_queue(50) q")[0]["q"]
    # Stable batches use the existing primary key; review_item has no created_at.
    assert [x["id"] for x in queue] == sorted(x["id"] for x in queue)
    assert as_agent(api, w, agent, "select pulse.review_ai_queue(1) q")[0]["q"] == queue[:1]
    handed = {x["id"] for x in queue}
    assert {str(ids["dup"]), str(ids["gap"])} <= handed
    # Never WhatsApp-derived suggestions, never decided ones.
    assert not handed & {str(ids[k]) for k in ("wa", "talent", "chat", "done")}

    scores = [{"id": str(ids["dup"]), "confidence": 0.96, "reason": "Same name and city"},
              {"id": str(ids["gap"]), "confidence": 0.4, "reason": "No record of a start date"},
              {"id": str(ids["wa"]), "confidence": 0.99, "reason": "should be ignored"},
              {"id": str(ids["done"]), "confidence": 0.99, "reason": "should be ignored"}]
    assert as_agent(api, w, agent, "select pulse.review_ai_score(%s) n", (Jsonb(scores),))[0]["n"] == 2
    with worker.transaction():
        set_tenant(worker, w.org)
        got = {str(r["id"]): r for r in worker.execute(
            "select id, ai_confidence::float c, ai_reason r, ai_scorer s, status from pulse.review_item where id = any(%s)", (list(ids.values()),)).fetchall()}
    assert (got[str(ids["dup"])]["c"], got[str(ids["dup"])]["r"], got[str(ids["dup"])]["s"]) == (0.96, "Same name and city", agent)
    assert got[str(ids["gap"])]["c"] == 0.4
    assert got[str(ids["wa"])]["c"] is None and got[str(ids["done"])]["c"] is None
    # A score decides nothing.
    assert got[str(ids["dup"])]["status"] == "pending"
    # Scored ones leave the queue.
    assert not {x["id"] for x in as_agent(api, w, agent, "select pulse.review_ai_queue(50) q")[0]["q"]} & {str(ids["dup"]), str(ids["gap"])}

    # Bad scores are refused whole.
    for bad in ([{"id": str(ids["gap"]), "confidence": 1.5, "reason": "x"}], [{"id": str(ids["gap"]), "confidence": 0.5, "reason": " "}], {"not": "a list"}):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            as_agent(api, w, agent, "select pulse.review_ai_score(%s) n", (Jsonb(bad),))


def test_only_an_ai_coworker_session_reads_or_scores(api, worker, owner, team):  # noqa: F811
    w = team
    ids = seed(worker, w)
    agent, _key = make_agent(api, w, username="data-reviewer-2")
    score = Jsonb([{"id": str(ids["dup"]), "confidence": 0.9, "reason": "x"}])
    # A person (even an admin), and the agent without its session switched on, are refused.
    for who in (w.manager, w.editor, agent):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, "select pulse.review_ai_queue(10)")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, "select pulse.review_ai_score(%s)", (score,))
