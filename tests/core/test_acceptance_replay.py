"""Acceptance: replaying the log gives identical projections (02 §5)."""

from __future__ import annotations

from pulse_workers.projector import ProjectionRunner, fingerprint
from pulse_workers.workgraph import WorkGraph

from helpers import FOLDER_MIME, build_world, create_task, drive_id, emit, issue_asset, render, upload


def test_rebuild_equals_incremental(worker, owner, api):
    w = build_world(worker, owner, api)
    p = WorkGraph()
    runner = ProjectionRunner(worker, p, batch=3)       # small batches: many incremental steps
    task = create_task(api, w, w.editor)
    a = w.cid("HK", 3)
    b = w.cid("MV", 1)
    issue_asset(api, w, a, task=task, minutes=3)
    runner.catch_up(w.org)
    # A day of work arriving in pieces, with the projector running in between.
    render(worker, w, w.device, f"{a}-v1.mp4", "a1", minutes=10)
    upload(worker, w, drive_id(), f"{a}-v1.mp4", "a1", folder=w.drafts, minutes=20)
    runner.catch_up(w.org)
    upload(worker, w, drive_id(), "model video final.mp4", "b1", folder=w.finals, minutes=25)   # legacy name first
    sub = drive_id()
    emit(worker, w.org, "drive.folder.created", f"file:gdrive:{sub}",
         {"name": "Drafts", "mime": FOLDER_MIME, "parents": [w.finals]}, source=w.changes, time=w.at(26))
    upload(worker, w, drive_id(), f"{a}-v2.mp4", "a2", folder=sub, minutes=27)                   # nested drafts
    runner.catch_up(w.org)
    issue_asset(api, w, b, minutes=28)
    render(worker, w, w.device2, f"{b}-v1.mp4", "b1", minutes=24)                                # merges the legacy
    upload(worker, w, drive_id(), f"{a}-v3.mp4", "a3", folder=w.drafts, minutes=40,
           actor=f"account:google:{w.editor_handle}")
    emit(api, w.org, "leave.declared", f"person:pulse:{w.editor2}",
         {"from": w.at(0).date().isoformat(), "to": w.at(0).date().isoformat()}, source="/api/web", time=w.at(41))
    runner.catch_up(w.org)

    incremental = fingerprint(worker, w.org, p.tables)
    assert incremental["pulse.version"].split(":")[0] == "4"        # a v1-v3 and b v1
    assert incremental["pulse.attribution"].split(":")[0] == "4"
    replayed = runner.rebuild(w.org)
    assert replayed > 0
    assert fingerprint(worker, w.org, p.tables) == incremental
    runner.rebuild(w.org)                                            # and again: stable
    assert fingerprint(worker, w.org, p.tables) == incremental


def test_rebuild_is_atomic_and_keeps_references(worker, owner, api, admin):
    """Rows in other tables that point at projection rows survive a rebuild (deterministic ids, deferred FKs)."""
    w = build_world(worker, owner, api)
    a = w.cid("HK", 8)
    issue_asset(api, w, a)
    upload(worker, w, drive_id(), f"{a}-v1.mp4", "keep", folder=w.drafts, minutes=20)
    runner = ProjectionRunner(worker, WorkGraph())
    runner.catch_up(w.org)
    with worker.transaction():
        worker.execute("select set_config('pulse.org_id', %s, true)", (str(w.org),))
        vid = worker.execute("select id from pulse.version").fetchone()["id"]
        worker.execute("insert into pulse.review (org_id, version_id, reviewer_kind) values (%s, %s, 'ai')",
                       (w.org, vid))
    runner.rebuild(w.org)
    with worker.transaction():
        worker.execute("select set_config('pulse.org_id', %s, true)", (str(w.org),))
        assert worker.execute("select count(*) as n from pulse.review r join pulse.version v on v.id = r.version_id"
                              ).fetchone()["n"] == 1
