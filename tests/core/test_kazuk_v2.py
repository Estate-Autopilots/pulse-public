"""KAZUK-V2 (1930–1932): Kazuk's sales flow, version 2. G12 the negotiation numbers (V1 against the latest price, the
discount, versions, days to yes and to paid, services cut, lost by reason) for a salesperson's own deals and, for the
Sales Head and leadership, everyone's; R47 (a salesperson never reads another's My sales). G13 the one home: incentives,
the client group at Paid (never the pod chat), projects sold (read only), Neeti numbers. G14 the Sales Agent: draft only
(it cannot send), typed reminders with drafts (no reply, overdue, renewal), discount advice that never blocks, read-only
answers and change orders. Synthetic companies, people, clients and figures only."""
import datetime
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
    BUYER,
    SELLER,
    as_,
    erp,
    issue,
    one,
    person,
)
from test_kazuk_flow import from_quote, sales  # noqa: F401  (sales is a fixture)


def quote(api, w, who, lines, day="2026-04-02", client=None):
    """A quotation drafted by `who` with the given (description, taxable in paise) lines, intra-state 18% GST."""
    with api.transaction():
        set_tenant(api, w.org, who)
        did = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,client_id,created_by)
            values(%s,'quotation',%s,%s,%s,'27','intra',0,0,0,0,0,%s,%s) returning id""", (w.org, day, Jsonb(SELLER), Jsonb({**BUYER, "name": "Test Realty Pvt Ltd"} if client else BUYER), client, who)).fetchone()["id"]
    set_lines(api, w, who, did, lines)
    return did


def set_lines(api, w, who, did, lines):
    """Replace a draft's lines and keep its totals adding up."""
    with api.transaction():
        set_tenant(api, w.org, who)
        api.execute("delete from pulse.erp_line where document_id=%s", (did,))
        for pos, (desc, taxable) in enumerate(lines):
            tax = taxable * 18 // 100
            api.execute("""insert into pulse.erp_line(org_id,document_id,position,description,sac,qty,rate,gst_rate,taxable,cgst,sgst,igst,total)
                values(%s,%s,%s,%s,'998361',1,%s,18,%s,%s,%s,0,%s)""", (w.org, did, pos, desc, taxable, taxable, tax // 2, tax // 2, taxable + tax))
        taxable = sum(t for _, t in lines)
        tax = sum(t * 18 // 100 for _, t in lines)
        api.execute("update pulse.erp_document set taxable=%s,cgst=%s,sgst=%s,total=%s where id=%s", (taxable, tax // 2, tax // 2, taxable + tax, did))


def send(api, w, who, did):
    issue(api, w, who, did)
    one(api, w, who, "select pulse.erp_document_mark(%s,'sent',null)", (did,))


@pytest.fixture
def deals(api, sales):  # noqa: F811
    """T10–T19 and T13 as data: S1's deal goes V1 → V2 (price: Meta Ads lowered) → V3 (scope: Brand Film removed) →
    accepted → invoiced → paid; S1 loses a second deal to a competitor; S2 has one quotation out."""
    w = sales
    meta, film = ("Synthetic Meta Ads Management", 2500000), ("Synthetic Brand Film", 5000000)
    w.q1 = quote(api, w, w.s1, [meta, film])
    send(api, w, w.s1, w.q1)
    one(api, w, w.s1, "select pulse.erp_quote_new_version(%s,'price','Client asked 10%% off')", (w.q1,))
    set_lines(api, w, w.s1, w.q1, [(meta[0], 2250000), film])
    send(api, w, w.s1, w.q1)
    one(api, w, w.s1, "select pulse.erp_quote_new_version(%s,'scope','No film this year')", (w.q1,))
    set_lines(api, w, w.s1, w.q1, [(meta[0], 2250000)])
    send(api, w, w.s1, w.q1)
    one(api, w, w.s1, "select pulse.erp_document_mark(%s,'accepted',null)", (w.q1,))
    w.inv = from_quote(api, w, w.s1, w.q1, taxable=2250000)
    issue(api, w, w.s1, w.inv)
    one(api, w, w.s1, "select pulse.erp_payment_add(%s,%s)", (w.inv, Jsonb({"amount": 2655000, "receivedOn": "2026-04-05", "method": "upi", "reference": "TESTUTR001"})))
    w.q2 = quote(api, w, w.s1, [film])
    send(api, w, w.s1, w.q2)
    one(api, w, w.s1, "select pulse.erp_quote_lost(%s,'competitor','Went with another agency')", (w.q2,))
    w.q3 = quote(api, w, w.s2, [meta])
    send(api, w, w.s2, w.q3)
    return w


def test_a_salesperson_sees_how_their_own_deals_were_negotiated(api, deals):
    w = deals
    d = one(api, w, w.s1, "select pulse.sales_deals(null,null,null,false) d")["d"]
    assert d["person"]["self"] is True and d["everyone"] is False and d["people"] is None
    s = d["summary"]
    assert (s["deals"], s["won"], s["lost"], s["open"], s["revised"]) == (2, 1, 1, 0, 1)
    # V1 ₹75,000 → V3 ₹22,500: the discount is worked out on the screen from these two (net of GST).
    assert (s["v1Won"], s["finalWon"]) == (7500000, 2250000)
    one_deal = next(x for x in d["deals"] if x["id"] == str(w.q1))
    assert (one_deal["versions"], one_deal["v1"], one_deal["final"], one_deal["status"]) == (3, 7500000, 2250000, "paid")
    inv = one(api, w, w.s1, "select issue_date from pulse.erp_document where id=%s", (w.inv,))["issue_date"]
    assert one_deal["daysToPaid"] == (datetime.date(2026, 4, 5) - inv).days
    assert one_deal["paidOn"] == "2026-04-05" and one_deal["yesOn"] is not None and one_deal["daysToYes"] is not None
    # Brand Film was cut, Meta Ads lowered by ₹2,500.
    cuts = {c["name"]: c for c in d["cuts"]}
    assert cuts["Synthetic Brand Film"]["removed"] == 1 and cuts["Synthetic Brand Film"]["amount"] == 5000000
    assert cuts["Synthetic Meta Ads Management"]["lowered"] == 1 and cuts["Synthetic Meta Ads Management"]["amount"] == 250000
    assert d["lostBy"] == [{"reason": "competitor", "count": 1, "value": 5000000}]
    assert sorted((r["reason"], r["count"]) for r in d["versionWhy"]) == [("price", 1), ("scope", 1)]
    # Nothing of S2's: their quotation is not among S1's.
    assert str(w.q3) not in {x["id"] for x in d["deals"]}


def test_only_the_sales_head_leadership_and_finance_see_everyones_deals(api, deals):
    w = deals
    # A salesperson asking for everyone's gets their own; asking for another's is refused.
    mine = one(api, w, w.s1, "select pulse.sales_deals(null,null,null,true) d")["d"]
    assert mine["everyone"] is False and mine["person"]["id"] == str(w.s1) and mine["canSeeTeam"] is False
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="another salesperson"):
        one(api, w, w.s1, "select pulse.sales_deals(%s,null,null,false) d", (w.s2,))
    for who in (w.head, w.founder, w.finance):
        d = one(api, w, who, "select pulse.sales_deals(null,null,null,true) d")["d"]
        assert d["everyone"] is True and d["summary"]["deals"] == 3, who
        people = {p["name"]: p for p in d["people"]}
        assert (people["Synthetic Seller One"]["won"], people["Synthetic Seller One"]["lost"], people["Synthetic Seller Two"]["deals"]) == (1, 1, 1)
        assert {x["salesperson"] for x in d["deals"]} == {"Synthetic Seller One", "Synthetic Seller Two"}
        # One person's, picked.
        assert one(api, w, who, "select pulse.sales_deals(%s,null,null,false) d", (w.s2,))["d"]["summary"]["deals"] == 1
    # A member with no Billing sees only their own (none).
    assert one(api, w, w.member, "select pulse.sales_deals(null,null,null,true) d")["d"]["summary"]["deals"] == 0


def test_a_salesperson_never_reads_another_salespersons_my_sales(api, deals):
    """R47: 1670 gave the sales roles Billing; My sales' three reads now ask for the team, not for Billing."""
    w = deals
    for sql in ("select pulse.sales_numbers(%s,null,null) r", "select pulse.sales_desk(%s) r", "select pulse.sales_pipeline(%s) r"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            one(api, w, w.s1, sql, (w.s2,))
        assert one(api, w, w.head, sql, (w.s2,))["r"]["person"]["id"] == str(w.s2)
        assert one(api, w, w.s1, sql, (None,))["r"]["person"]["self"] is True
    # A salesperson still opens Billing from My sales; the team picker is the Sales Head's.
    assert one(api, w, w.s1, "select pulse.sales_numbers(null,null,null) r")["r"]["canOpenErp"] is True
    assert one(api, w, w.s1, "select pulse.sales_numbers(null,null,null) r")["r"]["team"] is None
    assert len(one(api, w, w.head, "select pulse.sales_numbers(null,null,null) r")["r"]["team"]) == 2


def accounts(worker, w):
    """Sign-in handles for the browser walk (the cf-access header names the person)."""
    with worker.transaction():
        set_tenant(worker, w.org)
        for who, handle in ((w.founder, "owner"), (w.s1, "seller"), (w.s2, "seller2"), (w.head, "head")):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"{handle}@{w.domain}", who))
    return {k: f"{k}@{w.domain}" for k in ("owner", "seller", "seller2", "head")}


def walk(w, emails, pages, checks=(), shots_env="PULSE_KV2_SCREENSHOTS"):
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_EMAILS": json.dumps(emails), "TEST_PAGES": json.dumps(pages), "TEST_API_CHECKS": json.dumps(list(checks))}
    p = subprocess.run(["node", "test/kazuk-v2-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=2400, check=False)
    print(p.stdout[-6000:])
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    return p.stdout


def test_incentive_is_not_due_until_paid_then_pending_until_the_sales_head_releases_it(api, deals):
    """R44, R60 (T23): each deal's incentive; the salesperson sees their own, the Sales Head releases."""
    w = deals
    inc = lambda who, person=None: {x["id"]: x["incentive"] for x in one(api, w, who, "select pulse.sales_workspace(%s) h", (person,))["h"]["deals"]}  # noqa: E731
    mine = inc(w.s1)
    assert mine[str(w.q1)] == "pending" and mine[str(w.q2)] == "not_due"
    assert one(api, w, w.s1, "select pulse.sales_workspace(null) h")["h"]["incentives"] == {"pending": 1, "released": 0, "notDue": 0}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.s1, "select pulse.sales_incentive_set(%s,true,null)", (w.q1,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.s2, "select pulse.sales_workspace(%s) h", (w.s1,))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="once the deal is Paid"):
        one(api, w, w.head, "select pulse.sales_incentive_set(%s,true,null)", (w.q3,))
    assert one(api, w, w.head, "select pulse.sales_incentive_set(%s,true,'Synthetic November payout') s", (w.q1,))["s"] == "released"
    assert inc(w.s1)[str(w.q1)] == "released" and inc(w.head, w.s1)[str(w.q1)] == "released"
    # The released row is the salesperson's and the team's to read, never another salesperson's.
    assert len(as_(api, w, w.s1, "select document_id from pulse.sales_incentive")) == 1
    assert as_(api, w, w.s2, "select document_id from pulse.sales_incentive") == []
    assert one(api, w, w.head, "select pulse.sales_incentive_set(%s,false,null) s", (w.q1,))["s"] == "pending"


@pytest.fixture
def sold(api, worker, owner, deals):
    """T18-T22 with a client: Test Realty's quotation by S1, accepted, invoiced and paid, with a client group and a pod
    chat for the client made beforehand."""
    w = deals
    w.client = uuid.uuid4()
    w.group, w.pod = uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.client(id,org_id,display_name,city,phone) values(%s,%s,'Test Realty Pvt Ltd','Pune','+91 90000 00111')", (w.client, w.org))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.chat_channel(org_id,id,key,name,kind) values(%s,%s,%s,'Test Realty · client','custom'),(%s,%s,%s,'Test Realty · pod','pod')",
                      (w.org, w.group, f"custom:{w.group}", w.org, w.pod, f"pod:{w.pod}"))
        owner.execute("insert into pulse.chat_group_info(org_id,channel_id,kind,client_id) values(%s,%s,'client',%s),(%s,%s,'pod',%s)", (w.org, w.group, w.client, w.org, w.pod, w.client))
    w.q4 = quote(api, w, w.s1, [("Synthetic Meta Ads Management", 2500000)], client=w.client)
    send(api, w, w.s1, w.q4)
    one(api, w, w.s1, "select pulse.erp_document_mark(%s,'accepted',null)", (w.q4,))
    w.inv4 = from_quote(api, w, w.s1, w.q4, taxable=2500000)
    as_(api, w, w.s1, "update pulse.erp_document set client_id=%s,buyer=buyer||%s where id=%s", (w.client, Jsonb({"name": "Test Realty Pvt Ltd"}), w.inv4))
    issue(api, w, w.s1, w.inv4)
    assert not as_(api, w, w.founder, "select 1 from pulse.chat_member where channel_id=%s and person_id=%s", (w.group, w.s1))
    one(api, w, w.s1, "select pulse.erp_payment_add(%s,%s)", (w.inv4, Jsonb({"amount": 1475000, "receivedOn": "2026-04-05", "method": "upi", "reference": "TESTUTR011"})))
    one(api, w, w.s1, "select pulse.erp_payment_add(%s,%s)", (w.inv4, Jsonb({"amount": 1475000, "receivedOn": "2026-04-06", "method": "bank", "reference": "TESTUTR012"})))
    return w


def test_at_paid_the_salesperson_joins_the_client_group_never_the_pod_chat(api, owner, sold):
    """R41, R56 (T22): at Paid; and a group typed as the client's later takes in the salespeople of its paid deals."""
    w = sold
    with owner.transaction():
        set_tenant(owner, w.org)
        members = {(r["channel_id"], r["person_id"]) for r in owner.execute("select channel_id,person_id from pulse.chat_member where person_id=%s", (w.s1,)).fetchall()}
        said = owner.execute("select body from pulse.chat_message where channel_id=%s and kind='event'", (w.group,)).fetchall()
        later = uuid.uuid4()
        owner.execute("insert into pulse.chat_channel(org_id,id,key,name,kind) values(%s,%s,%s,'Test Realty · updates','custom')", (w.org, later, f"custom:{later}"))
        # Typed as the client's group by the groups hub after the sale (it saves the row; row security hides it from
        # this test role afterwards, so the type is given as it is saved).
        owner.execute("insert into pulse.chat_group_info(org_id,channel_id,kind,client_id) values(%s,%s,'client',%s)", (w.org, later, w.client))
        joined_later = owner.execute("select 1 from pulse.chat_member where channel_id=%s and person_id=%s", (later, w.s1)).fetchall()
    assert (w.group, w.s1) in members and (w.pod, w.s1) not in members
    assert [r["body"] for r in said] == ["joined as the salesperson"]
    assert joined_later


def test_projects_i_sold_are_read_only_and_only_mine(api, sold):
    """R42, R55 (T22, T27): the project the paid deal started, with its PGS, work and renewal, for S1 only."""
    w = sold
    p = one(api, w, w.s1, "select pulse.sales_sold_projects(null,null) p")["p"]
    assert "Test Realty Pvt Ltd" in [x["client"] for x in p["projects"]], p
    proj = next(x for x in p["projects"] if x["client"] == "Test Realty Pvt Ltd")
    assert proj["clientGroup"] is True and proj["tasks"]["total"] >= 1
    detail = one(api, w, w.s1, "select pulse.sales_sold_projects(null,%s) p", (proj["id"],))["p"]["projects"][0]
    assert detail["upcoming"] is not None and detail["recent"] is not None
    assert one(api, w, w.s2, "select pulse.sales_sold_projects(null,null) p")["p"]["projects"] == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="not sold by you"):
        one(api, w, w.s2, "select pulse.sales_sold_projects(null,%s) p", (proj["id"],))
    assert one(api, w, w.s1, "select pulse.sales_workspace(null) h")["h"]["sold"] == len(p["projects"])


def test_neeti_numbers_say_not_recorded_where_sales_xray_sent_nothing(api, owner, deals):
    """R45 (T23): leads, attempts, proposals, closes and lost reasons from the synced leads; setting calls null."""
    w = deals
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.sales_xray_sync(org_id,enabled,last_run_at,last_ok_at) values(%s,true,now(),now())", (w.org,))
        for stage, label in (("new", None), ("proposal", "Proposal sent"), ("won", "Won"), ("lost", "Price")):
            owner.execute("""insert into pulse.sales_xray_lead(org_id,sx_lead_id,name,stage,stage_label,owner_name,sx_created_at)
                values(%s,%s,'Synthetic lead',%s,%s,'Synthetic Seller One',now())""", (w.org, uuid.uuid4(), stage, label))
    n = one(api, w, w.s1, "select pulse.sales_neeti(null,null,null) n")["n"]
    assert (n["connected"], n["leads"], n["proposals"], n["closes"]) == (True, 4, 1, 1), n
    assert n["settingCalls"] is None and n["strategySessions"] is None and n["firstCallMinutes"] is None and n["lastSync"]
    assert n["lost"] == [{"reason": "Price", "count": 1}]
    # S2 has no synced leads: Not recorded (null), never a made-up 0.
    assert one(api, w, w.s2, "select pulse.sales_neeti(null,null,null) n")["n"]["leads"] is None


def agent_one(api, w, agent, sql, args=()):
    """A query in the Sales Agent's own session (as the agent runtime and the API's bot key run it)."""
    with api.transaction():
        set_tenant(api, w.org, agent)
        api.execute("select set_config('pulse.agent_session','on',true)")
        cur = api.execute(sql, args)
        return cur.fetchone() if cur.description else None


def test_a_sales_agent_per_salesperson_drafts_and_never_sends(api, sold):
    """G14 template; T08: it reminds about no reply with a draft and cannot send or issue."""
    w = sold
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.s1, "select pulse.sales_agent_create(%s) a", (w.s1,))
    agent = one(api, w, w.head, "select pulse.sales_agent_create(%s) a", (w.s1,))["a"]
    assert one(api, w, w.head, "select pulse.sales_agent_create(%s) a", (w.s1,))["a"] == agent
    m = one(api, w, w.head, "select title,owner_person_id,tools from pulse.agent_member where person_id=%s", (agent,))
    assert (m["title"], m["owner_person_id"], sorted(m["tools"])) == ("Sales Agent", w.s1, ["billing", "chats", "memory", "projects"])
    assert len(as_(api, w, w.head, "select id from pulse.agent_rule where agent_id=%s", (agent,))) == 5
    # T08: S2's quotation is not S1's agent's; S1's open quotation q5, sent today, is quiet until 3 days pass.
    q5 = quote(api, w, w.s1, [("Synthetic Brand Film", 5000000)], client=w.client)
    send(api, w, w.s1, q5)
    now = agent_one(api, w, agent, "select pulse.sales_agent_nudges(null,null) n")["n"]
    assert not [x for x in now["items"] if x["kind"] == "no_reply"]
    later = agent_one(api, w, agent, "select pulse.sales_agent_nudges(null,now()+interval '3 days') n")["n"]
    nr = [x for x in later["items"] if x["kind"] == "no_reply"]
    assert [x["docId"] for x in nr] == [str(q5)]
    number = one(api, w, w.s1, "select number from pulse.erp_document where id=%s", (q5,))["number"]
    assert nr[0]["title"] == f"No reply on {number} V1 for 3 days" and number in nr[0]["draft"] and "₹59,000" in nr[0]["draft"]
    # It drafts: a new draft quotation is fine; sending, issuing or marking anything is refused.
    draft_q = agent_one(api, w, agent, """insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,salesperson_id)
        values(%s,'quotation',current_date,%s,%s,'27','intra',0,0,0,0,0,%s) returning id""", (w.org, Jsonb(SELLER), Jsonb(BUYER), w.s1))["id"]
    agent_one(api, w, agent, """insert into pulse.erp_line(org_id,document_id,position,description,sac,qty,rate,gst_rate,taxable,cgst,sgst,igst,total)
        values(%s,%s,0,'Synthetic Reel','998361',1,1000000,18,1000000,90000,90000,0,1180000) returning id""", (w.org, draft_q))
    agent_one(api, w, agent, "update pulse.erp_document set taxable=1000000,cgst=90000,sgst=90000,total=1180000 where id=%s returning id", (draft_q,))
    for sql, args in (("select pulse.erp_document_mark(%s,'sent',null)", (q5,)), ("select pulse.erp_document_issue(%s)", (draft_q,)),
                      ("select pulse.erp_document_mark(%s,'accepted',null)", (q5,))):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            agent_one(api, w, agent, sql, args)
    assert one(api, w, w.s1, "select status from pulse.erp_document where id=%s", (q5,))["status"] == "sent"
    # Settings: the salesperson moves the reminder to 5 days.
    assert one(api, w, w.s1, "select pulse.sales_agent_settings(%s,5,null) s", (w.s1,))["s"] == {"noReplyDays": 5, "renewalDays": 30}
    assert not [x for x in agent_one(api, w, agent, "select pulse.sales_agent_nudges(null,now()+interval '3 days') n")["n"]["items"] if x["kind"] == "no_reply"]


def test_overdue_invoices_and_renewals_get_a_drafted_reminder(api, owner, sold):
    """T25 (an invoice past its due date) and T29 (the signed term ends in 30 days)."""
    w = sold
    q6 = quote(api, w, w.s1, [("Synthetic Meta Ads Management", 1000000)], client=w.client)
    send(api, w, w.s1, q6)
    one(api, w, w.s1, "select pulse.erp_document_mark(%s,'accepted',null)", (q6,))
    inv = from_quote(api, w, w.s1, q6, taxable=1000000)
    as_(api, w, w.s1, "update pulse.erp_document set client_id=%s,due_date=(now() at time zone pulse.org_time_zone())::date-5 where id=%s", (w.client, inv))
    issue(api, w, w.s1, inv)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.client set renewal_on=(now() at time zone pulse.org_time_zone())::date+30 where id=%s", (w.client,))
    items = one(api, w, w.s1, "select pulse.sales_agent_nudges(null,null) n")["n"]["items"]
    kinds = [x["kind"] for x in items]
    assert kinds[0] == "overdue" and "renewal" in kinds, items
    late = items[0]
    assert late["days"] == 5 and late["amount"] == 1180000 and "₹11,800" in late["draft"] and "UTR" in late["draft"]
    renewal = next(x for x in items if x["kind"] == "renewal")
    assert renewal["title"] == "Renewal: Test Realty Pvt Ltd ends in 30 days" and "next term" in renewal["draft"]
    # S2 has none of S1's reminders.
    assert one(api, w, w.s2, "select pulse.sales_agent_nudges(null,null) n")["n"]["items"] == []


def test_discount_advice_follows_the_order_and_never_blocks(api, sales):  # noqa: F811
    """T28 (R48): 15% off → payment terms, then a bonus, then one package down; the price stays the salesperson's."""
    w = sales
    starter = one(api, w, w.founder, "insert into pulse.erp_item(org_id,kind,name,price,status,created_by) values(%s,'package','Synthetic Starter',5000000,'active',%s) returning id", (w.org, w.founder))["id"]
    growth = one(api, w, w.founder, "insert into pulse.erp_item(org_id,kind,name,price,status,created_by) values(%s,'package','Synthetic Growth',7500000,'active',%s) returning id", (w.org, w.founder))["id"]
    one(api, w, w.founder, "insert into pulse.erp_item(org_id,kind,name,price,status,created_by) values(%s,'service','Synthetic Reel',1000000,'active',%s) returning id", (w.org, w.founder))
    a = one(api, w, w.s1, "select pulse.sales_discount_advice(15,1125000,%s) a", (growth,))["a"]
    assert a["blocks"] is False and a["level"] == "big" and [s["key"] for s in a["steps"]] == ["terms", "bonus", "package"]
    assert a["say"] == "Before giving 15% off, try these first, in this order."
    assert "Synthetic Reel" in a["steps"][1]["detail"] and a["steps"][2]["itemId"] == str(starter) and "Synthetic Starter at ₹50,000" in a["steps"][2]["detail"]
    assert one(api, w, w.s1, "select pulse.sales_discount_advice(0,null,null) a")["a"]["steps"] == []
    assert one(api, w, w.s1, "select pulse.sales_discount_advice(3,null,%s) a", (starter,))["a"]["steps"][2]["detail"] == "Synthetic Starter is already the smallest package."


def test_the_agent_answers_how_did_i_do_and_the_project_read_only_and_drafts_a_change_order(api, owner, sold):
    """T27 (R54, R55) and R58: numbers kept apart, the project read only, a change order as a new draft on the project."""
    w = sold
    agent = one(api, w, w.head, "select pulse.sales_agent_create(%s) a", (w.s1,))["a"]
    how = agent_one(api, w, agent, "select pulse.sales_how_did_i_do(null,'2026-04-01','2026-04-01') h")["h"]
    assert how["collected"] == 2950000 + 2655000 and how["invoiced"] >= 2950000 and "kept apart" in how["words"]
    proj = next(x for x in agent_one(api, w, agent, "select pulse.sales_sold_projects(null,null) p")["p"]["projects"] if x["client"] == "Test Realty Pvt Ltd")
    # Read only: the agent has no tasks tool and cannot change the project's tasks.
    try:
        changed = agent_one(api, w, agent, "update pulse.task set title='changed by the agent' where project_id=%s returning id", (proj["id"],))
    except psycopg.Error:
        changed = None
    assert changed is None
    co = agent_one(api, w, agent, "select pulse.sales_change_order(%s,'Two extra reels') id", (proj["id"],))["id"]
    d = one(api, w, w.s1, "select doc_type,status,project_id,salesperson_id,client_id,notes from pulse.erp_document where id=%s", (co,))
    assert (d["doc_type"], d["status"], str(d["project_id"]), d["salesperson_id"], d["client_id"]) == ("quotation", "draft", proj["id"], w.s1, w.client)
    assert d["notes"] == "Change order: Two extra reels"
    # Proof for a pitch: Test Realty has not agreed to be named.
    proof = agent_one(api, w, agent, "select pulse.sales_proof('Pune',null) p")["p"]["items"]
    assert proof and proof[0]["client"] == "A client in Pune" and proof[0]["project"] is None
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.client set may_be_named=true where id=%s", (w.client,))
    assert agent_one(api, w, agent, "select pulse.sales_proof('Pune',null) p")["p"]["items"][0]["client"] == "Test Realty Pvt Ltd"


def backdate_issued(owner, w, sql, args=()):
    """Move an issued document back in time (erp_document_guard paused in this one transaction, as test_kazuk_gaps)."""
    with owner.transaction():
        owner.execute("set local role pulse_owner")
        owner.execute("alter table pulse.erp_document disable trigger erp_document_guard")
        set_tenant(owner, w.org)
        owner.execute(sql, args)
        owner.execute("alter table pulse.erp_document enable trigger erp_document_guard")


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_kazuk_v2_in_the_browser(api, worker, owner, sold):
    """services/api/test/kazuk-v2-browser-runner.mjs, Kazuk's v2 steps on screen at 1440 and 363, light and dark:
    T26 Billing → Deals (V1 against final, the discount, versions, days, Brand Film cut, lost to a competitor, per
    salesperson); T23 My sales as one home (deal Paid, incentive Pending, Neeti numbers with the last sync and "Not
    recorded"; a second salesperson sees none of it; the Sales Head can release); T22 Projects I sold, read only, and in the
    client group; T08/T25/T29 the Sales Agent's reminders with drafts; T28 the discount advice in the quotation."""
    w = sold
    emails = accounts(worker, w)
    agent = one(api, w, w.head, "select pulse.sales_agent_create(%s) a", (w.s1,))["a"]
    # The fixtures' documents are dated early April; the walk moves them to this month (gaps kept), so the month's
    # money tiles and the lists below them tell the same story.
    with owner.transaction():
        owner.execute("set local role pulse_owner")
        owner.execute("alter table pulse.erp_document disable trigger erp_document_guard")
        owner.execute("alter table pulse.erp_document disable trigger erp_quote_guard")
        set_tenant(owner, w.org)
        # 2 Apr (the first fixture date) becomes the 1st of this month, unless that would put 6 Apr (the last) after today.
        shift = "least(date_trunc('month',current_date)::date-date '2026-04-02',current_date-date '2026-04-06')"
        owner.execute(f"update pulse.erp_document set issue_date=issue_date+({shift}) where org_id=%s and issue_date<date '2026-05-01'", (w.org,))
        owner.execute(f"update pulse.erp_payment set received_on=received_on+({shift}) where org_id=%s and received_on<date '2026-05-01'", (w.org,))
        base = owner.execute("select max(issue_date) d from pulse.erp_document where org_id=%s", (w.org,)).fetchone()["d"]
        owner.execute("alter table pulse.erp_document enable trigger erp_quote_guard")
        owner.execute("alter table pulse.erp_document enable trigger erp_document_guard")
    today = datetime.date.today()
    # A series never goes back in time: the walk's own documents are dated on or after the last shifted one.
    on = lambda days: str(max(base, today - datetime.timedelta(days=days)))  # noqa: E731
    # T27: the agent's own co-worker key (an admin issues it), for its read-only answers over the API.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (w.org, w.founder))
    key = one(api, w, w.founder, "select pulse.agent_key_issue(%s,'synthetic runner') k", (agent,))["k"]
    # T08: a quotation sent 3 days ago with no reply. T25: an invoice 5 days late. T29: the signed term ends in 30 days.
    q6 = quote(api, w, w.s1, [("Synthetic Meta Ads Management", 1000000)], day=on(5), client=w.client)
    send(api, w, w.s1, q6)
    one(api, w, w.s1, "select pulse.erp_document_mark(%s,'accepted',null)", (q6,))
    inv = from_quote(api, w, w.s1, q6, taxable=1000000, day=on(5))
    as_(api, w, w.s1, "update pulse.erp_document set client_id=%s,buyer=buyer||%s,due_date=(now() at time zone pulse.org_time_zone())::date-5 where id=%s", (w.client, Jsonb({"name": "Test Realty Pvt Ltd"}), inv))
    issue(api, w, w.s1, inv)
    q5 = quote(api, w, w.s1, [("Synthetic Brand Film", 5000000)], day=on(3), client=w.client)
    send(api, w, w.s1, q5)
    backdate_issued(owner, w, "update pulse.erp_document set sent_at=now()-interval '3 days 1 hour' where id=%s", (q5,))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.client set renewal_on=(now() at time zone pulse.org_time_zone())::date+30 where id=%s", (w.client,))
        # T23: Neeti numbers, synced; setting calls and strategy sessions never sent (Not recorded).
        owner.execute("insert into pulse.sales_xray_sync(org_id,enabled,last_run_at,last_ok_at) values(%s,true,now(),now())", (w.org,))
        for stage, label in (("new", None), ("contacted", None), ("proposal", "Proposal sent"), ("won", "Won"), ("lost", "Lost on price")):
            owner.execute("""insert into pulse.sales_xray_lead(org_id,sx_lead_id,name,stage,stage_label,owner_name,sx_created_at)
                values(%s,%s,'Synthetic lead',%s,%s,'Synthetic Seller One',now()-interval '2 days')""", (w.org, uuid.uuid4(), stage, label))
    # T28: a draft quotation with the Growth package at 15% under its catalogue price.
    growth = one(api, w, w.founder, "insert into pulse.erp_item(org_id,kind,name,price,sac,status,created_by) values(%s,'package','Synthetic Growth',7500000,'998361','active',%s) returning id", (w.org, w.founder))["id"]
    one(api, w, w.founder, "insert into pulse.erp_item(org_id,kind,name,price,sac,status,created_by) values(%s,'package','Synthetic Starter',5000000,'998361','active',%s) returning id", (w.org, w.founder))
    one(api, w, w.founder, "insert into pulse.erp_item(org_id,kind,name,price,sac,status,created_by) values(%s,'service','Synthetic Reel',1000000,'998361','active',%s) returning id", (w.org, w.founder))
    q7 = quote(api, w, w.s1, [("Synthetic Growth", 6375000)], day=on(0), client=w.client)
    as_(api, w, w.s1, "update pulse.erp_line set item_id=%s where document_id=%s", (growth, q7))
    project = next(x["id"] for x in one(api, w, w.s1, "select pulse.sales_sold_projects(null,null) p")["p"]["projects"] if x["client"] == "Test Realty Pvt Ltd")
    pages = [
        {"name": "T26-owner-deals", "step": "T26", "role": "owner", "path": "/erp/deals?period=month",
         "see": ["Average discount", "Quotes changed", "Days to say yes", "Days to paid", "Services cut or made cheaper", "Synthetic Brand Film", "Why deals were lost", "Competitor", "By salesperson", "Synthetic Seller One", "Synthetic Seller Two"]},
        {"name": "T26-seller-deals", "step": "T26", "role": "seller", "path": "/erp/deals?period=month",
         "see": ["Your deals", "Services I cut or made cheaper", "Synthetic Brand Film", "Why I lost deals", "70% off"], "hide": ["Synthetic Seller Two", "By salesperson"]},
        {"name": "T23-seller-home", "step": "T23", "role": "seller", "path": "/sales",
         "see": ["My sales", "Today", "My pipeline", "Incentive: Pending", "From Sales X-Ray", "Not recorded", "Last sync", "How my deals went", "My Sales Agent",
                 "No reply on", "days late", "Renewal: Test Realty Pvt Ltd ends in 30 days", "Open draft", "Projects I sold"],
         "hide": ["Synthetic Seller Two", "Waiting for approval"]},
        {"name": "T23-seller2-home", "step": "T23", "role": "seller2", "path": "/sales", "see": ["My sales", "My deals"], "hide": ["Test Realty Pvt Ltd", "Synthetic Seller One"]},
        {"name": "T23-head-sees-seller", "step": "T23", "role": "head", "path": f"/sales?person={w.s1}", "see": ["Sales · Synthetic Seller One", "Incentive: Pending", "Mark released"]},
        {"name": "T22-seller-projects", "step": "T22", "role": "seller", "path": "/sales/projects", "see": ["Projects I sold", "Test Realty Pvt Ltd", "You are in the client group", "Read only"]},
        {"name": "T22-seller-project", "step": "T22", "role": "seller", "path": f"/sales/projects/{project}", "see": ["Work done", "Done lately", "Next up", "Read only"]},
        {"name": "T28-seller-discount-advice", "step": "T28", "role": "seller", "path": f"/erp/documents/{q7}",
         "see": ["Your Sales Agent suggests", "Before giving 15% off", "Better payment terms", "Add a bonus", "One package down", "Synthetic Starter", "advice only"]},
    ]
    checks = [
        {"step": "T23", "role": "seller", "url": f"sales-numbers?person={w.s2}", "status": 403},
        {"step": "T23", "role": "seller", "url": f"sales-deals?person={w.s2}", "status": 403},
        {"step": "T23", "role": "seller2", "url": f"sales-workspace?person={w.s1}", "status": 403},
        {"step": "T23", "role": "head", "url": "sales-deals?all=1", "status": 200, "has": ["Synthetic Seller One", "Synthetic Seller Two"]},
        {"step": "T08", "role": "seller", "url": "sales-agent/nudges", "status": 200, "has": ["No reply on", "just checking that you got our quotation"]},
        {"step": "T25", "role": "seller", "url": "sales-agent/nudges", "status": 200, "has": ["days late", "gentle reminder"]},
        {"step": "T29", "role": "seller", "url": "sales-agent/nudges", "status": 200, "has": ["Renewal: Test Realty Pvt Ltd ends in 30 days"]},
        {"step": "T28", "role": "seller", "url": f"sales-agent/advice?discount=15&amount=1125000&package={growth}", "status": 200, "has": ['"blocks":false', "One package down", "Synthetic Starter"]},
        {"step": "T23", "role": "seller", "url": f"sales-incentive/{w.q4}", "body": {"released": True}, "status": 403},
        {"step": "T27", "role": None, "url": "agent/sales/how-did-i-do?period=fy", "headers": {"x-pulse-agent-key": key}, "status": 200, "has": ["dealValue", "collected", "kept apart"]},
        {"step": "T27", "role": None, "url": f"agent/sales/projects?project={project}", "headers": {"x-pulse-agent-key": key}, "status": 200, "has": ["Test Realty Pvt Ltd", "upcoming"]},
        {"step": "T08", "role": None, "url": "agent/sales/nudges", "headers": {"x-pulse-agent-key": key}, "status": 200, "has": ["No reply on"]},
        {"step": "T28", "role": None, "url": f"agent/sales/advice?discount=15&amount=1125000&package={growth}", "headers": {"x-pulse-agent-key": key}, "status": 200, "has": ["Better payment terms"]},
    ]
    walk(w, emails, pages, checks)
    # T23: the Sales Head releases S1's incentive (as the page's button does), and S1 sees Released.
    assert one(api, w, w.head, "select pulse.sales_incentive_set(%s,true,null) s", (w.q4,))["s"] == "released"
