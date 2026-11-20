"""WL-SETUP-2 (19 Nov 2026, migration 2407): a document already sent gets its salesperson, and an issued one that names no
client is linked to the client a person picks. The printed copy never changes.

Willow Lane: QT/26-27/0002 (drafted by bhrātā for Adunor before 2393) recorded no salesperson, and QT/26-27/0001 ("Majistique
Infra", typed in) was never linked to the client "Majestique Infra". Synthetic people and figures only."""
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_billing_flow import _invoice_from, _issued_quote
from test_erp_invoice import as_, erp, one, person  # noqa: F401  (erp is a fixture)


def _doc(api, w, who, did):
    return one(api, w, who, "select number,status,total,buyer->>'name' buyer,client_id,salesperson_id from pulse.erp_document where id=%s", (did,))


def test_a_sent_quotation_gets_its_salesperson_and_its_invoice_follows(api, worker, erp):  # noqa: F811
    w = erp
    seller, head = person(worker, w, "Synthetic Seller", "sales"), person(worker, w, "Synthetic Sales Head", "sales_head")
    qid = _issued_quote(api, w, w.finance, {"name": "Synthetic Client One", "stateCode": "27"})
    one(api, w, w.finance, "select pulse.erp_document_mark(%s,'sent',null) s", (qid,))
    before = _doc(api, w, w.finance, qid)
    assert before["status"] == "sent" and before["salesperson_id"] is None
    # The seller cannot see the deal yet, nor name themself on it; a member has no Billing at all.
    assert one(api, w, seller, "select count(*) n from pulse.erp_document where id=%s", (qid,))["n"] == 0
    for who in (seller, w.member):
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="leadership, Finance and the sales head"):
            one(api, w, who, "select pulse.erp_document_salesperson(%s,%s) r", (qid, seller))
    # Only someone with the sales seat is a salesperson.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="sales seat"):
        one(api, w, w.finance, "select pulse.erp_document_salesperson(%s,%s) r", (qid, w.member))

    r = one(api, w, w.finance, "select pulse.erp_document_salesperson(%s,%s) r", (qid, seller))["r"]
    assert (r["changed"], r["salespersonId"], r["documents"]) == (True, str(seller), 1)
    after = _doc(api, w, w.finance, qid)
    assert after == {**before, "salesperson_id": seller}, "only the salesperson changed"
    # Now it is the seller's deal: they see it.
    assert one(api, w, seller, "select count(*) n from pulse.erp_document where id=%s", (qid,))["n"] == 1
    ev = one(api, w, w.finance, "select detail,actor from pulse.erp_event where subject_id=%s and kind='salesperson'", (qid,))
    assert ev == {"detail": {"from": None, "to": str(seller), "documents": 1}, "actor": w.finance}
    # Again: nothing changes, nothing logged.
    assert one(api, w, w.finance, "select pulse.erp_document_salesperson(%s,%s) r", (qid, seller))["r"]["changed"] is False
    assert one(api, w, w.finance, "select count(*) n from pulse.erp_event where subject_id=%s and kind='salesperson'", (qid,))["n"] == 1

    # The invoice made from it is the same deal: the sales head moves both; an unrelated document is untouched.
    inv = _invoice_from(api, w, w.finance, qid=qid)
    other = _issued_quote(api, w, w.finance, {"name": "Synthetic Client Two", "stateCode": "27"})
    assert _doc(api, w, w.finance, inv)["salesperson_id"] == seller
    r = one(api, w, head, "select pulse.erp_document_salesperson(%s,%s) r", (qid, head))["r"]
    assert (r["changed"], r["documents"]) == (True, 2)
    assert [_doc(api, w, w.finance, x)["salesperson_id"] for x in (qid, inv, other)] == [head, head, None]

    # The issued copy is still kept as issued.
    with pytest.raises(Exception, match="cannot be edited"):
        as_(api, w, w.finance, "update pulse.erp_document set total=1 where id=%s", (qid,))


def test_an_issued_quotation_with_a_typed_buyer_is_linked_to_the_client_a_person_picks(api, worker, owner, erp):  # noqa: F811
    w = erp
    seller = person(worker, w, "Synthetic Seller", "sales")
    qid = _issued_quote(api, w, w.finance, {"name": "Nortstar Homes", "stateCode": "27"})   # typed, with a typo
    before = _doc(api, w, w.finance, qid)
    assert before["client_id"] is None
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="leadership, Finance and the sales head"):
        one(api, w, seller, "select pulse.erp_document_client(%s,%s) r", (qid, w.client))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="not in Clients"):
        one(api, w, w.finance, "select pulse.erp_document_client(%s,%s) r", (qid, uuid.uuid4()))
    # A client merged into another is gone.
    gone = uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.client set entity_kind='company' where id=%s", (w.client,))
        owner.execute("insert into pulse.client(id,org_id,display_name,entity_kind) values(%s,%s,'Northstar Homes (old)','company')", (gone, w.org))
        owner.execute("""insert into pulse.record_merge(org_id,entity_type,keep_id,gone_id,moved,previous_status,merged_by)
            values(%s,'client',%s,%s,'[]','active',%s)""", (w.org, w.client, gone, w.founder))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="not in Clients"):
        one(api, w, w.finance, "select pulse.erp_document_client(%s,%s) r", (qid, gone))

    r = one(api, w, w.founder, "select pulse.erp_document_client(%s,%s) r", (qid, w.client))["r"]
    assert (r["changed"], r["clientId"], r["documents"]) == (True, str(w.client), 1)
    assert _doc(api, w, w.finance, qid) == {**before, "client_id": w.client}, "the printed buyer stays as issued"
    # No billing profile is made from the typed buyer; the log says who linked it.
    assert one(api, w, w.finance, "select count(*) n from pulse.erp_party where client_id=%s", (w.client,))["n"] == 0
    ev = one(api, w, w.finance, "select detail,actor from pulse.erp_event where subject_id=%s and kind='client_linked'", (qid,))
    assert ev == {"detail": {"clientId": str(w.client), "documents": 1}, "actor": w.founder}
    # Again: nothing changes. Another client: refused, an issued document keeps the one it names.
    assert one(api, w, w.finance, "select pulse.erp_document_client(%s,%s) r", (qid, w.client))["r"]["changed"] is False
    other = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Synthetic Other Client')", (other, w.org))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="already names a client; an issued document keeps it"):
        one(api, w, w.finance, "select pulse.erp_document_client(%s,%s) r", (qid, other))
