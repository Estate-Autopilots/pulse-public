"""TASK-MERGE decision model (1852): the worker keeps one vector per open task (re-embedding only retitled ones, dropping
closed ones); the API reads a vector only for a task the viewer may see, and the suggester's cosine comes from them.
A fake embedder stands in for the model (its quality is measured in DECISION-MODELS.md). Fake titles only."""
from pulse_sdk.db import set_tenant
from pulse_workers import task_embed
from test_tasks_rt1 import as_, new_task, one, team  # noqa: F401  (fixture)


class Fake:
    """Two directions: titles with "reel" point one way, everything else the other."""
    calls = 0

    def embed(self, texts):
        Fake.calls += len(texts)
        return [[1.0] + [0.0] * 255 if "reel" in t.lower() else [0.0, 1.0] + [0.0] * 254 for t in texts]


def refresh(worker, w):
    with worker.transaction():
        set_tenant(worker, w.org)
        return task_embed.refresh(worker, Fake())


def test_vectors_follow_open_tasks_and_are_read_only_where_the_task_is_seen(api, worker, team):  # noqa: F811
    w = team
    a = new_task(api, w, w.editor2, title="EXAMPLE reel cut for Demo Tower", assigneeId=str(w.editor))
    b = new_task(api, w, w.editor2, title="EXAMPLE Demo Tower reel edit karna hai", assigneeId=str(w.editor))
    c = new_task(api, w, w.editor2, title="EXAMPLE pay the vendor", assigneeId=str(w.editor))
    r = refresh(worker, w)
    assert r["embedded"] >= 3 and r["dropped"] == 0
    # Nothing changed: nothing is embedded again.
    Fake.calls = 0
    assert refresh(worker, w)["embedded"] == 0 and Fake.calls == 0
    cos = one(api, w, w.editor, """select 1-(x.embedding<=>y.embedding) c from pulse.task_embedding x, pulse.task_embedding y
                                    where x.task_id=%s and y.task_id=%s""", (a, b))["c"]
    assert cos > 0.99
    assert one(api, w, w.editor, "select pulse.merge_model_on() ok")["ok"] is True
    # Someone who cannot see the tasks sees no vectors.
    assert as_(api, w, w.outsider, "select task_id from pulse.task_embedding where task_id = any(%s)", ([a, b, c],)) == []
    # A closed task's vector goes.
    as_(api, w, w.editor, "select pulse.task_move(%s,'cancelled',null)", (c,))
    assert refresh(worker, w)["dropped"] == 1
