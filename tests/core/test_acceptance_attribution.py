"""Acceptance: an upload through a shared login is credited to the editor whose computer rendered the same bytes
(export fingerprint = render MD5 equal to Drive's md5Checksum, likelihood ratio 1,000)."""

from __future__ import annotations

from pulse_sdk.db import set_tenant
from pulse_workers.projector import ProjectionRunner
from pulse_workers.workgraph import WorkGraph

from helpers import build_world, create_task, drive_id, emit, issue_asset, render, upload


def project(worker, w):
    ProjectionRunner(worker, WorkGraph()).catch_up(w.org)


def credit(worker, w, file_name):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute(
            """select v.creator_person_id, v.attribution_p, at.person_id, at.probability, at.method, at.evidence,
                      at.event_seq, v.existence_confidence
                 from pulse.version v join pulse.file f on f.id = v.file_id
                 join pulse.attribution at on at.version_id = v.id
                where f.name = %s""", (file_name,)).fetchone()


def test_shared_login_upload_credited_by_export_fingerprint(worker, owner, api):
    w = build_world(worker, owner, api)
    cid = w.cid("HK", 3)
    issue_asset(api, w, cid)
    name = f"{cid}-v2.mp4"
    render(worker, w, w.device, name, "the-export", minutes=10)               # editor 1's computer
    render(worker, w, w.device2, "something-else.mp4", "other", minutes=12)   # editor 2 rendered other bytes
    upload(worker, w, drive_id(), name, "the-export", folder=w.drafts, minutes=30,
           actor=f"account:google:{w.shared_handle}")                         # the shared login uploads it
    project(worker, w)
    c = credit(worker, w, name)
    assert c["method"] == "evidence"
    assert c["person_id"] == w.editor and c["creator_person_id"] == w.editor
    assert float(c["probability"]) >= 0.95
    assert any(e["group"] == "hash" for e in c["evidence"])
    assert float(c["existence_confidence"]) >= 0.90


def test_shared_login_upload_without_fingerprint_is_not_credited(worker, owner, api):
    """Control: same upload, no render evidence -> nobody is credited automatically (asked instead)."""
    w = build_world(worker, owner, api)
    cid = w.cid("HK", 5)
    task = create_task(api, w, w.editor)
    issue_asset(api, w, cid, task=task, minutes=3)
    name = f"{cid}-v1.mp4"
    upload(worker, w, drive_id(), name, "no-fingerprint", folder=w.drafts, minutes=30)
    project(worker, w)
    c = credit(worker, w, name)
    assert c["method"] == "unresolved" and c["creator_person_id"] is None
    assert c["person_id"] == w.editor                 # the assignee is the one asked "was this yours?"
    assert 0.60 <= float(c["probability"]) < 0.95


def test_fingerprint_arriving_late_still_credits(worker, owner, api):
    """The editor's computer was offline: the render arrives after the upload was projected."""
    w = build_world(worker, owner, api)
    cid = w.cid("VV", 1)
    issue_asset(api, w, cid)
    name = f"{cid}-v1.mp4"
    upload(worker, w, drive_id(), name, "late-render", folder=w.finals, minutes=30)
    project(worker, w)
    assert credit(worker, w, name)["method"] == "unresolved"
    render(worker, w, w.device2, name, "late-render", minutes=25)               # rendered earlier, sent later
    project(worker, w)
    c = credit(worker, w, name)
    assert c["method"] == "evidence" and c["person_id"] == w.editor2


def test_not_mine_and_confirmation(worker, owner, api):
    w = build_world(worker, owner, api)
    cid = w.cid("HK", 6)
    issue_asset(api, w, cid)
    name = f"{cid}-v1.mp4"
    render(worker, w, w.device, name, "contested", minutes=10)
    upload(worker, w, drive_id(), name, "contested", folder=w.drafts, minutes=30)
    project(worker, w)
    c = credit(worker, w, name)
    assert c["person_id"] == w.editor
    seq = c["event_seq"]
    emit(api, w.org, "attribution.rejected", f"event:pulse:{seq}", {"person_ref": f"person:pulse:{w.editor}"},
         source="/api/web", time=w.at(60))
    project(worker, w)
    assert credit(worker, w, name)["creator_person_id"] is None
    emit(api, w.org, "attribution.confirmed", f"event:pulse:{seq}", {"person_ref": f"person:pulse:{w.editor2}"},
         source="/api/web", time=w.at(70))
    project(worker, w)
    c = credit(worker, w, name)
    assert c["method"] == "declared" and c["creator_person_id"] == w.editor2


def test_excluded_person_is_never_credited(worker, owner, api):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.person set tracking_excluded = true where id = %s", (w.editor,))
    cid = w.cid("HK", 7)
    issue_asset(api, w, cid)
    name = f"{cid}-v1.mp4"
    render(worker, w, w.device, name, "excluded", minutes=10)
    upload(worker, w, drive_id(), name, "excluded", folder=w.drafts, minutes=30)
    project(worker, w)
    c = credit(worker, w, name)
    assert c["person_id"] != w.editor and c["creator_person_id"] is None
