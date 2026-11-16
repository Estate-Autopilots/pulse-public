"""CONTRACTS-2 (1850): agreements people sign. Made from a quotation with the company's template (blanks filled), sent
with a signing link (only its hash is kept; it expires), opened, commented on and signed through the link without an
account, a new draft after a change request, signed inside Vitals OS by the other side (another company too), the
activity log, the agreement that makes itself after a quotation is accepted, and who may do what (access matrix).
Synthetic tenants and names only."""
import hashlib
import secrets
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_billing_flow import _issued_quote
from test_erp_invoice import erp, person  # noqa: F401  (fixture)

NEW_TABLES = ["contract_event", "contract_settings", "contract_sign_link", "contract_template"]
BUYER = {"name": "Lotus Interiors (synthetic)", "gstin": "27AABCS5678K1ZS", "stateCode": "27", "address": ["Plot 7, Baner", "Pune"],
         "contactName": "Diya Nair (synthetic)", "email": "diya@example.test"}
BODY = """This agreement is between {{our_name}} and {{client_name}} (GSTIN {{client_gstin}}), of {{client_address}}.

1. The work
{{items}}

2. Price and payment
The total is {{total}}.

3. Dates
We start after the first payment."""
PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="


def rows(api, w, who, sql, args=()):
    with api.transaction():
        set_tenant(api, w.org, who)
        return api.execute(sql, args).fetchall()


def one(api, w, who, sql, args=()):
    r = rows(api, w, who, sql, args)
    return r[0] if r else None


def signed_out(api, org, sql, args=(), reach=False):
    """A request through the signing link: no viewer, the address's company (or, with reach, the shared address)."""
    with api.transaction():
        set_tenant(api, org)
        if reach:
            api.execute("select set_config('pulse.contract_sign_reach','1',true)")
        return api.execute(sql, args).fetchone()


def token():
    t = secrets.token_urlsafe(32)
    return t, hashlib.sha256(t.encode()).hexdigest()


def template(api, w, who, body=BODY, client=None, default=True):
    return one(api, w, who, """insert into pulse.contract_template(org_id,name,body,client_id,is_default,created_by)
        values(pulse.current_org(),'Standard agreement',%s,%s,%s,pulse.current_viewer()) returning id""", (body, client, default))["id"]


@pytest.fixture
def world(api, worker, owner, erp):  # noqa: F811
    w = erp
    w.seller = person(worker, w, "Synthetic Seller", "sales")
    w.seller2 = person(worker, w, "Synthetic Seller Two", "sales")
    w.tpl = template(api, w, w.finance)
    w.quote = _issued_quote(api, w, w.finance, BUYER, client=w.client)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.erp_document set salesperson_id=%s where id=%s", (w.seller, w.quote))
    return w


def test_new_tables_force_row_security_with_a_tenant_policy(worker):
    got = worker.execute("""select c.relname,c.relrowsecurity,c.relforcerowsecurity,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname = any(%s) order by 1""", (NEW_TABLES,)).fetchall()
    assert [(r["relname"], r["relrowsecurity"], r["relforcerowsecurity"], r["tenant"]) for r in got] == [(t, True, True, True) for t in NEW_TABLES]


def test_rupees_are_written_the_indian_way(api, world):
    w = world
    r = one(api, w, w.finance, "select pulse.inr_text(48500000) a, pulse.inr_text(150050) b, pulse.inr_text(99) c, pulse.inr_text(100000000000) d, pulse.inr_text(100000) e")
    assert (r["a"], r["b"], r["c"], r["d"], r["e"]) == ("₹4,85,000", "₹1,500.50", "₹0.99", "₹1,00,00,00,000", "₹1,000")


def test_an_agreement_made_from_a_quotation_fills_its_blanks(api, world):
    w = world
    cid = one(api, w, w.finance, "select pulse.contract_from_document(%s,null) id", (w.quote,))["id"]
    c = one(api, w, w.finance, "select status, body, title, rates from pulse.contract where id=%s", (cid,))
    assert c["status"] == "draft"
    assert "Lotus Interiors (synthetic) (GSTIN 27AABCS5678K1ZS), of Plot 7, Baner, Pune." in c["body"]
    assert "• Model-led brand film: ₹1,18,000" in c["body"] and "The total is ₹1,18,000." in c["body"]
    assert c["rates"] == [{"label": "Model-led brand film", "amountMinor": 11800000, "unit": "one_off"}]
    ps = rows(api, w, w.finance, "select name, role, email, signer_name, party_org from pulse.contract_party where contract_id=%s order by position", (cid,))
    assert [(p["role"], p["party_org"] is not None) for p in ps] == [("provider", True), ("client", False)]
    assert (ps[1]["name"], ps[1]["email"], ps[1]["signer_name"]) == ("Lotus Interiors (synthetic)", "diya@example.test", "Diya Nair (synthetic)")
    side = one(api, w, w.finance, "select source_document_id, owner_person_id, client_id from pulse.contract_side where contract_id=%s", (cid,))
    assert (side["source_document_id"], side["owner_person_id"], side["client_id"]) == (w.quote, w.seller, w.client)
    assert one(api, w, w.finance, "select count(*) n from pulse.contract_link where contract_id=%s and erp_document_id=%s", (cid, w.quote))["n"] == 1
    assert [e["kind"] for e in rows(api, w, w.finance, "select kind from pulse.contract_event where contract_id=%s", (cid,))] == ["made"]
    # Asking again for the same document opens the same agreement.
    assert one(api, w, w.finance, "select pulse.contract_from_document(%s,null) id", (w.quote,))["id"] == cid


def test_an_empty_blank_stays_visible_and_nobody_sends_a_gap(api, world):
    w = world
    assert one(api, w, w.finance, "select pulse.contract_fill('For {{ project }} at {{site}}.', %s) b", (Jsonb({"site": "Baner"}),))["b"] == "For {{project}} at Baner."
    cid = one(api, w, w.finance, "select pulse.contract_from_document(%s,null) id", (w.quote,))["id"]
    body = one(api, w, w.finance, "select body from pulse.contract where id=%s", (cid,))["body"]
    one(api, w, w.finance, "select pulse.contract_words_save(%s,null,%s) v", (cid, body + "\n\n4. Site\nThe work is at {{site}}, for {{project}}."))
    client = one(api, w, w.finance, "select party_key k from pulse.contract_party where contract_id=%s and role='client'", (cid,))["k"]
    with pytest.raises(psycopg.errors.InvalidParameterValue, match=r"Some blanks are still empty \(project, site\)"):
        one(api, w, w.finance, "select pulse.contract_send_to_sign(%s,%s,%s,14,null,null) r", (cid, client, token()[1]))
    assert one(api, w, w.finance, "select status from pulse.contract where id=%s", (cid,))["status"] == "draft"


def test_the_link_opens_comments_signs_and_a_new_draft_is_signed_again(api, world):
    w = world
    cid = one(api, w, w.finance, "select pulse.contract_from_document(%s,null) id", (w.quote,))["id"]
    client = one(api, w, w.finance, "select party_key k from pulse.contract_party where contract_id=%s and role='client'", (cid,))["k"]
    t, h = token()
    sent = one(api, w, w.finance, "select pulse.contract_send_to_sign(%s,%s,%s,14,'diya@example.test','Diya Nair (synthetic)') r", (cid, client, h))["r"]
    assert sent["status"] == "proposed" and sent["expiresAt"]
    # Only the hash is kept.
    assert one(api, w, w.finance, "select count(*) n from pulse.contract_sign_link where contract_id=%s and token_hash=%s", (cid, h))["n"] == 1
    seen = signed_out(api, w.org, "select pulse.contract_sign_open(%s,%s,'Synthetic browser') r", (h, "a" * 64))["r"]
    assert seen["canAnswer"] is True and seen["me"]["name"] == "Lotus Interiors (synthetic)" and "Model-led brand film" in seen["body"]
    assert signed_out(api, w.org, "select pulse.contract_sign_open(%s,null,null) r", ("0" * 64,))["r"] is None
    # The client asks for a change on a clause; the business sees it, with its clause, in the log.
    signed_out(api, w.org, "select pulse.contract_sign_act(%s,%s,%s,'Synthetic browser')", (h, Jsonb({"action": "change", "clause": "2. Price and payment", "text": "Three parts, please"}), "b" * 64))
    ask = one(api, w, w.finance, "select kind, clause, body, via, actor_name from pulse.contract_event where contract_id=%s and kind='change_asked'", (cid,))
    assert (ask["clause"], ask["body"], ask["via"], ask["actor_name"]) == ("2. Price and payment", "Three parts, please", "link", "Diya Nair (synthetic)")
    # Signing needs "I agree" and a name.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match='Tick "I agree"'):
        signed_out(api, w.org, "select pulse.contract_sign_act(%s,%s,null,null)", (h, Jsonb({"action": "sign", "name": "Diya Nair", "kind": "typed"})))
    # A change to the words after sending is a new draft: the old one is kept, the client signs the new one, same link.
    assert one(api, w, w.finance, "select pulse.contract_words_save(%s,null,%s) v", (cid, BODY.replace("We start", "We start in three parts; we start")))["v"] == 2
    assert one(api, w, w.finance, "select count(*) n from pulse.contract_version where contract_id=%s and version=1 and terms ? 'body'", (cid,))["n"] == 1
    r = signed_out(api, w.org, "select pulse.contract_sign_act(%s,%s,%s,'Synthetic phone') r", (h, Jsonb({"action": "sign", "name": "Diya Nair (synthetic)", "kind": "drawn", "image": PNG, "agree": True}), "c" * 64))["r"]
    assert r["signed"] is True and r["status"] == "proposed", "our side has not signed yet"
    p = one(api, w, w.finance, "select accepted_version, sign_kind, sign_image is not null img, accepted_note from pulse.contract_party where contract_id=%s and role='client'", (cid,))
    assert (p["accepted_version"], p["sign_kind"], p["img"], p["accepted_note"]) == (2, "drawn", True, "Signed through the link")
    # A second answer is refused; our admin signs inside Vitals OS and it is signed.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="already signed"):
        signed_out(api, w.org, "select pulse.contract_sign_act(%s,%s,null,null)", (h, Jsonb({"action": "sign", "name": "Diya Nair", "agree": True})))
    assert one(api, w, w.finance, "select pulse.contract_sign_here(%s,%s) s", (cid, Jsonb({"name": "Synthetic Finance", "kind": "typed", "agree": True})))["s"] == "active"
    c = one(api, w, w.finance, "select status, signed_at is not null signed from pulse.contract where id=%s", (cid,))
    assert c["status"] == "active" and c["signed"]
    kinds = [e["kind"] for e in rows(api, w, w.finance, "select kind from pulse.contract_event where contract_id=%s order by at, kind", (cid,))]
    assert [k for k in kinds if k in ("made", "sent", "opened", "change_asked", "new_draft", "signed")] == ["made", "sent", "opened", "change_asked", "new_draft", "signed", "signed"]
    audit = signed_out(api, w.org, "select pulse.contract_sign_audit(%s) r", (h,))["r"]
    assert audit["status"] == "active" and {"sent", "signed"} <= {e["kind"] for e in audit["audit"]}
    # A signed agreement is not changed; a new one is made instead.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Everyone signed"):
        one(api, w, w.finance, "select pulse.contract_words_save(%s,null,'x') v", (cid,))
    assert one(api, w, w.finance, """select count(*) n from pulse.contract where home_org=org_id
        and signed_at >= date_trunc('month', now())""")["n"] == 1


def test_a_link_says_no_expires_and_stops(api, world, owner):
    w = world
    cid = one(api, w, w.finance, "select pulse.contract_from_document(%s,null) id", (w.quote,))["id"]
    client = one(api, w, w.finance, "select party_key k from pulse.contract_party where contract_id=%s and role='client'", (cid,))["k"]
    _, h = token()
    one(api, w, w.finance, "select pulse.contract_send_to_sign(%s,%s,%s,7,null,null) r", (cid, client, h))
    assert signed_out(api, w.org, "select pulse.contract_sign_act(%s,%s,null,null) r", (h, Jsonb({"action": "decline", "text": "Too costly"})))["r"]["declined"] is True
    p = one(api, w, w.finance, "select declined_at is not null d, declined_note from pulse.contract_party where contract_id=%s and role='client'", (cid,))
    assert p["d"] and p["declined_note"] == "Too costly"
    # A new link replaces the old one; the old one stops working.
    _, h2 = token()
    one(api, w, w.finance, "select pulse.contract_send_to_sign(%s,%s,%s,7,null,null) r", (cid, client, h2))
    assert signed_out(api, w.org, "select pulse.contract_sign_open(%s,null,null) r", (h,))["r"] is None
    # Nobody moves a link's date by hand; an expired link cannot be answered.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        rows(api, w, w.finance, "update pulse.contract_sign_link set expires_at=now()-interval '1 day' where token_hash=%s", (h2,))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.contract_sign_link set expires_at=now()-interval '1 day' where token_hash=%s", (h2,))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="expired"):
        signed_out(api, w.org, "select pulse.contract_sign_act(%s,%s,null,null)", (h2, Jsonb({"action": "sign", "name": "Diya Nair", "kind": "typed", "agree": True})))


def test_a_link_reaches_only_its_own_company_unless_on_the_shared_address(api, world, worker, owner):
    from helpers import build_world
    w = world
    other = build_world(worker, owner, api)
    cid = one(api, w, w.finance, "select pulse.contract_from_document(%s,null) id", (w.quote,))["id"]
    client = one(api, w, w.finance, "select party_key k from pulse.contract_party where contract_id=%s and role='client'", (cid,))["k"]
    _, h = token()
    one(api, w, w.finance, "select pulse.contract_send_to_sign(%s,%s,%s,14,null,null) r", (cid, client, h))
    assert signed_out(api, other.org, "select pulse.contract_sign_open(%s,null,null) r", (h,))["r"] is None
    assert signed_out(api, other.org, "select pulse.contract_sign_open(%s,null,null) r", (h,), reach=True)["r"]["from"]


def test_who_may_do_what(api, world):
    """Access matrix: Finance (a manager) does everything; a seller makes and sends agreements from their own quotations
    and sees only theirs; a member sees nothing; nobody writes the log or the links directly."""
    w = world
    # A member: no templates, no agreements, cannot make one.
    assert rows(api, w, w.member, "select id from pulse.contract_template") == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.member, "select pulse.contract_from_document(%s,null) id", (w.quote,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        template(api, w, w.member)
    # The seller of the quotation makes it, owns it and sends it; they read templates but do not change them.
    cid = one(api, w, w.seller, "select pulse.contract_from_document(%s,null) id", (w.quote,))["id"]
    assert len(rows(api, w, w.seller, "select id from pulse.contract_template")) == 1
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        template(api, w, w.seller)
    assert one(api, w, w.seller, "select id from pulse.contract where id=%s", (cid,))["id"] == cid
    client = one(api, w, w.seller, "select party_key k from pulse.contract_party where contract_id=%s and role='client'", (cid,))["k"]
    _, h = token()
    assert one(api, w, w.seller, "select pulse.contract_send_to_sign(%s,%s,%s,14,null,null) r", (cid, client, h))["r"]["status"] == "proposed"
    assert len(rows(api, w, w.seller, "select id from pulse.contract_event where contract_id=%s", (cid,))) == 2
    # Another seller, and a member, see none of it.
    for who in (w.seller2, w.member):
        assert rows(api, w, who, "select id from pulse.contract where id=%s", (cid,)) == []
        assert rows(api, w, who, "select id from pulse.contract_event where contract_id=%s", (cid,)) == []
        assert rows(api, w, who, "select token_hash from pulse.contract_sign_link where contract_id=%s", (cid,)) == []
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            one(api, w, who, "select pulse.contract_words_save(%s,'Mine now',null) v", (cid,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.seller2, "select pulse.contract_from_document(%s,null) id", (w.quote,))
    # Nobody writes the log or the links except through the functions.
    for sql in ("insert into pulse.contract_event(org_id,contract_id,kind) values(pulse.current_org(),%s,'signed')",
                "insert into pulse.contract_sign_link(token_hash,org_id,contract_id,party_key,expires_at) values(repeat('a',64),pulse.current_org(),%s,gen_random_uuid(),now())"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            rows(api, w, w.finance, sql, (cid,))
    # The internal makers are not open to the API role; the platform count is for platform admins only.
    for fn in ("contract_make_from_doc(uuid,uuid,text,uuid)", "contract_log(uuid,text,uuid,text,text,text,text,text,text)", "contract_doc_values(uuid)"):
        assert one(api, w, w.finance, "select has_function_privilege('pulse_api', %s, 'execute') ok", (f"pulse.{fn}",))["ok"] is False
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.finance, "select pulse.platform_contracts_signed(12) m")


def test_the_agreement_makes_itself_after_a_quotation_is_accepted(api, world, owner):
    w = world
    def accept(did):
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute("update pulse.erp_document set status='accepted' where id=%s", (did,))
    accept(w.quote)
    assert rows(api, w, w.finance, "select contract_id from pulse.contract_side where source_document_id=%s", (w.quote,)) == []
    one(api, w, w.finance, "insert into pulse.contract_settings(org_id,after) values(pulse.current_org(),'prepare') returning org_id")
    q2 = _issued_quote(api, w, w.finance, BUYER, client=w.client, day="2026-10-03")
    accept(q2)
    made = one(api, w, w.finance, "select s.contract_id, c.status from pulse.contract_side s join pulse.contract c on c.id=s.contract_id where s.source_document_id=%s", (q2,))
    assert made and made["status"] == "draft"
    ev = one(api, w, w.finance, "select kind, via, actor_name from pulse.contract_event where contract_id=%s", (made["contract_id"],))
    assert (ev["kind"], ev["via"], ev["actor_name"]) == ("prepared", "auto", "Vitals OS")
    # Without a template nothing is made, and the quotation's own change still goes through.
    one(api, w, w.finance, "update pulse.contract_template set archived_at=now() returning id")
    q3 = _issued_quote(api, w, w.finance, BUYER, client=w.client, day="2026-10-04")
    accept(q3)
    assert rows(api, w, w.finance, "select contract_id from pulse.contract_side where source_document_id=%s", (q3,)) == []
    assert one(api, w, w.finance, "select status from pulse.erp_document where id=%s", (q3,))["status"] == "accepted"


def test_another_company_signs_inside_vitals_os_and_both_logs_show_it(api, worker, owner, world):
    from helpers import build_world
    w = world
    b = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, b.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (b.org, b.manager))
    cid = one(api, w, w.finance, "select pulse.contract_save(null,%s) id", (Jsonb({"kind": "services", "title": "Synthetic platform services",
        "parties": [{"kind": "company", "role": "provider", "orgId": str(w.org)}, {"kind": "company", "role": "client", "orgId": str(b.org)}]}),))["id"]
    one(api, w, w.finance, "select pulse.contract_words_save(%s,null,%s) v", (cid, "1. Services\nWe run your work operating system.\n\n2. Fees\nMonthly, in advance."))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="sign there"):
        theirs_key = one(api, w, w.finance, "select party_key k from pulse.contract_party where contract_id=%s and party_org=%s", (cid, b.org))["k"]
        one(api, w, w.finance, "select pulse.contract_send_to_sign(%s,%s,%s,14,null,null) r", (cid, theirs_key, "d" * 64))
    one(api, w, w.finance, "select pulse.contract_send_to_sign(%s,null,null,null,null,null) r", (cid,))
    key = one(api, w, w.finance, "select contract_key k from pulse.contract where id=%s", (cid,))["k"]
    copy = one(api, b, b.manager, "select id, body from pulse.contract where contract_key=%s", (key,))
    assert "We run your work operating system." in copy["body"]
    assert one(api, b, b.manager, "select pulse.contract_sign_here(%s,%s) s", (copy["id"], Jsonb({"name": "Synthetic B Admin", "kind": "typed", "agree": True})))["s"] == "proposed"
    ours = one(api, w, w.finance, "select sign_kind, accepted_by_name from pulse.contract_party where contract_id=%s and party_org=%s", (cid, b.org))
    assert (ours["sign_kind"], ours["accepted_by_name"]) == ("typed", "Synthetic B Admin")
    assert one(api, w, w.finance, "select count(*) n from pulse.contract_event where contract_id=%s and kind='signed'", (cid,))["n"] == 1
    assert one(api, b, b.manager, "select count(*) n from pulse.contract_event where contract_id=%s and kind='signed'", (copy["id"],))["n"] == 1
    assert one(api, w, w.finance, "select pulse.contract_sign_here(%s,%s) s", (cid, Jsonb({"name": "Synthetic Finance", "kind": "typed", "agree": True})))["s"] == "active"
    assert one(api, b, b.manager, "select status from pulse.contract where id=%s", (copy["id"],))["status"] == "active"
