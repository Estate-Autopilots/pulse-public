"""QUOTE-LINES (0545, EST-1236): a document line can be an add-on of another line of the same document (removing the main
line removes it), an open amount, or not needed; an item lists its usual add-ons, written by Billing writers only and
only from the same company's catalogue. Synthetic tenants, people, items and figures only."""
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import (  # noqa: F401  (erp is a fixture)
    BUYER,
    SELLER,
    as_,
    erp,
    one,
)


def test_quote_line_routes_preserve_catalogue_rate_and_saved_line_flags(worker, api, erp):  # noqa: F811
    w = erp
    system, addon = (item(api, w, w.finance, name) for name in ("Synthetic system", "Synthetic add-on"))
    did = draft(api, w, w.finance, [("Synthetic system", 100000, None, False, False)])
    as_(api, w, w.finance, "update pulse.erp_line set item_id=%s,catalogue_rate=100000 where document_id=%s", (system, did))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                       (w.org, f"finance@{w.domain}", w.finance))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"document": str(did), "item": str(system), "addon": str(addon), "domain": w.domain})}
    result = subprocess.run(["node", "test/quote-lines-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                            env=env, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    assert one(api, w, w.finance, "select catalogue_rate from pulse.erp_line where document_id=%s and position=0", (did,))["catalogue_rate"] == 100000


def draft(api, w, who, lines):
    """A quotation draft with [(description, rate, parent_position, open, not_needed)] lines at 18%, figures not checked here."""
    with api.transaction():
        set_tenant(api, w.org, who)
        did = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,created_by)
            values(%s,'quotation','2026-10-18',%s,%s,'27','intra',0,0,0,0,0,%s) returning id""", (w.org, Jsonb(SELLER), Jsonb(BUYER), who)).fetchone()["id"]
        for i, (desc, rate, parent, open_, not_needed) in enumerate(lines):
            api.execute("""insert into pulse.erp_line(org_id,document_id,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total,parent_position,open,not_needed)
                values(%s,%s,%s,%s,1,%s,18,%s,0,0,0,%s,%s,%s,%s)""", (w.org, did, i, desc, rate, rate, rate, parent, open_, not_needed))
    return did


def lines(api, w, who, did):
    return [(r["position"], r["parent_position"], r["open"], r["not_needed"]) for r in
            as_(api, w, who, "select position,parent_position,open,not_needed from pulse.erp_line where document_id=%s order by position", (did,))]


def test_an_add_on_points_at_a_line_of_its_own_document_and_goes_with_it(api, erp):  # noqa: F811
    w = erp
    did = draft(api, w, w.finance, [("Synthetic 15 kW system", 37999900, None, False, False), ("Synthetic dongle", 250000, 0, False, False),
                                    ("Installation", 0, None, True, False), ("Transport", 0, None, True, True)])
    assert lines(api, w, w.finance, did) == [(0, None, False, False), (1, 0, False, False), (2, None, True, False), (3, None, True, True)]
    # A parent position that is not a line of this document is refused at commit; so is a line that is its own add-on.
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        as_(api, w, w.finance, "update pulse.erp_line set parent_position=9 where document_id=%s and position=1", (did,))
    with pytest.raises(psycopg.errors.CheckViolation):
        as_(api, w, w.finance, "update pulse.erp_line set parent_position=1 where document_id=%s and position=1", (did,))
    # Removing the main line removes its add-on; the others stay.
    as_(api, w, w.finance, "delete from pulse.erp_line where document_id=%s and position=0", (did,))
    assert lines(api, w, w.finance, did) == [(2, None, True, False), (3, None, True, True)]


def test_a_save_that_replaces_all_lines_may_insert_an_add_on_before_its_main_line(api, erp):  # noqa: F811
    """The API deletes and reinserts a draft's lines; the deferred key only checks the pair at commit."""
    w = erp
    did = draft(api, w, w.finance, [("Synthetic system", 100000, None, False, False)])
    with api.transaction():
        set_tenant(api, w.org, w.finance)
        api.execute("delete from pulse.erp_line where document_id=%s", (did,))
        for pos, parent in ((1, 0), (0, None)):
            api.execute("""insert into pulse.erp_line(org_id,document_id,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total,parent_position)
                values(%s,%s,%s,'Synthetic line',1,100,18,100,0,0,0,100,%s)""", (w.org, did, pos, parent))
    assert lines(api, w, w.finance, did) == [(0, None, False, False), (1, 0, False, False)]


def item(api, w, who, name, kind="product", price=100000):
    return one(api, w, who, "insert into pulse.erp_item(org_id,kind,name,unit,price,status) values(%s,%s,%s,'nos',%s,'active') returning id", (w.org, kind, name, price))["id"]


def test_usual_add_ons_belong_to_the_same_catalogue_and_only_billing_writers_change_them(api, worker, owner, erp):  # noqa: F811
    w = erp
    system, dongle, acdb = (item(api, w, w.finance, n) for n in ("Synthetic system", "Synthetic dongle", "Synthetic ACDB"))
    for n, addon in enumerate((dongle, acdb)):
        as_(api, w, w.finance, "insert into pulse.erp_item_addon(org_id,item_id,addon_id,position) values(%s,%s,%s,%s)", (w.org, system, addon, n))
    rows = as_(api, w, w.finance, "select addon_id from pulse.erp_item_addon where item_id=%s order by position", (system,))
    assert [r["addon_id"] for r in rows] == [dongle, acdb]
    # Not its own add-on.
    with pytest.raises(psycopg.errors.CheckViolation):
        as_(api, w, w.finance, "insert into pulse.erp_item_addon(org_id,item_id,addon_id,position) values(%s,%s,%s,2)", (w.org, system, system))
    # Another company's item is refused even though RLS would not show it.
    other = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, other.org)
        foreign = worker.execute("insert into pulse.erp_item(org_id,kind,name,status) values(%s,'product','Other synthetic item','active') returning id", (other.org,)).fetchone()["id"]
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        as_(api, w, w.finance, "insert into pulse.erp_item_addon(org_id,item_id,addon_id,position) values(%s,%s,%s,2)", (w.org, system, foreign))
    # A member without Billing access sees none and writes none; the other company sees none.
    assert one(api, w, w.member, "select count(*) n from pulse.erp_item_addon")["n"] == 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.member, "insert into pulse.erp_item_addon(org_id,item_id,addon_id,position) values(%s,%s,%s,3)", (w.org, dongle, acdb))
    with api.transaction():
        set_tenant(api, other.org)
        assert api.execute("select count(*) n from pulse.erp_item_addon").fetchone()["n"] == 0
