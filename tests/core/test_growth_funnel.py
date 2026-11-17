"""GROWTH-LOOP slice 2 (1895): the "What is Vitals?" funnel. What a client-side person or a guest did with the card is
written under the company that brought them (viewed, clicked, dismissed; once a day per visitor), never for staff; a
company opened from the card is counted once, only for its founder within the hour and only for another company.
The API role writes nothing directly. Synthetic tenants, people and links only."""
import hashlib
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant

from helpers import build_world
from test_erp_accept_shared import _company, _quote_link, _reach


def as_(api, org, who, sql, args=()):
    with api.transaction():
        set_tenant(api, org, who)
        return api.execute(sql, args).fetchall()


def one(api, org, who, sql, args=()):
    return as_(api, org, who, sql, args)[0]["r"]


def events(owner, org):
    with owner.transaction():
        set_tenant(owner, org)
        return owner.execute("select event, source, visitor, new_org from pulse.growth_event where org_id=%s order by created_at", (org,)).fetchall()


def handle(owner, w, h):
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.org set handle=%s where id=%s", (h, w.org))


def admin(worker, org, person):
    with worker.transaction():
        set_tenant(worker, org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (org, person))


def client_person(worker, w, side="client"):
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Buyer Contact',%s)", (pid, w.org, side))
    return pid


def test_a_client_seat_is_counted_and_staff_never(worker, owner, api):
    w = build_world(worker, owner, api)
    tag = uuid.uuid4().hex[:8]
    handle(owner, w, f"seller{tag}")
    buyer = client_person(worker, w)
    r = one(api, w.org, buyer, "select pulse.growth_seen('viewed','chat') r")
    assert r == {"recorded": True, "via": f"seller{tag}"}
    # Once a day per visitor; then pressed; staff are never counted (but still learn the handle for the button).
    assert one(api, w.org, buyer, "select pulse.growth_seen('viewed','chat') r")["recorded"] is False
    assert one(api, w.org, buyer, "select pulse.growth_seen('clicked','chat') r")["recorded"] is True
    assert one(api, w.org, w.editor, "select pulse.growth_seen('viewed','chat') r") == {"recorded": False, "via": f"seller{tag}"}
    vendor = client_person(worker, w, "vendor")
    assert one(api, w.org, vendor, "select pulse.growth_seen('dismissed','portal') r")["recorded"] is True
    got = events(owner, w.org)
    assert [(e["event"], e["source"]) for e in got] == [("viewed", "chat"), ("clicked", "chat"), ("dismissed", "portal")]
    # The visitor is a hash, never the person's id.
    assert all(len(e["visitor"]) == 64 and str(buyer) not in e["visitor"] for e in got)
    for bad in (("opened", "chat"), ("viewed", "email"), (None, "chat")):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            as_(api, w.org, buyer, "select pulse.growth_seen(%s,%s)", bad)
    # The API role neither reads nor writes the table, nor calls the internal recorder.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w.org, buyer, "select count(*) from pulse.growth_event")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w.org, buyer, "select pulse.growth_record(%s,'viewed','chat',%s,null)", (w.org, "a" * 64))


def test_a_guest_on_a_quotation_link(worker, owner, api):
    w = _company(worker, owner, api)
    tag = uuid.uuid4().hex[:8]
    handle(owner, w, f"quoter{tag}")
    _q, _raw, h = _quote_link(api, owner, w, f"Growth{tag}", pdf=False)
    other = build_world(worker, owner, api)
    visitor = hashlib.sha256(b"growth:synthetic-browser-0001").hexdigest()
    with api.transaction():
        set_tenant(api, other.org)
        _reach(api)
        r = api.execute("select pulse.growth_seen_link(%s,'viewed',%s) r", (h, visitor)).fetchone()["r"]
    assert r == {"recorded": True, "via": f"quoter{tag}"}
    # An unknown link answers nothing; a bad event is refused.
    with api.transaction():
        set_tenant(api, other.org)
        _reach(api)
        assert api.execute("select pulse.growth_seen_link(%s,'viewed',%s) r", ("0" * 64, visitor)).fetchone()["r"] is None
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        with api.transaction():
            set_tenant(api, other.org)
            api.execute("select pulse.growth_seen_link(%s,'signed',%s)", (h, visitor))
    assert [(e["event"], e["source"], e["visitor"]) for e in events(owner, w.org)] == [("viewed", "quote", visitor)]
    assert events(owner, other.org) == []


def test_a_company_opened_from_the_card_is_counted_once(worker, owner, api):
    seller = build_world(worker, owner, api)
    tag = uuid.uuid4().hex[:8]
    handle(owner, seller, f"brings{tag}")
    newco = build_world(worker, owner, api)
    admin(worker, newco.org, newco.manager)
    r = one(api, newco.org, newco.manager, "select pulse.growth_started(%s,'chat') r", (f"@Brings{tag}",))
    assert r == {"recorded": True}
    assert one(api, newco.org, newco.manager, "select pulse.growth_started(%s,'chat') r", (f"brings{tag}",)) == {"recorded": False}
    got = events(owner, seller.org)
    assert [(e["event"], e["new_org"]) for e in got] == [("org_created", newco.org)]
    # Not the founder (not an admin), its own handle, an unknown handle, or a company older than an hour: nothing.
    other = build_world(worker, owner, api)
    admin(worker, other.org, other.manager)
    assert one(api, other.org, other.editor, "select pulse.growth_started(%s,'quote') r", (f"brings{tag}",)) == {"recorded": False}
    handle(owner, other, f"self{tag}")
    assert one(api, other.org, other.manager, "select pulse.growth_started(%s,'quote') r", (f"self{tag}",)) == {"recorded": False}
    assert one(api, other.org, other.manager, "select pulse.growth_started('nobody-here-xyz','quote') r") == {"recorded": False}
    with owner.transaction():
        set_tenant(owner, other.org)
        owner.execute("update pulse.org set created_at = now() - interval '2 hours' where id=%s", (other.org,))
    assert one(api, other.org, other.manager, "select pulse.growth_started(%s,'quote') r", (f"brings{tag}",)) == {"recorded": False}
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, newco.org, newco.manager, "select pulse.growth_started(%s,'email')", (f"brings{tag}",))
