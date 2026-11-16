"""EST-1259 (0760): one event per quotation transition, in its own transaction; install-wide gapless numbering; the
delivery lifecycle. Envelopes match services/api/openapi/service-events.yaml 1.0.0. Synthetic data only."""
import hashlib
import threading
import time
from pathlib import Path

import psycopg
import pytest
import yaml
from conftest import _connect
from helpers import build_world
from jsonschema import Draft202012Validator
from pulse_sdk.db import set_tenant
from test_erp_invoice import draft, erp, issue, one, person, setup_company  # noqa: F401
from test_quote_followups import own

SPEC = yaml.safe_load((Path(__file__).resolve().parents[2] / "services/api/openapi/service-events.yaml").read_text())
ENVELOPE = Draft202012Validator({"$ref": "#/components/schemas/ServiceEvent", "components": SPEC["components"]},
                                format_checker=Draft202012Validator.FORMAT_CHECKER)


def events(owner, w):
    return [r["e"] for r in own(owner, w, """select pulse.install_event_envelope(e)||jsonb_build_object('status',e.status,'attempts',e.attempts)
        e from pulse_priv.install_event e where org_id=%s order by created_at""", (w.org,))]


def publish(worker):
    with worker.transaction():
        return worker.execute("select pulse.install_event_publish() n").fetchone()["n"]


def mark(api, w, q, action):
    return one(api, w, w.finance, "select pulse.erp_document_mark(%s,%s) r", (q, action))["r"]


def issued(api, w, **kw):
    d = draft(api, w, w.finance, "quotation", **kw)
    issue(api, w, w.finance, d)
    return d


def made_from(api, w, source, doc_type):
    """A conversion draft, as the API's "Make proforma / invoice" stores it."""
    d = draft(api, w, w.finance, doc_type)
    one(api, w, w.finance, "update pulse.erp_document set source_id=%s where id=%s", (source, d))
    return d


def link(api, w, q, seed):
    token = hashlib.sha256(seed).hexdigest()
    one(api, w, w.finance, "select pulse.erp_accept_link_create(%s,%s,30)", (q, token))
    return token


def decide(conn, w, token):
    return conn.execute("select pulse.erp_accept_decide(%s,'accepted','Synthetic Signer',null,%s,'test')", (token, "a" * 64))


def blocked(fn):
    """Runs fn on a thread and checks it waits on a row lock held by the caller's open transaction."""
    out = {}

    def run():
        try:
            out["r"] = fn()
        except psycopg.Error as exc:
            out["e"] = exc
    t = threading.Thread(target=run, daemon=True)
    t.start()
    time.sleep(0.5)
    assert t.is_alive(), "the second transition should wait for the first"
    return t, out


def test_each_quotation_transition_writes_one_event_and_nothing_else_does(api, owner, worker, erp):  # noqa: F811
    w = erp
    q = issued(api, w, client=w.client)
    proforma = made_from(api, w, q, "proforma")                                       # a conversion draft: nothing
    one(api, w, w.finance, "select pulse.erp_document_file_put(%s,%s)", (q, b"%PDF synthetic"))
    token = link(api, w, q, b"synthetic-event-link")
    one(api, w, None, "select pulse.erp_accept_open(%s)", (token,))                    # the client opens it, reads the PDF
    one(api, w, None, "select pulse.erp_accept_file(%s)", (token,))
    assert events(owner, w) == []
    assert mark(api, w, q, "sent") == "sent"
    assert mark(api, w, q, "sent") == "sent"                                          # Mark sent again: no second event
    with api.transaction():                                                            # a rolled-back acceptance
        set_tenant(api, w.org, w.finance)
        api.execute("select pulse.erp_document_mark(%s,'accepted')", (q,))
        raise psycopg.Rollback()
    with api.transaction():
        set_tenant(api, w.org, None)
        decide(api, w, token)
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="already answered"), api.transaction():
        set_tenant(api, w.org, None)
        decide(api, w, token)                                                          # the answer replayed
    issue(api, w, w.finance, proforma)
    invoice = made_from(api, w, proforma, "invoice")
    issue(api, w, w.finance, invoice)                                                  # proforma → invoice: still one
    q2 = issued(api, w)
    assert mark(api, w, q2, "accepted") == "accepted"                                   # staff record the answer
    direct = made_from(api, w, q2, "invoice")
    issue(api, w, w.finance, direct)
    assert publish(worker) == 5 and publish(worker) == 0
    got = events(owner, w)
    for e in got:
        ENVELOPE.validate({k: v for k, v in e.items() if k not in ("status", "attempts")})
    assert [(e["type"], e["subject"]["id"], e["sequence"]) for e in got] == [
        ("quote.sent", str(q), 1), ("quote.accepted", str(q), 2), ("quote.converted", str(q), 3),
        ("quote.accepted", str(q2), 4), ("quote.converted", str(q2), 5)]
    assert [e["data"] for e in got] == [
        {"status": "sent", "clientId": str(w.client), "leadId": None},
        {"status": "accepted", "clientId": str(w.client), "leadId": None, "acceptedVia": "customer_link"},
        {"status": "converted", "clientId": str(w.client), "leadId": None, "resultDocumentId": str(proforma), "resultType": "proforma"},
        {"status": "accepted", "clientId": None, "leadId": None, "acceptedVia": "staff"},
        {"status": "converted", "clientId": None, "leadId": None, "resultDocumentId": str(direct), "resultType": "invoice"}]
    assert {(e["version"], e["status"], e["attempts"]) for e in got} == {(1, "pending", 0)}


def test_racing_transitions_still_write_one_event_and_numbers_follow_commits(api, owner, worker, erp):  # noqa: F811
    w = erp
    q, q2 = issued(api, w), issued(api, w)
    token = link(api, w, q, b"synthetic-race-link")
    proforma, invoice = made_from(api, w, q, "proforma"), made_from(api, w, q, "invoice")
    with _connect("api") as a:
        with a.transaction():                                                          # two Mark sent at once
            set_tenant(a, w.org, w.finance)
            a.execute("select pulse.erp_document_mark(%s,'sent')", (q,))
            t, _ = blocked(lambda: mark(api, w, q, "sent"))
        t.join(10)
        with a.transaction():                                                          # the link and the staff answer
            set_tenant(a, w.org, None)
            decide(a, w, token)
            t, out = blocked(lambda: mark(api, w, q, "accepted"))
        t.join(10)
        assert isinstance(out["e"], psycopg.errors.InvalidParameterValue) and "accepts an issued" in str(out["e"])
        with a.transaction():                                                          # proforma and invoice issued at once
            set_tenant(a, w.org, w.finance)
            a.execute("select pulse.erp_document_issue(%s)", (proforma,))
            t, _ = blocked(lambda: issue(api, w, w.finance, invoice))
        t.join(10)
        assert [e["type"] for e in events(owner, w)] == ["quote.sent", "quote.accepted", "quote.converted"]
        assert events(owner, w)[2]["data"]["resultDocumentId"] == str(proforma)
        assert publish(worker) == 3
        with a.transaction():                                                          # captured first, committed last
            set_tenant(a, w.org, w.finance)
            a.execute("select pulse.erp_document_mark(%s,'sent')", (q2,))
            later = issued(api, w)
            mark(api, w, later, "sent")
            assert publish(worker) == 1
        with worker.transaction():                                                     # a rolled-back publish keeps no numbers
            assert worker.execute("select pulse.install_event_publish() n").fetchone()["n"] == 1
            raise psycopg.Rollback()
        assert publish(worker) == 1
    got = {e["subject"]["id"]: e["sequence"] for e in events(owner, w) if e["type"] == "quote.sent"}
    assert (got[str(q)], got[str(later)], got[str(q2)]) == (1, 4, 5)


def test_another_company_emits_nothing_and_delivery_keeps_its_lifecycle(api, owner, worker, erp):  # noqa: F811
    w, other = erp, build_world(worker, owner, api)
    other.finance = person(worker, other, "Synthetic Finance", "finance")
    setup_company(api, other, person(worker, other, "Synthetic Founder", "leadership"))
    theirs = issued(api, other)
    mark(api, other, theirs, "sent")
    assert events(owner, other) == [] and publish(worker) == 0                          # not this install's company
    for d in (issued(api, w), issued(api, w)):
        mark(api, w, d, "sent")
    assert publish(worker) == 2
    due = lambda: worker.execute("select pulse.install_event_due(10) r").fetchone()["r"]
    assert due() == []  # no configuration never reserves attempts or sends
    own(owner, other, "insert into pulse_priv.webhook_endpoint(org_id,url,events,key_id,signing_secret) values(%s,'https://other.example/hooks',array['quote.sent'],'other',repeat('x',32))", (other.org,))
    assert due() == []  # another org cannot select the receiver
    ep = own(owner, w, "insert into pulse_priv.webhook_endpoint(org_id,url,events,key_id,signing_secret) values(%s,'https://receiver.example/hooks?private=never-log',array['quote.sent'],'k1',repeat('x',32)) returning id", (w.org,))[0]["id"]
    def dispatch(job):
        with worker.transaction():
            return worker.execute("select pulse.install_event_dispatch(%s,%s) r", (job["id"], job["lease"])).fetchone()["r"]
    def finish(job, code):
        with worker.transaction():
            return worker.execute("select pulse.install_event_attempt(%s,%s,%s,10,%s) r", (job["id"], job["lease"], code, None if code == 204 else "http")).fetchone()["r"]
    with worker.transaction():
        jobs = due()
        with _connect("worker") as concurrent:
            assert concurrent.execute("select pulse.install_event_due(10) r").fetchone()["r"] == []
    first, second = jobs
    assert due() == [] and str(theirs) not in str(jobs)
    raw = dispatch(first)["body"]
    assert finish(second, 204) == "delivered"
    for n, code in enumerate((500, 429, None, 503), start=1):
        assert dispatch(first)["body"] == raw  # immutable bytes and id across restart/retry
        delay = own(owner, w, "select extract(epoch from next_at-last_attempt_at) seconds from pulse_priv.install_event where id=%s", (first["id"],))[0]["seconds"]
        assert delay == [60, 300, 1800, 7200][n-1]
        if n == 3:  # process dies after sending; the duplicate receipt must keep its original event id
            own(owner, w, "update pulse_priv.install_event set lease_until=now()-interval '1 second' where id=%s", (first["id"],))
        else:
            assert finish(first, code) == "pending" and due() == []
        own(owner, w, "update pulse_priv.install_event set next_at=now() where id=%s", (first["id"],))
        stale, first = first, due()[0]
        assert finish(stale, 204) is None  # an old sender cannot acknowledge a new lease
    own(owner, w, "update pulse_priv.webhook_endpoint set disabled_at=now() where id=%s", (ep,))
    assert dispatch(first) is None and due() == []
    own(owner, w, "update pulse_priv.webhook_endpoint set disabled_at=null where id=%s", (ep,))
    own(owner, w, "update pulse_priv.install_event set lease_until=now()-interval '1 second' where id=%s", (first["id"],))
    assert due() == []  # fifth claim crashed: it still exhausts the bounded attempt count
    rows = own(owner, w, "select id,status,attempts,last_status,next_at from pulse_priv.install_event where org_id=%s", (w.org,))
    state = {str(r["id"]): (r["status"], r["attempts"], r["next_at"] is None) for r in rows}
    assert state == {first["id"]: ("dead_letter", 5, True), second["id"]: ("delivered", 1, True)}
    logs = own(owner, w, "select host,error_class from pulse_priv.webhook_delivery where org_id=%s", (w.org,))
    assert len(logs) == 6 and all(r["host"] == "receiver.example" for r in logs)
    assert sum(r["error_class"] == "interrupted" for r in logs) == 2
    privileges = own(owner, w, """select has_table_privilege('pulse_api','pulse_priv.webhook_endpoint','select') api_secret,
        has_table_privilege('pulse_worker','pulse_priv.webhook_endpoint','select') worker_secret,
        has_function_privilege('pulse_api','pulse.install_event_due(int)','execute') api_due,
        has_function_privilege('pulse_worker','pulse.install_event_attempt(uuid,int,int)','execute') bypass""")[0]
    assert not any(privileges.values())
