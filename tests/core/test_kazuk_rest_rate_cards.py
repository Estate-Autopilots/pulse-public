"""KAZUK-REST (1710): rate cards for Kazuk's Quotation Builder v2. A service's card prices base × X × talent × period plus
add-ons; Billing readers read cards and only leadership and admins write them; a line built from a card is priced by the
database from the card; a price away from the card is approved by leadership or the person it was sent to; companies never
see each other's cards. Synthetic tenants, people, services and figures only."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import (  # noqa: F401  (erp is a fixture)
    as_,
    build_world,
    draft,
    erp,
    issue,
    one,
    person,
    setup_company,
)

TALENTS = [{"key": "junior", "label": "Junior", "factor": 0.8}, {"key": "senior", "label": "Senior", "factor": 1.5}]
PERIODS = [{"key": "month", "label": "Per month", "months": 1, "factor": 1}, {"key": "quarter", "label": "Per quarter", "months": 3, "factor": 0.95}]
ADDONS = [{"key": "shoot", "label": "Synthetic shoot day", "price": 1500000, "per": "once"}, {"key": "ads", "label": "Ad management", "price": 500000, "per": "month"}]


def service_and_card(api, w, who, name="Synthetic social media"):
    item = one(api, w, who, "insert into pulse.erp_item(org_id,kind,name,sac,unit,price,gst_rate,status) values(%s,'service',%s,'998361','month',4000000,18,'active') returning id",
               (w.org, name))["id"]
    card = one(api, w, who, """insert into pulse.erp_rate_card(org_id,item_id,name,base,x_label,x_min,x_max,talents,periods,add_ons,created_by)
        values(%s,%s,%s,4000000,'Reels per week',1,5,%s,%s,%s,%s) returning id""", (w.org, item, name, Jsonb(TALENTS), Jsonb(PERIODS), Jsonb(ADDONS), who))["id"]
    return item, card


def sel(card, part="base", x=2, talent="senior", period="quarter"):
    return {"cardId": str(card), "part": part, "x": x, "talent": talent, "period": period}


def card_quote(api, w, who, card, rate, part="base"):
    """A quotation whose one line was built from the rate card at `rate` (figures that add up, as the composer saves
    them); the database names the card's service on the line and works out its rate-card price."""
    q = draft(api, w, who, "quotation", taxable=rate, client=getattr(w, "client", None))
    got = one(api, w, who, "update pulse.erp_line set rate_card=%s where document_id=%s and position=0 returning item_id,catalogue_rate", (Jsonb(sel(card, part)), q))
    return q, got


def test_rate_card_prices_and_only_leadership_edits(api, erp):  # noqa: F811
    w = erp
    item, card = service_and_card(api, w, w.founder)
    # 40,000 × 2 × 1.5 × 3 × 0.95 = 3,42,000 (paise below); add-ons per month of the period or once.
    assert one(api, w, w.finance, "select pulse.erp_rate_card_price(%s,%s) p", (card, Jsonb(sel(card))))["p"] == 34200000
    assert one(api, w, w.finance, "select pulse.erp_rate_card_price(%s,%s) p", (card, Jsonb(sel(card, "addon:ads"))))["p"] == 1500000
    assert one(api, w, w.finance, "select pulse.erp_rate_card_price(%s,%s) p", (card, Jsonb(sel(card, "addon:shoot"))))["p"] == 1500000
    assert one(api, w, w.finance, "select pulse.erp_rate_card_price(%s,%s) p", (card, Jsonb(sel(card, x=1.333, talent="junior"))))["p"] == 12156960
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.finance, "select pulse.erp_rate_card_price(%s,%s)", (card, Jsonb(sel(card, x=9))))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.finance, "select pulse.erp_rate_card_price(%s,%s)", (card, Jsonb(sel(card, talent="lead"))))
    # Finance reads but does not write a card (its prices are approved prices); a member sees none and prices none.
    assert one(api, w, w.finance, "select count(*)::int n from pulse.erp_rate_card")["n"] == 1
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.finance, "insert into pulse.erp_rate_card(org_id,item_id,name,base,talents,periods) values(%s,%s,'x',1,%s,%s)", (w.org, item, Jsonb(TALENTS), Jsonb(PERIODS)))
    assert as_(api, w, w.finance, "update pulse.erp_rate_card set base=1 where id=%s returning id", (card,)) == []
    assert one(api, w, w.member, "select count(*)::int n from pulse.erp_rate_card")["n"] == 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.member, "select pulse.erp_rate_card_price(%s,%s)", (card, Jsonb(sel(card))))
    # Leadership changes it: versioned; nobody deletes it (archive instead).
    assert one(api, w, w.founder, "update pulse.erp_rate_card set base=4200000 where id=%s returning version", (card,))["version"] == 2
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.founder, "delete from pulse.erp_rate_card where id=%s", (card,))


def test_a_rate_card_line_is_priced_by_the_database_and_a_different_price_is_approved(api, owner, erp):  # noqa: F811
    w = erp
    item, card = service_and_card(api, w, w.founder)
    # With no approvals (EA: the salesperson decides the price), a price below the card is theirs to send.
    q0, got = card_quote(api, w, w.finance, card, 30000000)
    assert got["catalogue_rate"] == 34200000
    assert issue(api, w, w.finance, q0)
    # A company that keeps approvals (Willow Lane):
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.erp_settings set quote_approval=true")
    q, got = card_quote(api, w, w.finance, card, 34200000)
    assert (got["item_id"], got["catalogue_rate"]) == (item, 34200000)
    # At the card's price, Finance (sent it for approval to themselves by leadership) approves it.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.erp_document set approval_to=%s where id=%s", (w.finance, q))
    assert issue(api, w, w.finance, q)
    # Below the card's price: Finance cannot approve it; leadership can.
    q2, got = card_quote(api, w, w.finance, card, 30000000)
    assert got["catalogue_rate"] == 34200000
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        issue(api, w, w.finance, q2)
    assert issue(api, w, w.founder, q2)
    # Sent to Finance at the card's price is not enough below it: only the approver named or leadership.
    # Sent to Finance for approval, Finance approves the different price.
    q3, _ = card_quote(api, w, w.finance, card, 30000000)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.erp_document set approval_to=%s where id=%s", (w.finance, q3))
    assert issue(api, w, w.finance, q3)
    # An add-on line is priced from the card too; a choice that is not on the card is refused when the line is saved.
    assert card_quote(api, w, w.finance, card, 1500000, "addon:ads")[1]["catalogue_rate"] == 1500000
    q4 = draft(api, w, w.finance, "quotation", taxable=100000, client=w.client)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.finance, "update pulse.erp_line set rate_card=%s where document_id=%s returning id", (Jsonb(sel(card, x=7)), q4))


def flow(api, w, body):
    """Leadership sets the company's sales flow (1671): a preset or changed steps."""
    return one(api, w, w.founder, "select pulse.erp_flow_save(%s) r", (Jsonb(body),))["r"]


def test_the_rate_card_price_gate_follows_the_sales_flow(api, erp):  # noqa: F811
    w = erp
    _, card = service_and_card(api, w, w.founder)
    # The EA preset: no approval and no price gate; the salesperson's price below the card goes out as set.
    flow(api, w, {"preset": "ea"})
    q, got = card_quote(api, w, w.finance, card, 30000000)
    assert got["catalogue_rate"] == 34200000
    assert issue(api, w, w.finance, q)
    # The Willow Lane preset keeps approvals: the same price waits.
    flow(api, w, {"preset": "wl"})
    q2, _ = card_quote(api, w, w.finance, card, 30000000)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        issue(api, w, w.finance, q2)
    # Finance among the approve step's approvers issues at the card's price, but a price away from the card still waits
    # for the price step's approvers (the rate-card gate itself, not the approval gate).
    flow(api, w, {"steps": {"approve": {"roles": ["leadership", "admin", "finance"]}}})
    q3, _ = card_quote(api, w, w.finance, card, 34200000)
    assert issue(api, w, w.finance, q3)
    q4, _ = card_quote(api, w, w.finance, card, 30000000)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="rate card"):
        issue(api, w, w.finance, q4)
    # With the price step switched off in the company's flow, the rate card only suggests the price.
    flow(api, w, {"steps": {"price": {"on": False}}})
    assert issue(api, w, w.finance, q4)
    # Switched back on: leadership approves a different price.
    flow(api, w, {"steps": {"price": {"on": True}}})
    q5, _ = card_quote(api, w, w.finance, card, 30000000)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="rate card"):
        issue(api, w, w.finance, q5)
    assert issue(api, w, w.founder, q5)


def test_rate_cards_are_kept_apart_between_companies(worker, owner, api, erp):  # noqa: F811
    a = erp
    _, card_a = service_and_card(api, a, a.founder, "Synthetic card of company A")
    b = build_world(worker, owner, api)
    b.founder = person(worker, b, "Synthetic Founder B", "leadership")
    setup_company(api, b, b.founder)
    service_and_card(api, b, b.founder, "Synthetic card of company B")
    assert [r["name"] for r in as_(api, b, b.founder, "select name from pulse.erp_rate_card")] == ["Synthetic card of company B"]
    with pytest.raises(psycopg.errors.NoDataFound):
        one(api, b, b.founder, "select pulse.erp_rate_card_price(%s,%s)", (card_a, Jsonb(sel(card_a))))
    with pytest.raises(psycopg.errors.NoDataFound):
        card_quote(api, b, b.founder, card_a, 34200000)
    assert as_(api, b, b.founder, "update pulse.erp_rate_card set base=1 where id=%s returning id", (card_a,)) == []
    assert one(api, a, a.founder, "select base from pulse.erp_rate_card where id=%s", (card_a,))["base"] == 4000000


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_rate_cards_in_the_browser(api, worker, erp):  # noqa: F811
    """services/api/test/kazuk-rest-rate-cards-browser-runner.mjs: Billing → Rate cards, and a quotation built from a rate
    card in the composer, at 1440 and 390 (PULSE_KR_SCREENSHOTS=<dir> keeps the shots)."""
    w = erp
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"founder@{w.domain}", w.founder))
    _, card = service_and_card(api, w, w.founder)
    docs = [draft(api, w, w.founder, "quotation", taxable=100000, client=w.client) for _ in range(2)]
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_IDS": json.dumps({"org": str(w.org), "docs": [str(d) for d in docs], "card": str(card)}),
           "TEST_EMAILS": json.dumps({"founder": f"founder@{w.domain}"})}
    p = subprocess.run(["node", "test/kazuk-rest-rate-cards-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    # What the composer saved is priced by the card: Senior, per quarter, X 1 (+ the once-off shoot day).
    rows = as_(api, w, w.founder, "select rate,catalogue_rate,rate_card->>'part' part from pulse.erp_line where document_id=%s and rate_card is not null order by position", (docs[0],))
    assert [(r["part"], r["rate"], r["catalogue_rate"]) for r in rows] == [("base", 17100000, 17100000), ("addon:shoot", 1500000, 1500000)]
    assert uuid.UUID(str(card))
