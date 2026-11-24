"""QUOTE-BUILDER (2490; owner, 19-20 Nov 2026; board 5, option C "Quote + AI assistant"): your own price on a line,
extra charges (fixed, or variable: an estimate kept out of the total until confirmed), the AI's change card (nothing
changes until a person applies it) and the telemetry, on real PostgreSQL and tenant row security. The routes run through
services/api/test/quote-builder-runner.mjs. Synthetic people, products and prices only; nothing leaves the machine."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import BUYER, SELLER, _seed_erp_world, as_, erp, one  # noqa: F401  (erp is a fixture)
from test_quote_lines import draft


def test_a_charge_line_is_fixed_or_variable_and_only_a_variable_one_is_confirmed(api, erp):  # noqa: F811
    w = erp
    did = draft(api, w, w.finance, [("Synthetic inverter", 100000, None, False, False)])
    with pytest.raises(psycopg.errors.CheckViolation):
        as_(api, w, w.finance, "update pulse.erp_line set confirmed=true where document_id=%s", (did,))
    with pytest.raises(psycopg.errors.CheckViolation):
        as_(api, w, w.finance, "update pulse.erp_line set charge='per-km' where document_id=%s", (did,))
    with pytest.raises(psycopg.errors.CheckViolation):
        as_(api, w, w.finance, "update pulse.erp_line set charge='fixed',rate=0,line_role='included' where document_id=%s", (did,))
    with pytest.raises(psycopg.errors.CheckViolation):
        as_(api, w, w.finance, "update pulse.erp_line set price_note='' where document_id=%s", (did,))
    as_(api, w, w.finance, "update pulse.erp_line set charge='variable',confirmed=true,price_note='Synthetic reason' where document_id=%s", (did,))
    with pytest.raises(psycopg.errors.CheckViolation):
        as_(api, w, w.finance, "update pulse.erp_document set estimate=-1 where id=%s", (did,))


def invoice_with_transport(api, w, n, confirmed=False, not_needed=False):
    with api.transaction():
        set_tenant(api, w.org, w.finance)
        inv = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,created_by)
            values(%s,'invoice','2026-11-20',%s,%s,'27','intra',100000,9000,9000,0,118000,%s) returning id""", (w.org, Jsonb(SELLER), Jsonb(BUYER), w.finance)).fetchone()["id"]
        for i, (desc, rate, charge) in enumerate((("Synthetic inverter", 100000, None), ("Transport", 650000, "variable"))):
            api.execute("""insert into pulse.erp_line(org_id,document_id,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total,charge,confirmed,not_needed)
                values(%s,%s,%s,%s,1,%s,18,%s,0,0,0,%s,%s,%s,%s)""", (w.org, inv, i, desc, rate, rate, rate, charge, bool(charge) and confirmed, bool(charge) and not_needed))
    return inv, f"update pulse.erp_document set status='issued',number='SYN-{n}',fy='2026-27',issued_at=now() where id=%s"


def test_an_invoice_with_an_estimate_is_not_issued(api, erp):  # noqa: F811
    w = erp
    inv, issue = invoice_with_transport(api, w, 1)
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Confirm each charge"):
        as_(api, w, w.finance, issue, (inv,))
    # Marked not needed, or confirmed, it no longer stops the invoice (whatever else the issue path checks).
    for n, flags in ((2, {"not_needed": True}), (3, {"confirmed": True})):
        inv, issue = invoice_with_transport(api, w, n, **flags)
        try:
            as_(api, w, w.finance, issue, (inv,))
        except psycopg.Error as e:
            assert "Confirm each charge" not in str(e)


def test_change_cards_stay_in_their_company_and_with_billing(worker, owner, api, erp):  # noqa: F811
    w = erp
    did = draft(api, w, w.finance, [("Synthetic inverter", 100000, None, False, False)])
    change = Jsonb([{"op": "remove", "line": 1, "expect": "Synthetic inverter", "text": "Take off Synthetic inverter"}])
    insert = "insert into pulse.erp_quote_proposal(org_id,document_id,changes,before_total,after_total,created_by) values(%s,%s,%s,118000,0,%s) returning id"
    pid = one(api, w, w.finance, insert, (w.org, did, change, w.finance))["id"]
    assert one(api, w, w.finance, "select status from pulse.erp_quote_proposal where id=%s", (pid,))["status"] == "pending"
    # A member without Billing sees none and adds none; another company sees none.
    assert one(api, w, w.member, "select count(*) n from pulse.erp_quote_proposal")["n"] == 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.member, insert, (w.org, did, change, w.member))
    other = build_world(worker, owner, api)
    with api.transaction():
        set_tenant(api, other.org)
        assert api.execute("select count(*) n from pulse.erp_quote_proposal").fetchone()["n"] == 0
    # Decided means decided at a time; an empty card is refused.
    with pytest.raises(psycopg.errors.CheckViolation):
        as_(api, w, w.finance, "update pulse.erp_quote_proposal set status='applied' where id=%s", (pid,))
    with pytest.raises(psycopg.errors.CheckViolation):
        as_(api, w, w.finance, insert, (w.org, did, Jsonb([]), w.finance))
    # The card goes with its document.
    as_(api, w, w.finance, "delete from pulse.erp_line where document_id=%s", (did,))
    as_(api, w, w.finance, "delete from pulse.erp_document where id=%s", (did,))
    assert one(api, w, w.finance, "select count(*) n from pulse.erp_quote_proposal where id=%s", (pid,))["n"] == 0


def test_the_builder_routes_and_their_telemetry(worker, owner, api, erp):  # noqa: F811
    w = erp
    _seed_erp_world(worker, w)   # Workspace accounts founder@ and finance@ the domain
    inverter, solar = uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        for iid, name, price, cost in ((inverter, "Synthetic hybrid inverter 5 kVA", 11000000, 9000000), (solar, "Synthetic PUREPower 5 kW solar system", 38500000, 30000000)):
            worker.execute("insert into pulse.erp_item(id,org_id,kind,name,unit,price,cost,gst_rate,status) values(%s,%s,'product',%s,'nos',%s,%s,18,'active')",
                           (iid, w.org, name, price, cost))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config),
           "TEST_W": json.dumps({"org": str(w.org), "finance": str(w.finance), "domain": w.domain, "inverter": str(inverter), "solar": str(solar)})}
    result = subprocess.run(["node", "test/quote-builder-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                            env=env, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    with owner.transaction():
        set_tenant(owner, w.org)
        rows = owner.execute("""select kind,coalesce(detail->>'step','') step,detail from pulse.telemetry_event
            where source='server' and kind like 'billing.%%' order by id""").fetchall()
    seen = {(r["kind"], r["step"]) for r in rows}
    for want in (("billing.price_override", ""), ("billing.variable_charge", "added"), ("billing.variable_charge", "confirmed"),
                 ("billing.ai_proposal", "proposed"), ("billing.ai_proposal", "applied"), ("billing.ai_proposal", "dismissed")):
        assert want in seen, (want, seen)
    override = next(r["detail"] for r in rows if r["kind"] == "billing.price_override")
    assert override["by"] == "person" and override["base"] == 11000000 and override["rate"] == 10450000 and override["note"] is True
    assert "Festive" not in json.dumps([r["detail"] for r in rows]), "amounts only, never a note or a description"
