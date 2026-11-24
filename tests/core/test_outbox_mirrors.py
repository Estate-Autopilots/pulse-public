"""FIX-LIVE (19 Nov 2026, BUG-CENSUS BC-038, BC-116): the legacy delivery rows follow the outbox.

The outbox (notification_delivery) settles a delivery as suppressed or expired without telling the older per-channel
rows (web_push_delivery, hr_mail_outbox), which then read "queued" for good. Migration 2471: each seed settles them.
Synthetic tenants only; providers are never called (claim/dispatch/finish only).
"""
import pytest
from pulse_sdk.db import set_tenant
from test_hr_suite import _staff
from test_notification_outbox import browser, claim, dispatch, finish, holiday, owner_tx
from helpers import build_world


@pytest.fixture
def mirror_world(worker, owner, api):
    w = build_world(worker, owner, api)
    _staff(worker, w)
    return w


def push_rows(owner, w, sid):
    with owner.transaction():
        owner_tx(owner, w)
        return {r["notification_id"]: r["status"] for r in owner.execute(
            "select notification_id,status from pulse.web_push_delivery where subscription_id=%s", (sid,)).fetchall()}


def mail_row(owner, w, nid):
    with owner.transaction():
        owner_tx(owner, w)
        return owner.execute("select status from pulse.hr_mail_outbox where notification_id=%s", (nid,)).fetchone()["status"]


def hr_copy(owner, w, person, key):
    with owner.transaction():
        set_tenant(owner, w.org)
        return owner.execute(
            "select pulse.notification_emit(%s,'approval.digest','person',%s,%s,'1 request waits for your decision',"
            "'/me/approvals','approval',true) n", (person, person, key)).fetchone()["n"]


def test_a_push_the_outbox_suppressed_or_expired_no_longer_reads_queued(worker, owner, api, mirror_world):
    w = mirror_world
    sid = browser(worker, w)
    hid = holiday(api, w)
    job = claim(worker, w)[0]
    nid = job["notification_id"]
    assert push_rows(owner, w, sid)[nid] == "queued"
    # The browser is switched off between claim and dispatch: the outbox suppresses the push and nothing is sent.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.web_push_subscription set disabled_at=clock_timestamp() where id=%s", (sid,))
    assert dispatch(worker, w, job) is None
    with owner.transaction():
        owner_tx(owner, w)
        assert owner.execute("select status from pulse.notification_delivery where id=%s", (job["id"],)).fetchone()["status"] == "suppressed"
    # Before 2471 the legacy row stayed "queued" for good. The next seed settles it, and sends nothing.
    assert claim(worker, w) == []
    assert push_rows(owner, w, sid)[nid] == "suppressed"

    # A second browser, a notice whose time ran out before anything was sent: expired, on both sides.
    sid2 = browser(worker, w, w.lead)
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("update pulse.holiday set name='Synthetic holiday, moved' where id=%s", (hid,))
    with owner.transaction():
        owner_tx(owner, w)
        late = owner.execute("select notification_id from pulse.web_push_delivery where subscription_id=%s and status='queued' limit 1", (sid2,)).fetchone()["notification_id"]
        owner.execute("update pulse.notification set expires_at=clock_timestamp()-interval '1 minute' where id=%s", (late,))
    assert all(j["notification_id"] != late for j in claim(worker, w))
    assert push_rows(owner, w, sid2)[late] == "expired"


def test_hr_mail_rows_follow_the_outbox_and_a_live_one_is_untouched(worker, owner, api, mirror_world):
    w = mirror_world
    muted = hr_copy(owner, w, w.editor, "mirror-muted")
    late = hr_copy(owner, w, w.editor2, "mirror-late")
    live = hr_copy(owner, w, w.lead, "mirror-live")
    jobs = {j["notification_id"]: j for j in claim(worker, w, "email")}
    assert {muted, late, live} <= set(jobs)
    # A provider asked to retry: the delivery and its HR mail row are queued again.
    assert dispatch(worker, w, jobs[muted])
    finish(worker, w, jobs[muted], "retry")
    assert mail_row(owner, w, muted) == "queued"
    with owner.transaction():
        owner_tx(owner, w)
        owner.execute("update pulse.notification_delivery set retry_at=clock_timestamp()+interval '1 hour' where id=%s", (jobs[muted]["id"],))
        # The person mutes that kind before the retry: the seed suppresses the copy.
        owner.execute("update pulse.notification set quiet_reason='muted' where id=%s", (muted,))
        # Another copy's notice runs out before it is sent.
        owner.execute("update pulse.notification set expires_at=clock_timestamp()-interval '1 minute' where id=%s", (late,))
        owner.execute("update pulse.notification_delivery set status='queued',lease_token=null,lease_until=null where id=%s", (jobs[late]["id"],))
    assert claim(worker, w, "email") == []
    assert mail_row(owner, w, muted) == "suppressed"
    assert mail_row(owner, w, late) == "expired"
    # The leased, live copy is not touched, and it still finishes as before.
    assert mail_row(owner, w, live) == "queued"
    assert dispatch(worker, w, jobs[live])
    finish(worker, w, jobs[live], "accepted")
    assert mail_row(owner, w, live) == "sent"


def test_a_copy_that_never_had_a_delivery_is_expired_with_its_notice(worker, owner, api, mirror_world):
    w = mirror_world
    # Muted when made: the seed never gives it a delivery (as EA's 28 Oct approval copies), so only its notice's end
    # can settle it. A company waiting for its mailbox counts the same way.
    never = hr_copy(owner, w, w.editor, "mirror-never")
    waiting = hr_copy(owner, w, w.editor2, "mirror-waiting")
    with owner.transaction():
        owner_tx(owner, w)
        owner.execute("update pulse.notification set quiet_reason='muted' where id=%s", (never,))
        owner.execute("update pulse.hr_mail_outbox set status='waiting_mailbox' where notification_id=%s", (waiting,))
    claim(worker, w, "email")
    with owner.transaction():
        owner_tx(owner, w)
        assert owner.execute("select count(*) n from pulse.notification_delivery where notification_id=%s", (never,)).fetchone()["n"] == 0
    assert mail_row(owner, w, never) == "queued"
    with owner.transaction():
        owner_tx(owner, w)
        owner.execute("update pulse.notification set expires_at=clock_timestamp()-interval '1 minute' where id = any(%s)", ([never, waiting],))
    # Any channel's seed settles them (the web one runs for every company, mailbox or not).
    claim(worker, w, "web")
    assert mail_row(owner, w, never) == "expired"
    assert mail_row(owner, w, waiting) == "expired"
