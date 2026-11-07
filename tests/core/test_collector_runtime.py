"""The collector contract and runtime guarantees (05 §5.2), with a fake Drive audit collector."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from pulse_sdk.collector import AuthStatus, Health, Manifest, RawRecord, Scope, TenantContext
from pulse_sdk.db import set_tenant
from pulse_sdk.runtime import MAX_ATTEMPTS, CollectorRuntime

from helpers import build_world, md5_of

MANIFEST = Manifest.from_dict({
    "name": "gdrive_audit", "version": "1.0.0", "source_kind": "pull", "provider": "google_workspace",
    "auth": "google_service_account_dwd", "emits": ["drive.file.uploaded", "drive.file.created"],
    "purposes": ["delivery"], "sensitivity": 1, "schedule": {"incremental": "*/10 * * * *"},
    "backfill": {"max_days": 180}, "consent": "notice",
})


class FakeAudit:
    """Pages of audit records; ``broken`` record ids normalise to an event without a purpose."""

    manifest = MANIFEST

    def __init__(self, pages, broken=()):
        self.pages = list(pages)
        self.broken = set(broken)
        self.polls = 0

    def authorize(self, ctx):
        return AuthStatus(True)

    def scope(self, ctx):
        return Scope(("all",))

    def backfill(self, ctx, since, cursor):
        start = (cursor or {}).get("page", 0)
        for i in range(start, len(self.pages)):
            yield self.pages[i], {"page": i + 1}

    def poll(self, ctx, cursor):
        self.polls += 1
        page = (cursor or {}).get("page", 0)
        records = self.pages[page] if page < len(self.pages) else []
        return records, {"page": min(page + 1, len(self.pages))}

    def handle_push(self, ctx, req):
        raise NotImplementedError

    def normalise(self, ctx, raw):
        p = raw.payload
        ev = {"type": "drive.file.uploaded", "time": p["time"], "subject": f"file:gdrive:{p['doc_id']}",
              "actor": f"account:google:{p['actor']}", "actorkind": "account", "purpose": "delivery",
              "sensitivity": 1, "visibility": "team",
              "data": {"name": p["title"], "mime": "video/mp4", "parents": [p["parent"]], "md5": p["md5"]}}
        if raw.source_ref in self.broken:
            del ev["purpose"]
        return [ev]

    def health(self, ctx):
        return Health(True)


def record(w, n, actor=None):
    t = (w.t0 + timedelta(minutes=n)).isoformat()
    return RawRecord(f"audit-{w.code}-{n}", {"time": t, "doc_id": f"doc{w.code}{n}", "actor": actor or w.shared_handle,
                                             "title": f"file{n}.mp4", "parent": w.drafts, "md5": md5_of(str(n))})


def count(worker, w, sql):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute(sql).fetchone()["n"]


def test_raw_first_cursor_and_idempotent_rerun(worker, owner, api):
    w = build_world(worker, owner, api)
    fake = FakeAudit([[record(w, 1), record(w, 2)], [record(w, 3)]])
    rt = CollectorRuntime(worker, fake)
    ctx = TenantContext(w.org, w.instance)
    r1 = rt.poll(ctx)
    assert (r1.raw_stored, r1.events_accepted) == (2, 2)
    r2 = rt.poll(ctx)
    assert (r2.raw_stored, r2.events_accepted) == (1, 1)
    assert count(worker, w, "select count(*) as n from pulse.raw_inbox where processed_at is not null") == 3
    cursor = count(worker, w, "select (cursor->>'page')::int as n from pulse.collector_cursor")
    assert cursor == 2
    # Re-normalising everything (e.g. after a normaliser fix) reproduces the same deterministic ids: no duplicates.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.raw_inbox set processed_at = null")
    r3 = rt.normalise_pending(ctx)
    assert (r3.events_accepted, r3.events_duplicate) == (0, 3)
    assert count(worker, w, "select count(*) as n from pulse.event where type = 'drive.file.uploaded'") == 3


def test_event_without_purpose_is_dead_lettered_not_stored(worker, owner, api):
    w = build_world(worker, owner, api)
    bad = record(w, 7)
    alerts = []
    fake = FakeAudit([[record(w, 6), bad]], broken={bad.source_ref})
    rt = CollectorRuntime(worker, fake, on_dead_letter=lambda name, msg: alerts.append((name, msg)))
    ctx = TenantContext(w.org, w.instance)
    report = rt.poll(ctx)
    assert report.events_accepted == 1 and report.retried == 1
    for _ in range(MAX_ATTEMPTS - 1):
        report = rt.normalise_pending(ctx)
    assert report.dead_letters == 1 and alerts and "purpose" in alerts[0][1]
    assert count(worker, w, "select count(*) as n from pulse.event where subject like 'file:gdrive:doc%%7'") == 0
    assert count(worker, w, "select count(*) as n from pulse.raw_inbox where error like '%%purpose%%'") == 1


def test_consent_filter_drops_uncovered_person_events(worker, owner, api):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.person set tracking_excluded = true where id = %s", (w.editor,))
    fake = FakeAudit([[record(w, 8, actor=w.editor_handle), record(w, 9)]])     # individual account of an excluded
    report = CollectorRuntime(worker, fake).poll(TenantContext(w.org, w.instance))
    assert report.events_dropped == 1 and report.events_accepted == 1
    assert report.reasons == {"person is excluded from tracking": 1}


def test_backfill_commits_in_small_batches(worker, owner, api):
    w = build_world(worker, owner, api)
    pages = [[record(w, 100 + p * 10 + i) for i in range(10)] for p in range(5)]
    rt = CollectorRuntime(worker, FakeAudit(pages), batch_events=7)
    report = rt.backfill(TenantContext(w.org, w.instance), since=datetime.now(timezone.utc) - timedelta(days=180))
    assert report.events_accepted == 50
    with pytest.raises(ValueError):
        CollectorRuntime(worker, FakeAudit([]), batch_events=5000)


def test_manifest_rules():
    with pytest.raises(ValueError):          # every push collector declares a reconcile poll
        Manifest.from_dict({**MANIFEST.__dict__, "source_kind": "push", "schedule": {}, "emits": list(MANIFEST.emits),
                            "purposes": list(MANIFEST.purposes)})
    assert MANIFEST.source("ws-x") == "/collectors/gdrive_audit/1/ws-x"
