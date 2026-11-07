"""BILLING-SETUP (0540, EST-1358/1359/1360): an issued invoice moves the stock it sells and a cancelled one brings it
back, once per invoice and item, only while the company keeps inventory; short stock goes below zero and is noted, or,
when the company switches on blockShortStock, refuses the issue without using a number. Each company keeps its own industry pack and field switches, which Billing writers change and other people
cannot, in the database and through the API. Synthetic tenants, people, items and figures only."""
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import BUYER, SELLER, as_, erp, one, person  # noqa: F401  (erp is a fixture)

ROOT = Path(__file__).resolve().parents[2]


def item(api, w, who, kind, name, price=1000000, track=False):
    return one(api, w, who, """insert into pulse.erp_item(org_id,kind,name,unit,price,track_stock,status) values(%s,%s,%s,'nos',%s,%s,'active') returning id""",
               (w.org, kind, name, price, track))["id"]


def document(api, w, who, lines, doc_type="invoice", day="2026-04-02"):
    """A draft whose lines name catalogue items: [(item_id, qty, rate in paise)], 18% GST within the state."""
    rows = []
    for item_id, qty, rate in lines:
        taxable = int(qty * rate)
        rows.append((item_id, qty, rate, taxable, taxable * 9 // 100))
    taxable, half = sum(r[3] for r in rows), sum(r[4] for r in rows)
    with api.transaction():
        set_tenant(api, w.org, who)
        did = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,created_by)
            values(%s,%s,%s,%s,%s,'27','intra',%s,%s,%s,0,%s,%s) returning id""",
                          (w.org, doc_type, day, Jsonb(SELLER), Jsonb(BUYER), taxable, half, half, taxable + 2 * half, who)).fetchone()["id"]
        for i, (item_id, qty, rate, line_taxable, line_half) in enumerate(rows):
            api.execute("""insert into pulse.erp_line(org_id,document_id,position,item_id,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total)
                values(%s,%s,%s,%s,%s,%s,%s,18,%s,%s,%s,0,%s)""", (w.org, did, i, item_id, f"Synthetic line {i + 1}", qty, rate, line_taxable, line_half, line_half, line_taxable + 2 * line_half))
    return did


def issue(api, w, who, did):
    return one(api, w, who, "select pulse.erp_document_issue(%s) r", (did,))["r"]["number"]


def moves(api, w, who, did=None):
    return [(r["item_id"], r["kind"], float(r["qty"])) for r in as_(api, w, who, """select item_id,kind,qty from pulse.erp_stock_move
        where (%s::uuid is null or document_id=%s) and document_id is not null order by created_at,item_id""", (did, did))]


def on_hand(api, w, who, item_id):
    return float(one(api, w, who, "select pulse.erp_on_hand(%s) n", (item_id,))["n"])


@pytest.fixture
def shop(api, erp):  # noqa: F811
    """A company that keeps stock: a tracked panel and cable, an untracked service, and a package of 2 panels and the service."""
    w = erp
    as_(api, w, w.finance, "update pulse.erp_settings set inventory_enabled=true")
    w.panel = item(api, w, w.finance, "product", "Synthetic panel (550 W)", track=True)
    w.cable = item(api, w, w.finance, "consumable", "Synthetic cable", price=20000, track=True)
    w.service = item(api, w, w.finance, "service", "Synthetic installation")
    w.kit = item(api, w, w.finance, "package", "Synthetic rooftop kit", price=3000000)
    one(api, w, w.finance, "select pulse.erp_parts_set(%s,%s)", (w.kit, Jsonb([{"label": "Panels", "itemId": str(w.panel), "quantity": 2},
                                                                                {"label": "Fitting", "itemId": str(w.service)}])))
    for it, qty in ((w.panel, 10), (w.cable, 50)):
        as_(api, w, w.finance, "insert into pulse.erp_stock_move(org_id,item_id,kind,qty) values(%s,%s,'in',%s)", (w.org, it, qty))
    return w


def test_an_issued_invoice_moves_its_stock_out_once_and_a_cancelled_one_brings_it_back(api, shop):
    w = shop
    inv = document(api, w, w.finance, [(w.panel, 3, 1000000), (w.service, 1, 500000), (w.kit, 1, 3000000), (w.cable, 4.5, 20000), (None, 1, 100000)])
    # A quotation and a proforma for the same goods move nothing.
    for kind in ("quotation", "proforma"):
        issue(api, w, w.finance, document(api, w, w.finance, [(w.panel, 3, 1000000)], doc_type=kind))
    assert moves(api, w, w.finance) == []
    number = issue(api, w, w.finance, inv)
    assert number == "INV/26-27/0001"
    # One move per tracked item: 3 panels on their own line and 2 in the kit; the cable; the service and the free line move nothing.
    got = as_(api, w, w.finance, """select item_id,kind,qty::float8 qty,note,to_char(on_date,'YYYY-MM-DD') d,created_by from pulse.erp_stock_move where document_id=%s order by item_id""", (inv,))
    assert sorted((r["item_id"], r["kind"], r["qty"]) for r in got) == sorted([(w.panel, "out", 5.0), (w.cable, "out", 4.5)])
    assert {(r["note"], r["d"], r["created_by"]) for r in got} == {(f"Invoice {number}", "2026-04-02", w.finance)}
    assert (on_hand(api, w, w.finance, w.panel), on_hand(api, w, w.finance, w.cable)) == (5.0, 45.5)
    assert {"issued", "stock_out"} <= {r["kind"] for r in as_(api, w, w.finance, "select kind from pulse.erp_event where subject_id=%s", (inv,))}
    # The same move cannot be recorded twice for one invoice.
    with pytest.raises(psycopg.errors.UniqueViolation):
        as_(api, w, w.finance, "insert into pulse.erp_stock_move(org_id,item_id,kind,qty,document_id) values(%s,%s,'out',1,%s)", (w.org, w.panel, inv))
    # Marking it sent or paid moves nothing more.
    one(api, w, w.finance, "select pulse.erp_document_mark(%s,'sent')", (inv,))
    assert len(moves(api, w, w.finance, inv)) == 2
    # Cancelled: the stock comes back, once.
    one(api, w, w.finance, "select pulse.erp_document_mark(%s,'cancel','Synthetic: the client changed the order')", (inv,))
    assert sorted(moves(api, w, w.finance, inv)) == sorted([(w.panel, "out", 5.0), (w.cable, "out", 4.5), (w.panel, "in", 5.0), (w.cable, "in", 4.5)])
    assert (on_hand(api, w, w.finance, w.panel), on_hand(api, w, w.finance, w.cable)) == (10.0, 50.0)
    assert as_(api, w, w.finance, "select note from pulse.erp_stock_move where document_id=%s and kind='in' limit 1", (inv,))[0]["note"] == f"Invoice {number} cancelled"


def test_short_stock_goes_below_zero_and_is_noted_unless_the_company_refuses_it(api, shop):
    w = shop
    # By default the invoice goes out: the move is recorded, stock shows below zero, the log notes the shortfall.
    first = document(api, w, w.finance, [(w.panel, 4, 1000000), (w.kit, 4, 3000000)])     # 4 + 8 panels, 10 on hand
    assert issue(api, w, w.finance, first) == "INV/26-27/0001"
    assert moves(api, w, w.finance, first) == [(w.panel, "out", 12.0)] and on_hand(api, w, w.finance, w.panel) == -2.0
    noted = as_(api, w, w.finance, "select detail from pulse.erp_event where subject_id=%s and kind='stock_short'", (first,))
    assert noted == [{"detail": {"number": "INV/26-27/0001", "items": [{"item": str(w.panel), "onHand": 10, "needs": 12}]}}]
    # A hand-made move still never takes stock below zero (0190's rule).
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Not enough stock: -2"):
        as_(api, w, w.finance, "insert into pulse.erp_stock_move(org_id,item_id,kind,qty) values(%s,%s,'out',1)", (w.org, w.panel))
    # A company that wants stock to stay true switches the refusal on: short stock refuses the issue, no number is used.
    one(api, w, w.finance, "select pulse.erp_setup_save(%s)", (Jsonb({"pack": "dealer", "fields": {"blockShortStock": True}}),))
    as_(api, w, w.finance, "insert into pulse.erp_stock_move(org_id,item_id,kind,qty) values(%s,%s,'in',12)", (w.org, w.panel))     # back to 10
    short = document(api, w, w.finance, [(w.panel, 4, 1000000), (w.kit, 4, 3000000)])
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Not enough stock of Synthetic panel 550 W: 10 on hand, this invoice needs 12"):
        issue(api, w, w.finance, short)
    assert one(api, w, w.finance, "select status,number from pulse.erp_document where id=%s", (short,)) == {"status": "draft", "number": None}
    assert moves(api, w, w.finance, short) == [] and on_hand(api, w, w.finance, w.panel) == 10.0
    # Once the stock is recorded in, the same draft issues with the next number.
    as_(api, w, w.finance, "insert into pulse.erp_stock_move(org_id,item_id,kind,qty) values(%s,%s,'in',2)", (w.org, w.panel))
    assert issue(api, w, w.finance, short) == "INV/26-27/0002"
    assert on_hand(api, w, w.finance, w.panel) == 0.0


def test_no_stock_moves_while_inventory_is_off_and_none_in_another_company(api, worker, owner, shop):
    from helpers import build_world
    w = shop
    as_(api, w, w.finance, "update pulse.erp_settings set inventory_enabled=false")
    inv = document(api, w, w.finance, [(w.panel, 30, 1000000)])          # more than on hand: no guard while stock is off
    assert issue(api, w, w.finance, inv) == "INV/26-27/0001"
    assert moves(api, w, w.finance) == []
    # Cancelling an invoice that moved nothing brings nothing back.
    as_(api, w, w.finance, "update pulse.erp_settings set inventory_enabled=true")
    one(api, w, w.finance, "select pulse.erp_document_mark(%s,'cancel','Synthetic: issued by mistake')", (inv,))
    assert moves(api, w, w.finance) == [] and on_hand(api, w, w.finance, w.panel) == 10.0
    # Another company's Finance person sees none of these moves and moves only its own stock.
    o = build_world(worker, owner, api)
    o.finance = person(worker, o, "Synthetic Other Finance", "finance")
    with api.transaction():
        set_tenant(api, o.org, o.finance)
        api.execute("select pulse.erp_bootstrap()")
        api.execute("update pulse.erp_settings set company=%s,inventory_enabled=true", (Jsonb(SELLER),))
    assert as_(api, o, o.finance, "select count(*) n from pulse.erp_stock_move")[0]["n"] == 0
    theirs = item(api, o, o.finance, "product", "Synthetic other panel", track=True)
    as_(api, o, o.finance, "insert into pulse.erp_stock_move(org_id,item_id,kind,qty) values(%s,%s,'in',3)", (o.org, theirs))
    issue(api, o, o.finance, document(api, o, o.finance, [(theirs, 2, 1000000)]))
    assert moves(api, o, o.finance) == [(theirs, "out", 2.0)]
    assert moves(api, w, w.finance) == []


def test_each_company_keeps_its_pack_and_field_switches_and_only_billing_writers_change_them(api, worker, owner, erp):  # noqa: F811
    from helpers import build_world
    w = erp
    saved = one(api, w, w.finance, "select pulse.erp_setup_save(%s) r", (Jsonb({"pack": "dealer", "fields": {"serials": True, "team": False}, "inventoryEnabled": True}),))["r"]
    assert (saved["pack"], saved["fields"], saved["inventoryEnabled"]) == ("dealer", {"serials": True, "team": False}, True)
    row = one(api, w, w.founder, "select pack,pack_by,pack_at is not null as chosen,fields from pulse.erp_settings")
    assert (row["pack"], row["pack_by"], row["chosen"], row["fields"]) == ("dealer", w.finance, True, {"serials": True, "team": False})
    # Saving the same pack again keeps who chose it; the log names keys, never more.
    one(api, w, w.founder, "select pulse.erp_setup_save(%s) r", (Jsonb({"pack": "dealer", "fields": {"serials": False}}),))
    assert one(api, w, w.founder, "select pack_by,fields,inventory_enabled from pulse.erp_settings") == {"pack_by": w.finance, "fields": {"serials": False}, "inventory_enabled": True}
    detail = as_(api, w, w.founder, "select detail from pulse.erp_event where kind='setup' order by at desc limit 1")[0]["detail"]
    assert detail == {"pack": "dealer", "packChanged": False, "on": [], "off": ["serials"]}
    for bad, words in (({"pack": "Dealer!"}, "industry packs"), ({"fields": {"serials": "yes"}}, "switched on or off"), ({"fields": {"has space": True}}, "switched on or off"),
                       ({"fields": []}, "set of switches"), ({"inventoryEnabled": "on"}, "Stock is on or off")):
        with pytest.raises(psycopg.errors.InvalidParameterValue, match=words):
            one(api, w, w.finance, "select pulse.erp_setup_save(%s)", (Jsonb(bad),))
    # A member cannot read or change it; another company's settings are untouched.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.member, "select pulse.erp_setup_save(%s)", (Jsonb({"pack": "agency"}),))
    assert as_(api, w, w.member, "select pack from pulse.erp_settings") == []
    o = build_world(worker, owner, api)
    o.finance = person(worker, o, "Synthetic Other Finance", "finance")
    with api.transaction():
        set_tenant(api, o.org, o.finance)
        api.execute("select pulse.erp_bootstrap()")
    assert one(api, o, o.finance, "select pack,fields from pulse.erp_settings") == {"pack": None, "fields": {}}


API = r'''
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const emails = JSON.parse(process.env.TEST_EMAILS);
const call = async (role, body) => {
  const r = await app.inject({ url: '/api/v0/erp/setup', method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, ...(body === undefined ? {} : { payload: body }) });
  let json = null; try { json = r.json(); } catch { /* empty */ }
  return { status: r.statusCode, body: json };
};
const ok = (c, m, r) => assert.ok(c, `${m}: ${JSON.stringify(r?.body ?? r).slice(0, 1500)}`);
let r = await call('finance');
ok(r.status === 200 && r.body.pack === null && r.body.canWrite === true, 'Finance reads the setup', r);
ok(r.body.fields.discount === true && r.body.fields.serials === false && r.body.catalogue.length >= 15 && r.body.packs.some((p) => p.id === 'dealer' && p.ready), 'no pack: today\'s fields', r);
r = await call('finance', { pack: 'agency', fields: { team: false } });
ok(r.status === 200 && r.body.pack === 'agency' && r.body.fields.team === false && r.body.fields.deliverables === true && r.body.fields.serials === false, 'the agency pack with one switch of its own', r);
ok(r.body.saved.deliverables === true && Object.keys(r.body.saved).length === r.body.catalogue.length, 'the whole list is stored', r);
r = await call('finance', { pack: 'developer' });
ok(r.status === 400 && /Dealer/.test(r.body.error), 'a coming pack is not chosen yet', r);
r = await call('finance', { fields: { nonsense: true } });
ok(r.status === 400 && /not on the list/.test(r.body.error), 'an unknown field is refused', r);
r = await call('member');
ok(r.status === 403, 'a member does not read Billing setup', r);
r = await call('member', { pack: 'dealer' });
ok(r.status === 403, 'a member does not change it', r);
r = await call('finance');
ok(r.body.pack === 'agency' && r.body.packBy === 'Synthetic Finance', 'the refused changes changed nothing', r);
console.log(JSON.stringify({ ok: true }));
await app.close(); await pool.end();
'''


def test_the_setup_api_reads_and_saves_the_pack_and_fields(worker, erp):  # noqa: F811
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = erp
    with worker.transaction():
        set_tenant(worker, w.org)
        for pid, handle in ((w.finance, "finance"), (w.member, "member")):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"{handle}@{w.domain}", pid))

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")),
           "TEST_EMAILS": json.dumps({k: f"{k}@{w.domain}" for k in ("finance", "member")})}
    p = subprocess.run(["node", "--input-type=module", "-e", API], cwd=ROOT / "services/api", env=env, capture_output=True, text=True, timeout=240, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]


def test_the_web_field_list_matches_the_api():
    """apps/web/app/erp/settings/fields.ts and services/api/src/billing-setup.ts carry the same keys and packs."""
    import re
    keys = lambda text: re.findall(r'\{ key: "([a-zA-Z]+)", label: "[^"]*", group: "', text)        # noqa: E731  (fields, not the web's group headings)
    packs = lambda text: re.findall(r'\{ id: "([a-z]+)"', text)            # noqa: E731
    web = (ROOT / "apps/web/app/erp/settings/fields.ts").read_text(encoding="utf-8")
    api_src = (ROOT / "services/api/src/billing-setup.ts").read_text(encoding="utf-8")
    assert keys(web) == keys(api_src) and len(keys(web)) >= 15
    assert packs(web) == packs(api_src) == ["dealer", "agency", "developer", "trader", "professional"]
