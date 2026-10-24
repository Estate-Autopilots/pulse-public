"""Acceptance: one file seen by Drive and by the desktop app is ONE asset (and one version), in either order."""

from __future__ import annotations

from pulse_sdk.db import set_tenant
from pulse_workers.projector import ProjectionRunner
from pulse_workers.workgraph import WorkGraph

from helpers import build_world, drive_id, issue_asset, render, upload


def project(worker, w):
    ProjectionRunner(worker, WorkGraph()).catch_up(w.org)


def assets(worker, w):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute(
            """select a.id, a.cid, a.legacy_key, count(v.id) as versions,
                      array_agg(v.version_no order by v.version_no) as nos,
                      array_agg(v.file_id is not null order by v.version_no) as linked,
                      array_agg(v.md5 order by v.version_no) as md5s
                 from pulse.asset a left join pulse.version v on v.asset_id = a.id
                group by a.id order by a.cid nulls last""").fetchall()


def test_render_then_drive_upload_is_one_asset(worker, owner, api):
    w = build_world(worker, owner, api)
    cid = w.cid("HK", 3)
    issue_asset(api, w, cid)
    render(worker, w, w.device, f"{cid}-v2.mp4", "bytes-A", minutes=10)
    project(worker, w)
    upload(worker, w, drive_id(), f"{cid}-v2.mp4", "bytes-A", folder=w.drafts, minutes=20)
    project(worker, w)
    rows = assets(worker, w)
    assert len(rows) == 1, rows
    assert rows[0]["cid"] == cid and rows[0]["versions"] == 1 and rows[0]["nos"] == [2]
    assert rows[0]["linked"] == [True]


def test_drive_upload_then_render_is_one_asset(worker, owner, api):
    w = build_world(worker, owner, api)
    cid = w.cid("MV", 1)
    issue_asset(api, w, cid)
    upload(worker, w, drive_id(), f"{cid}-v1.mp4", "bytes-B", folder=w.finals, minutes=20)
    project(worker, w)
    render(worker, w, w.device, f"{cid}-v1.mp4", "bytes-B", minutes=30)
    project(worker, w)
    rows = assets(worker, w)
    assert len(rows) == 1 and rows[0]["versions"] == 1 and rows[0]["linked"] == [True], rows


def test_same_bytes_under_a_legacy_name_join_the_cid_asset(worker, owner, api):
    """The editor renders EA..-HK03-v1.mp4; someone uploads the same bytes as 'hook final.mp4'."""
    w = build_world(worker, owner, api)
    cid = w.cid("HK", 3)
    issue_asset(api, w, cid)
    # Drive first: no CID in the name -> a legacy asset is created ...
    upload(worker, w, drive_id(), "hook final.mp4", "bytes-C", folder=w.drafts, minutes=20)
    project(worker, w)
    with_versions = [r for r in assets(worker, w) if r["versions"]]
    assert [r["legacy_key"] is not None for r in with_versions] == [True]
    # ... then the render with the CID and the same MD5 arrives: the legacy asset is merged into the CID asset.
    render(worker, w, w.device, f"{cid}-v1.mp4", "bytes-C", minutes=30)
    project(worker, w)
    rows = assets(worker, w)
    assert len(rows) == 1, rows
    assert rows[0]["cid"] == cid and rows[0]["versions"] == 1 and rows[0]["linked"] == [True]


def test_legacy_name_render_and_upload_without_cid_is_one_asset(worker, owner, api):
    w = build_world(worker, owner, api)
    render(worker, w, w.device, "Rogotipil walkthrough final.mp4", "bytes-D", minutes=10)
    upload(worker, w, drive_id(), "Rogotipil walkthrough final.mp4", "bytes-D", folder=w.finals, minutes=20)
    upload(worker, w, drive_id(), "Rogotipil walkthrough final (1).mp4", "bytes-D", folder=w.drafts, minutes=25)
    project(worker, w)
    rows = assets(worker, w)
    assert len(rows) == 1 and rows[0]["legacy_key"] is not None and rows[0]["versions"] == 1, rows


def test_versions_and_non_deliverables(worker, owner, api):
    w = build_world(worker, owner, api)
    cid = w.cid("HK", 4)
    issue_asset(api, w, cid)
    upload(worker, w, drive_id(), f"{cid}-v1.mp4", "v1", folder=w.drafts, minutes=10)
    upload(worker, w, drive_id(), f"{cid}-v2.mp4", "v2", folder=w.drafts, minutes=20)
    upload(worker, w, drive_id(), f"{cid}.mp4", "v3-no-number", folder=w.drafts, minutes=30)   # numbered by arrival
    upload(worker, w, drive_id(), "leads export.csv", "x", folder=w.leads_folder, minutes=40, mime="text/csv")
    upload(worker, w, drive_id(), "notes.mp4", "y", folder=w.root, minutes=50)                 # not under a stage folder
    project(worker, w)
    rows = assets(worker, w)
    assert len(rows) == 1 and rows[0]["nos"] == [1, 2, 3], rows
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) as n from pulse.file").fetchone()["n"] == 5   # every file is tracked
