"""BILLING (owner, 4 Nov 2026; Kazuk's flow of 3 Nov): quotation first (1470). A blank quotation needs no client project;
the client and contact come from Clients and Contacts or are typed in, and are booked there when the money is real; old
documents are mapped onto the one model (client, contact, project location) without touching what was issued. Then
(1471) a quotation is revised under its own number with its approved copies kept, a cancelled one is re-issued under the
next, and the first money in on its invoice starts one project that the project heads assign. Synthetic tenants, people,
clients, GSTINs and figures only."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import SELLER, _seed_erp_world, as_, erp, one  # noqa: F401  (fixture)


def _issued_quote(api, w, who, buyer, project=None, client=None, day="2026-10-02"):
    """An issued quotation with one line, as the composer would leave it (figures already worked out)."""
    with api.transaction():
        set_tenant(api, w.org, who)
        did = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,project_id,client_id,created_by)
            values(%s,'quotation',%s,%s,%s,'27','intra',10000000,900000,900000,0,11800000,%s,%s,%s) returning id""",
                          (w.org, day, Jsonb(SELLER), Jsonb(buyer), project, client, who)).fetchone()["id"]
        api.execute("""insert into pulse.erp_line(org_id,document_id,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total)
            values(%s,%s,0,'Model-led brand film',1,10000000,18,10000000,900000,900000,0,11800000)""", (w.org, did))
        api.execute("select pulse.erp_document_issue(%s)", (did,))
    return did


def test_old_documents_map_onto_client_contact_and_location_once(api, worker, owner, erp):  # noqa: F811
    w = erp
    ids = _seed_erp_world(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.project set location='Moshi, Pune' where id=%s", (ids["riverside"],))
    # A quotation made the old way: for the client project only (no client, no contact, no location on it), then issued.
    did = _issued_quote(api, w, w.finance, {"name": "Northstar Homes LLP", "stateCode": "27", "address": ["Office 4, Baner"], "contactName": "Asha Kireteso"}, project=ids["riverside"])
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.erp_party set contact_person_id=null where client_id=%s", (ids["north"],))
        first = owner.execute("select pulse.billing_model_map() r").fetchone()["r"]
        again = owner.execute("select pulse.billing_model_map() r").fetchone()["r"]
        doc = owner.execute("select client_id,site_location,status,number,buyer from pulse.erp_document where id=%s", (did,)).fetchone()
        party = owner.execute("select legal_name,address,source from pulse.erp_party where client_id=%s", (ids["north"],)).fetchone()
    assert first["client"] == 1 and first["location"] == 1 and first["party"] == 1, first
    assert again == {"client": 0, "location": 0, "contact": 0, "party": 0}, "run twice, the mapping changes nothing"
    assert doc["client_id"] == ids["north"] and doc["site_location"] == "Moshi, Pune"
    assert doc["status"] == "issued" and doc["buyer"]["name"] == "Northstar Homes LLP", "what was issued stays as issued"
    assert party["legal_name"] == "Northstar Homes LLP" and party["address"] == ["Office 4, Baner"] and party["source"]["type"] == "migration_1470"
    # Once filled in, an issued document's client and project location never change.
    with pytest.raises(Exception, match="cannot be edited"):
        as_(api, w, w.finance, "update pulse.erp_document set site_location='Elsewhere' where id=%s", (did,))
    with pytest.raises(Exception, match="cannot be edited"):
        as_(api, w, w.finance, "update pulse.erp_document set client_id=%s where id=%s", (ids["lake"], did))


def test_booking_a_typed_client_makes_the_client_the_contact_and_the_billing_profile_once(api, worker, erp):  # noqa: F811
    w = erp
    buyer = {"name": "Synthetic Skyline Developers", "gstin": "27ABCDE1234F1Z5", "stateCode": "27", "address": ["Office 9, Synthetic Plaza", "Pune"],
             "contactName": "Rumam Synthetic", "email": "rumam@skyline.example", "phone": "+91 90000 11111"}
    did = _issued_quote(api, w, w.finance, buyer)
    as_(api, w, w.finance, "update pulse.erp_document set site_location='Wakad, Pune' where id=%s", (did,))
    # Only billing writers book; a member is refused.
    with pytest.raises(Exception, match="leadership and the Finance role"):
        as_(api, w, w.member, "select pulse.erp_book_client(%s)", (did,))
    r = one(api, w, w.finance, "select pulse.erp_book_client(%s) r", (did,))["r"]
    assert r["newClient"] and r["newContact"]
    again = one(api, w, w.finance, "select pulse.erp_book_client(%s) r", (did,))["r"]
    assert again == {**r, "newClient": False, "newContact": False}, "booking twice makes nothing new"
    c = one(api, w, w.finance, "select display_name,city,primary_contact_id,source from pulse.client where id=%s", (r["clientId"],))
    assert c["display_name"] == buyer["name"] and c["city"] == "Wakad, Pune" and c["primary_contact_id"] == uuid.UUID(r["contactId"]) and c["source"] == "billing"
    p = one(api, w, w.finance, "select legal_name,gstin,address,contact_person_id from pulse.erp_party where client_id=%s", (r["clientId"],))
    assert p["gstin"] == buyer["gstin"] and p["address"] == buyer["address"] and p["contact_person_id"] == uuid.UUID(r["contactId"])
    cp = one(api, w, w.finance, """select p.display_name,p.side,cp.email,cc.is_primary from pulse.person p join pulse.contact_profile cp on cp.person_id=p.id
        join pulse.client_contact cc on cc.person_id=p.id where p.id=%s""", (r["contactId"],))
    assert cp == {"display_name": "Rumam Synthetic", "side": "client", "email": "rumam@skyline.example", "is_primary": True}
    d = one(api, w, w.finance, "select client_id,contact_person_id,buyer from pulse.erp_document where id=%s", (did,))
    assert d["client_id"] == uuid.UUID(r["clientId"]) and d["buyer"] == buyer, "the issued quotation gets its client; what it printed stays"
    # A second quotation for the same GSTIN (another spelling) and the contact's phone finds the same client and contact.
    other = _issued_quote(api, w, w.finance, {**buyer, "name": "Skyline Developers (Synthetic)", "contactName": "R. Synthetic", "email": None, "phone": "9000011111"})
    r2 = one(api, w, w.finance, "select pulse.erp_book_client(%s) r", (other,))["r"]
    assert (r2["clientId"], r2["contactId"], r2["newClient"], r2["newContact"]) == (r["clientId"], r["contactId"], False, False)


@pytest.mark.skipif(os.environ.get("PULSE_BILLING_FLOW_SKIP_RUNNER") == "1", reason="runner skipped on request")
def test_billing_flow_through_the_api_and_the_browser(worker, owner, api, erp, tmp_path):  # noqa: F811
    """The quotation-first flow through the real API (services/api/test/billing-flow-runner.mjs), sending it by e-mail
    included (BILLING-EMAIL, into the mail sink only); with PULSE_AUTH_BROWSER=1
    also through the built web app at 390 and 1440 px (PULSE_BILLING_SCREENSHOTS=<dir> writes the screens)."""
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = erp
    ids = _seed_erp_world(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        # Northstar's Riverside launch is done (its new quotation is new work); Lakeview's Towers project is still live.
        worker.execute("update pulse.project set location='Moshi, Pune',status='done' where id=%s", (ids["riverside"],))
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"head@{w.domain}", w.manager))
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"pgs@{w.domain}", w.lead))

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "TEST_ORG": str(w.org),
           "TEST_EMAILS": json.dumps({k: f"{k}@{w.domain}" for k in ("founder", "finance", "member", "head", "pgs")}),
           "TEST_IDS": json.dumps({k: str(v) for k, v in {**ids, "finance": w.finance, "founder": w.founder, "head": w.manager, "pgs": w.lead}.items()}),
           "PULSE_BILLING_REPORT": str(tmp_path / "billing.json")}
    p = subprocess.run(["node", "test/billing-flow-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-8000:]
    report = json.loads((tmp_path / "billing.json").read_text())
    assert report["apiChecks"] >= 20
    # BILLING-EMAIL: the approved quotation went by e-mail to two synthetic addresses (the sink), the PDF attached and the
    # acceptance link in it; it was marked sent with who, when and to whom; a member was refused (the runner checks each).
    assert report["emailed"] == 2
    if os.environ.get("PULSE_AUTH_BROWSER") == "1":
        assert report["browserChecks"] >= 10


def test_a_revision_keeps_its_number_and_its_copies_and_only_revise_reopens_an_issued_quotation(api, erp):  # noqa: F811
    w = erp
    did = _issued_quote(api, w, w.finance, {"name": "Northstar Homes LLP", "stateCode": "27"})
    number = one(api, w, w.finance, "select number from pulse.erp_document where id=%s", (did,))["number"]
    # Nothing but Revise takes an issued quotation back to a draft.
    with pytest.raises(Exception, match="cannot go back to draft"):
        as_(api, w, w.finance, "update pulse.erp_document set status='draft' where id=%s", (did,))
    with pytest.raises(Exception, match="leadership and the Finance role"):
        as_(api, w, w.member, "select pulse.erp_quote_revise(%s,'x')", (did,))
    assert one(api, w, w.finance, "select pulse.erp_quote_revise(%s,'Synthetic: lower price') r", (did,))["r"] == {"revision": 1, "number": number}
    d = one(api, w, w.finance, "select status,number,revision from pulse.erp_document where id=%s", (did,))
    assert d == {"status": "draft", "number": number, "revision": 1}
    v = one(api, w, w.finance, "select revision,snapshot->>'status' s,jsonb_array_length(lines) n,reason from pulse.erp_document_revision where document_id=%s", (did,))
    assert v == {"revision": 0, "s": "issued", "n": 1, "reason": "Synthetic: lower price"}
    with pytest.raises(Exception, match="keeps its number"):
        as_(api, w, w.finance, "delete from pulse.erp_document where id=%s", (did,))
    with pytest.raises(Exception, match="keeps its number"):
        as_(api, w, w.finance, "update pulse.erp_document set number='QT/XX/9999' where id=%s", (did,))
    # Approved again: the same number, and the series did not move.
    nxt = one(api, w, w.finance, "select next_no from pulse.erp_series where doc_type='quotation'")["next_no"]
    assert one(api, w, w.finance, "select pulse.erp_document_issue(%s) r", (did,))["r"]["number"] == number
    assert one(api, w, w.finance, "select next_no from pulse.erp_series where doc_type='quotation'")["next_no"] == nxt
    # A version is read by billing readers only.
    assert as_(api, w, w.member, "select 1 from pulse.erp_document_revision where document_id=%s", (did,)) == []


def test_the_first_money_in_starts_one_project_and_tells_the_heads(api, worker, erp):  # noqa: F811
    w = erp
    qid = _issued_quote(api, w, w.finance, {"name": "Synthetic Riverbend Homes", "stateCode": "27", "contactName": "Meera Synthetic", "phone": "+91 90000 55555"})
    as_(api, w, w.finance, "update pulse.erp_document set site_location='Baner, Pune' where id=%s", (qid,))
    with api.transaction():   # the invoice from the quotation, as "Make tax invoice" leaves it, then issued
        set_tenant(api, w.org, w.finance)
        inv = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,source_id,site_location,created_by)
            select org_id,'invoice',issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,id,site_location,%s from pulse.erp_document where id=%s returning id""", (w.finance, qid)).fetchone()["id"]
        api.execute("""insert into pulse.erp_line(org_id,document_id,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total)
            select org_id,%s,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total from pulse.erp_line where document_id=%s""", (inv, qid))
        api.execute("select pulse.erp_document_issue(%s)", (inv,))
    assert as_(api, w, w.finance, "select 1 from pulse.project_quote where document_id=%s", (inv,)) == [], "issuing the invoice starts nothing"
    as_(api, w, w.finance, "select pulse.erp_payment_add(%s,%s)", (inv, Jsonb({"amount": 5000000, "receivedOn": "2026-10-03"})))
    projects = as_(api, w, w.finance, "select project_id from pulse.project_quote where document_id in (%s,%s)", (inv, qid))
    assert len({r["project_id"] for r in projects}) == 1, "the advance starts the project, linked to the quotation and the invoice"
    pid = projects[0]["project_id"]
    as_(api, w, w.finance, "select pulse.erp_payment_add(%s,%s)", (inv, Jsonb({"amount": 6800000, "receivedOn": "2026-10-04"})))
    assert len({r["project_id"] for r in as_(api, w, w.finance, "select project_id from pulse.project_quote where document_id in (%s,%s)", (inv, qid))}) == 1, "paid in full: no second project"
    with worker.transaction():
        set_tenant(worker, w.org)
        p = worker.execute("select location,client_id,lead_person_id,status from pulse.project where id=%s", (pid,)).fetchone()
        heads = worker.execute("select person_id from pulse.notification where subject_id=%s and event_type='project.added'", (pid,)).fetchall()
        members = worker.execute("select person_id from pulse.project_member where project_id=%s and left_at is null", (pid,)).fetchall()
        client = worker.execute("select display_name from pulse.client where id=%s", (p["client_id"],)).fetchone()
    assert p["location"] == "Baner, Pune" and p["lead_person_id"] is None and p["status"] == "active"
    assert client["display_name"] == "Synthetic Riverbend Homes", "the paid invoice books the client"
    assert [r["person_id"] for r in heads] == [w.manager] and [r["person_id"] for r in members] == [w.manager], "the head of PGS is told and can open it"
    # The head assigns it; a growth strategist cannot; the category must be one of the company's.
    with pytest.raises(Exception, match="project heads and leadership"):
        as_(api, w, w.lead, "select pulse.project_assign(%s,%s,'normal')", (pid, w.lead))
    with pytest.raises(Exception, match="client category"):
        as_(api, w, w.manager, "select pulse.project_assign(%s,%s,'vip')", (pid, w.lead))
    r = one(api, w, w.manager, "select pulse.project_assign(%s,%s,'sell_out') r", (pid, w.lead))["r"]
    assert r["tasks"] == 1
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select lead_person_id,client_category from pulse.project where id=%s", (pid,)).fetchone() == {"lead_person_id": w.lead, "client_category": "sell_out"}
        assert worker.execute("select owner_id from pulse.work_project where project_id=%s", (pid,)).fetchone()["owner_id"] == w.lead
    # The plan panel is not asked again: no delivery template here, so there is no plan, and the category lives on the project.
    assert as_(api, w, w.manager, "select 1 from pulse.project_plan where project_id=%s", (pid,)) == []


def _invoice_from(api, w, who, qid=None, buyer=None):
    """An issued tax invoice: made from a quotation (its lines carried over) or blank (one line), as the composer leaves it."""
    with api.transaction():
        set_tenant(api, w.org, who)
        if qid:
            inv = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,source_id,site_location,client_id,created_by)
                select org_id,'invoice',issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,id,site_location,client_id,%s from pulse.erp_document where id=%s returning id""",
                              (who, qid)).fetchone()["id"]
            api.execute("""insert into pulse.erp_line(org_id,document_id,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total)
                select org_id,%s,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total from pulse.erp_line where document_id=%s""", (inv, qid))
        else:
            inv = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,created_by)
                values(%s,'invoice','2026-10-02',%s,%s,'27','intra',10000000,900000,900000,0,11800000,%s) returning id""", (w.org, Jsonb(SELLER), Jsonb(buyer), who)).fetchone()["id"]
            api.execute("""insert into pulse.erp_line(org_id,document_id,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total)
                values(%s,%s,0,'Meta ads management, October',1,10000000,18,10000000,900000,900000,0,11800000)""", (w.org, inv))
        api.execute("select pulse.erp_document_issue(%s)", (inv,))
    return inv


def _projects_of(api, w, who, *docs):
    return {r["project_id"] for r in as_(api, w, who, "select project_id from pulse.project_quote where document_id = any(%s)", (list(docs),))}


def test_a_paid_blank_invoice_or_more_work_for_a_live_client_starts_no_project_by_itself(api, worker, erp):  # noqa: F811
    """BILLING (review, 4 Nov 2026): a retainer or one-off fee (a blank invoice), or a new quotation for a client whose project
    is live, is paid without a new project or a "New client to assign"; the invoice says why and "Start the project" still works."""
    w = erp
    ids = _seed_erp_world(worker, w)
    blank = _invoice_from(api, w, w.finance, buyer={"name": "Synthetic Retainer Homes", "stateCode": "27", "phone": "+91 90000 77777"})
    as_(api, w, w.finance, "select pulse.erp_payment_add(%s,%s)", (blank, Jsonb({"amount": 11800000, "receivedOn": "2026-10-03"})))
    assert _projects_of(api, w, w.finance, blank) == set(), "a paid blank invoice starts no project"
    ev = one(api, w, w.finance, "select detail from pulse.erp_event where subject_id=%s and kind='project_offered'", (blank,))
    assert ev["detail"] == {"reason": "blank"}
    # More work for Lakeview, whose Towers project is live: the quotation's invoice is paid, nothing new starts.
    qid = _issued_quote(api, w, w.finance, {"name": "Lakeview Developers Pvt Ltd", "stateCode": "27"}, client=ids["lake"])
    inv = _invoice_from(api, w, w.finance, qid=qid)
    as_(api, w, w.finance, "select pulse.erp_payment_add(%s,%s)", (inv, Jsonb({"amount": 11800000, "receivedOn": "2026-10-03"})))
    assert _projects_of(api, w, w.finance, inv, qid) == set(), "the client's live project is not doubled"
    ev = one(api, w, w.finance, "select detail from pulse.erp_event where subject_id=%s and kind='project_offered'", (inv,))
    assert ev["detail"]["reason"] == "live" and ev["detail"]["projectId"] == str(ids["towers"])
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) n from pulse.notification where event_type='project.added'").fetchone()["n"] == 0, "no head is told"
    # Starting it by hand (it is new work after all) makes the project.
    r = one(api, w, w.finance, "select pulse.erp_project_start(%s) r", (blank,))["r"]
    assert r["created"] and _projects_of(api, w, w.finance, blank) == {uuid.UUID(r["projectId"])}


TEMPLATE = {"name": "Synthetic delivery", "packages": [{"key": "starter", "label": "Starter"}, {"key": "growth", "label": "Growth"}],
            "categories": [{"key": "sell_out", "label": "Sell-Out", "units": 1}, {"key": "normal", "label": "Normal", "units": 0.4}],
            "bandwidth": {"role": "pgs"}, "headRoles": ["head_pgs"],
            "steps": [{"id": "1.1", "title": "Kick-off call", "stage": 1, "start": 0, "end": 2, "owner": "pgs", "packages": {"starter": "yes", "growth": "yes"}},
                      {"id": "2.1", "title": "Brand film shoot", "stage": 2, "start": 3, "end": 10, "owner": "editor", "packages": {"growth": "yes"}, "match": ["brand film"]},
                      {"id": "3.1", "title": "Launch review", "stage": 3, "start": 11, "end": 14, "owner": "pgs", "after": ["2.1"], "packages": {"growth": "yes"}}]}


def test_a_paid_invoice_lays_out_the_stages_and_due_days_and_the_head_assigns_it_once(api, worker, owner, erp):  # noqa: F811
    """With a delivery template the paid invoice's project gets its plan at once: the sold package's steps as tasks with due
    days from the kick-off, the sold film taking its step; the head's category and owner are kept on that plan."""
    w = erp
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.delivery_template(org_id,key,name,definition) values(%s,'synthetic','Synthetic delivery',%s)", (w.org, Jsonb(TEMPLATE)))
    qid = _issued_quote(api, w, w.finance, {"name": "Synthetic Growth Realty", "stateCode": "27", "contactName": "Isha Synthetic", "phone": "+91 90000 66666"})
    with api.transaction():   # the package sold is named on the quotation
        set_tenant(api, w.org, w.finance)
        api.execute("select pulse.erp_quote_revise(%s,'Synthetic: name the package')", (qid,))
        api.execute("update pulse.erp_line set description='Growth package: model-led brand film' where document_id=%s", (qid,))
        api.execute("select pulse.erp_document_issue(%s)", (qid,))
    inv = _invoice_from(api, w, w.finance, qid=qid)
    as_(api, w, w.finance, "select pulse.erp_payment_add(%s,%s)", (inv, Jsonb({"amount": 5000000, "receivedOn": "2026-10-03"})))
    (pid,) = _projects_of(api, w, w.finance, inv)
    with owner.transaction():
        set_tenant(owner, w.org)
        plan = owner.execute("select template_key,package,category,kickoff from pulse.project_plan where project_id=%s", (pid,)).fetchone()
        tasks = {r["template_step"]: r for r in owner.execute("""select template_step,source,title,phase_key,work_on,(due_at at time zone 'Asia/Kolkata')::date due,assignee_person_id
            from pulse.task where project_id=%s and deleted_at is null""", (pid,)).fetchall()}
        links = owner.execute("select count(*) n from pulse.task_link l join pulse.task t on t.id=l.task_id where t.project_id=%s", (pid,)).fetchone()["n"]
    k = plan["kickoff"]
    assert plan["template_key"] == "synthetic" and plan["package"] == "growth" and plan["category"] is None
    assert set(tasks) == {"1.1", "2.1", "3.1"}, "the growth package's steps, stage by stage"
    assert tasks["2.1"]["source"] == "quote" and tasks["2.1"]["title"].startswith("Growth package"), "the sold film takes its step, no second task"
    assert [(tasks[s]["phase_key"], (tasks[s]["due"] - k).days, (tasks[s]["work_on"] - k).days) for s in ("1.1", "2.1", "3.1")] == [("s1", 2, 0), ("s2", 10, 3), ("s3", 14, 11)]
    assert links == 1, "the launch review waits for the film"
    one(api, w, w.manager, "select pulse.project_assign(%s,%s,'sell_out') r", (pid, w.lead))
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select category from pulse.project_plan where project_id=%s", (pid,)).fetchone()["category"] == "sell_out"
        owned = {r["template_step"]: r["assignee_person_id"] for r in owner.execute("select template_step,assignee_person_id from pulse.task where project_id=%s", (pid,)).fetchall()}
    assert owned["1.1"] == w.lead and owned["3.1"] == w.lead and owned["2.1"] == w.lead, "the owner takes the sold work and the owner's steps"


def test_a_name_alone_never_books_an_existing_client(api, worker, erp):  # noqa: F811
    """Two buyers called the same are two clients unless the e-mail or phone agrees (and never against another GSTIN)."""
    w = erp
    ids = _seed_erp_world(worker, w)
    same_name = _issued_quote(api, w, w.finance, {"name": "Northstar Homes", "stateCode": "27"})
    r = one(api, w, w.finance, "select pulse.erp_book_client(%s) r", (same_name,))["r"]
    assert r["newClient"] and r["clientId"] != str(ids["north"]), "the name alone makes a new client"
    with_phone = _issued_quote(api, w, w.finance, {"name": "northstar homes", "stateCode": "27", "phone": "90000 00001"})
    r = one(api, w, w.finance, "select pulse.erp_book_client(%s) r", (with_phone,))["r"]
    assert (r["clientId"], r["newClient"], r["contactId"]) == (str(ids["north"]), False, str(ids["asha"])), "the same name and its contact's phone"
    ev = one(api, w, w.finance, "select detail from pulse.erp_event where subject_id=%s and kind='booked'", (with_phone,))["detail"]
    assert (ev["clientRule"], ev["contactRule"]) == ("name+phone", "phone")
    short = _issued_quote(api, w, w.finance, {"name": "Synthetic Short Phone", "stateCode": "27", "contactName": "Asha K", "phone": "00001"})
    r = one(api, w, w.finance, "select pulse.erp_book_client(%s) r", (short,))["r"]
    assert r["newContact"] and r["contactId"] != str(ids["asha"]), "a few digits never match a contact"


def test_no_session_reopens_an_issued_document_by_itself(api, erp):  # noqa: F811
    """Only Revise and Undo (definer code) mark a quotation they reopen; a setting a session sets does nothing, and an
    issued tax invoice has no such way at all."""
    w = erp
    inv = _invoice_from(api, w, w.finance, buyer={"name": "Synthetic Guard Homes", "stateCode": "27"})
    qid = _issued_quote(api, w, w.finance, {"name": "Synthetic Guard Homes", "stateCode": "27"})
    for did in (inv, qid):
        with pytest.raises(Exception, match="cannot be edited|cannot go back to draft"):
            with api.transaction():
                set_tenant(api, w.org, w.finance)
                api.execute("select set_config('pulse.erp_revise',%s,true)", (str(did),))
                api.execute("update pulse.erp_document set total=1, status='draft' where id=%s", (did,))
    with pytest.raises(Exception, match="permission denied"):
        as_(api, w, w.finance, "insert into pulse_priv.erp_revise_mark(org_id,txid,document_id) values(%s,txid_current(),%s)", (w.org, inv))
