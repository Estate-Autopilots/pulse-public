"""CONTRACTS-3 (2030): the point of contact on each party (filled from the quotation's buyer), links both ways for the
seller who runs an agreement, drafts proposed through the API / MCP that a person uses or drops, and the "send it by
itself" setting that stays off until Kazuk says yes. Synthetic tenants, names and reviewed synthetic phones only."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_billing_flow import _issued_quote
from test_contract_signing import one, rows, template, token
from test_erp_invoice import erp, person  # noqa: F401  (fixture)

BUYER = {"name": "Lotus Interiors (synthetic)", "gstin": "27AABCS5678K1ZS", "stateCode": "27", "address": ["Plot 7, Baner", "Pune"],
         "contactName": "Diya Nair (synthetic)", "email": "diya@example.test", "phone": "+91 90000 12345"}


@pytest.fixture
def world(api, worker, owner, erp):  # noqa: F811
    w = erp
    w.seller = person(worker, w, "Synthetic Seller", "sales")
    w.seller2 = person(worker, w, "Synthetic Seller Two", "sales")
    w.tpl = template(api, w, w.finance)
    w.quote = _issued_quote(api, w, w.finance, BUYER, client=w.client)
    w.task = uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.erp_document set salesperson_id=%s where id=%s", (w.seller, w.quote))
        owner.execute("insert into pulse.task(id,org_id,project_id,title,assignee_person_id) values(%s,%s,%s,'Synthetic site measure',%s)",
                      (w.task, w.org, w.project, w.seller))
    w.cid = one(api, w, w.seller, "select pulse.contract_from_document(%s,null) id", (w.quote,))["id"]
    w.client_key = one(api, w, w.seller, "select party_key k from pulse.contract_party where contract_id=%s and role='client'", (w.cid,))["k"]
    return w


def test_the_proposal_table_forces_row_security_with_a_tenant_policy(worker):
    r = worker.execute("""select c.relrowsecurity r, c.relforcerowsecurity f, exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') t
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname='contract_proposal'""").fetchone()
    assert (r["r"], r["f"], r["t"]) == (True, True, True)


def test_the_clients_point_of_contact_comes_from_the_quotation(api, world):
    w = world
    p = one(api, w, w.seller, "select poc_name, poc_phone, poc_email, signer_name, email from pulse.contract_party where contract_id=%s and party_key=%s", (w.cid, w.client_key))
    assert (p["poc_name"], p["poc_phone"], p["poc_email"]) == ("Diya Nair (synthetic)", "+91 90000 12345", "diya@example.test")
    assert (p["signer_name"], p["email"]) == ("Diya Nair (synthetic)", "diya@example.test")
    # Our own side (a company on Vitals OS) gets none filled in.
    ours = one(api, w, w.seller, "select poc_name from pulse.contract_party where contract_id=%s and role='provider'", (w.cid,))
    assert ours["poc_name"] is None


def test_who_runs_it_changes_the_point_of_contact_and_bad_values_are_refused(api, world):
    w = world
    one(api, w, w.seller, "select pulse.contract_party_contact(%s,%s,%s)", (w.cid, w.client_key, Jsonb({"name": "Rifob Iyer (synthetic)", "phone": "+91 90000 54321", "email": ""})))
    p = one(api, w, w.finance, "select poc_name, poc_phone, poc_email from pulse.contract_party where contract_id=%s and party_key=%s", (w.cid, w.client_key))
    assert (p["poc_name"], p["poc_phone"], p["poc_email"]) == ("Rifob Iyer (synthetic)", "+91 90000 54321", None)
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Check the phone number"):
        one(api, w, w.seller, "select pulse.contract_party_contact(%s,%s,%s)", (w.cid, w.client_key, Jsonb({"phone": "call me"})))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Check the e-mail address"):
        one(api, w, w.seller, "select pulse.contract_party_contact(%s,%s,%s)", (w.cid, w.client_key, Jsonb({"email": "not-an-address"})))
    for who in (w.seller2, w.member):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            one(api, w, who, "select pulse.contract_party_contact(%s,%s,%s)", (w.cid, w.client_key, Jsonb({"name": "Someone else"})))


def test_the_seller_who_runs_it_links_work_and_others_see_no_link(api, world):
    w = world
    # Made from the quotation: the quotation is linked already; the seller sees it now (1583 kept links to managers).
    assert [r["erp_document_id"] for r in rows(api, w, w.seller, "select erp_document_id from pulse.contract_link where contract_id=%s", (w.cid,))] == [w.quote]
    one(api, w, w.seller, "insert into pulse.contract_link(org_id,contract_id,task_id,added_by) values(pulse.current_org(),%s,%s,pulse.current_viewer()) returning id", (w.cid, w.task))
    # The seller also sees which quotation it came from (the money for "who pays whom"); another seller does not.
    assert one(api, w, w.seller, "select source_document_id d from pulse.contract_side where contract_id=%s", (w.cid,))["d"] == w.quote
    assert one(api, w, w.seller2, "select source_document_id d from pulse.contract_side where contract_id=%s", (w.cid,)) is None
    # Both ways: from the task, the agreement is found.
    got = rows(api, w, w.seller, "select c.id from pulse.contract_link l join pulse.contract c on c.id=l.contract_id where l.task_id=%s", (w.task,))
    assert [r["id"] for r in got] == [w.cid]
    assert rows(api, w, w.seller2, "select id from pulse.contract_link where contract_id=%s", (w.cid,)) == []
    assert rows(api, w, w.member, "select id from pulse.contract_link where task_id=%s", (w.task,)) == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.seller2, "insert into pulse.contract_link(org_id,contract_id,task_id,added_by) values(pulse.current_org(),%s,%s,pulse.current_viewer()) returning id", (w.cid, w.task))


def test_a_proposed_draft_changes_nothing_until_a_person_uses_it(api, world):
    w = world
    t, h = token()
    one(api, w, w.seller, "select pulse.contract_send_to_sign(%s,%s,%s,14,null,null) r", (w.cid, w.client_key, h))
    before = one(api, w, w.seller, "select body, version from pulse.contract where id=%s", (w.cid,))
    new_words = before["body"].replace("We start after the first payment.", "We start within 7 days of the first payment.")
    pid = one(api, w, w.seller, "select pulse.contract_propose(%s,null,%s,'Client asked for a clear start date','mcp') id", (w.cid, new_words))["id"]
    still = one(api, w, w.seller, "select body, version from pulse.contract where id=%s", (w.cid,))
    assert (still["body"], still["version"]) == (before["body"], before["version"])
    assert [e["kind"] for e in rows(api, w, w.seller, "select kind from pulse.contract_event where contract_id=%s order by at", (w.cid,))][-1] == "draft_proposed"
    # The same way proposing again replaces the open one; the same words are refused.
    pid2 = one(api, w, w.seller, "select pulse.contract_propose(%s,null,%s,null,'mcp') id", (w.cid, new_words + "\n"))["id"]
    assert one(api, w, w.seller, "select decision from pulse.contract_proposal where id=%s", (pid,))["decision"] == "dropped"
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="same words"):
        one(api, w, w.seller, "select pulse.contract_propose(%s,null,%s,null,'api') id", (w.cid, before["body"]))
    # Someone who does not run it can neither propose nor see proposals.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.seller2, "select pulse.contract_propose(%s,null,%s,null,'api') id", (w.cid, new_words))
    assert rows(api, w, w.seller2, "select id from pulse.contract_proposal where contract_id=%s", (w.cid,)) == []
    # Using it makes the new draft (it was sent: the old one is kept and everyone signs again).
    v = one(api, w, w.seller, "select pulse.contract_proposal_decide(%s,%s,true) v", (w.cid, pid2))["v"]
    assert v == before["version"] + 1
    after = one(api, w, w.seller, "select body, status from pulse.contract where id=%s", (w.cid,))
    assert after["body"] == new_words + "\n" and after["status"] == "proposed"
    kept = one(api, w, w.seller, "select terms->>'body' b from pulse.contract_version where contract_id=%s and version=%s", (w.cid, before["version"]))
    assert kept["b"] == before["body"]
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="already decided"):
        one(api, w, w.seller, "select pulse.contract_proposal_decide(%s,%s,false) v", (w.cid, pid2))


def test_sending_by_itself_stays_off(api, world):
    w = world
    one(api, w, w.finance, "insert into pulse.contract_settings(org_id,after) values(pulse.current_org(),'prepare') returning org_id")
    assert one(api, w, w.finance, "select send_by_itself s from pulse.contract_settings")["s"] is False
    with pytest.raises(psycopg.errors.CheckViolation):
        one(api, w, w.finance, "update pulse.contract_settings set send_by_itself=true returning org_id")
