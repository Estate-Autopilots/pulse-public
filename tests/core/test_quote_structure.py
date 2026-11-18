"""QUOTE-STRUCT (2252; Kazuk's "Phase-wise Package Editing: Build Guide", 16 Nov 2026): a company's phases, an item's phase
and Included flag, a quotation line's phase, free-line role and package, and cost and margin that a sales seat never sees.
Synthetic tenants, people, items and figures only."""
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import (  # noqa: F401  (erp is a fixture)
    as_,
    draft,
    erp,
    issue,
    one,
    person,
)

PHASES = [{"key": "plan", "name": "Phase 1: Plan", "groups": []}, {"key": "make", "name": "Phase 2: Make", "groups": ["Attention", "Trust"]}]


def test_phases_items_and_part_lines_are_kept(api, owner, erp):  # noqa: F811
    w = erp
    one(api, w, w.founder, "update pulse.erp_settings set phases=%s returning org_id", (Jsonb(PHASES),))
    assert one(api, w, w.finance, "select phases from pulse.erp_settings")["phases"] == PHASES
    with pytest.raises(psycopg.errors.CheckViolation):
        one(api, w, w.founder, "update pulse.erp_settings set phases=%s returning org_id", (Jsonb({"not": "a list"}),))
    pkg = one(api, w, w.founder, "insert into pulse.erp_item(org_id,kind,name,price,gst_rate,status) values(%s,'package','Synthetic bundle',4620000,18,'active') returning id", (w.org,))["id"]
    item = one(api, w, w.founder, """insert into pulse.erp_item(org_id,kind,name,sac,unit,price,gst_rate,status,phase,phase_group)
        values(%s,'service','Synthetic video ad','998361','nos',2100000,18,'active','make','Attention') returning id""", (w.org,))["id"]
    free = one(api, w, w.founder, "insert into pulse.erp_item(org_id,kind,name,price,gst_rate,status,phase,included) values(%s,'service','Synthetic first test',0,18,'active','make',true) returning included", (w.org,))
    assert free["included"] is True
    with pytest.raises(psycopg.errors.CheckViolation):
        one(api, w, w.founder, "insert into pulse.erp_item(org_id,kind,name,price,gst_rate,phase) values(%s,'service','Bad phase key',1,18,'Phase 1') returning id", (w.org,))
    # A quotation's part lines: the phase heading, the package and its default, a free line priced at nothing.
    q = draft(api, w, w.finance, "quotation", taxable=4200000, client=w.client)
    one(api, w, w.finance, """update pulse.erp_line set item_id=%s,qty=2,rate=2100000,phase='Phase 2: Make',phase_order=1,phase_group='Attention',package_id=%s,package_label='Synthetic bundle',
        package_default=%s where document_id=%s and position=0 returning id""", (item, pkg, Jsonb({"qty": 2, "rate": 2100000, "itemId": str(item)}), q))
    one(api, w, w.finance, """insert into pulse.erp_line(org_id,document_id,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total,line_role,list_rate,package_id)
        values(%s,%s,1,'Synthetic partner kit',1,0,18,0,0,0,0,0,'bonus',1000000,%s) returning id""", (w.org, q, pkg))
    with pytest.raises(psycopg.errors.CheckViolation):
        one(api, w, w.finance, """insert into pulse.erp_line(org_id,document_id,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total,line_role)
            values(%s,%s,2,'Priced and included',1,100,18,100,9,9,0,118,'included') returning id""", (w.org, q))
    with pytest.raises(psycopg.errors.CheckViolation):
        one(api, w, w.finance, """insert into pulse.erp_line(org_id,document_id,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total,line_role)
            values(%s,%s,2,'Unknown role',1,0,18,0,0,0,0,0,'gift') returning id""", (w.org, q))
    # Issuing keeps the lines as they are (the number and the filed copy follow as for any quotation).
    assert issue(api, w, w.finance, q)
    rows = as_(api, w, w.finance, "select phase,phase_group,line_role,package_id,package_default->>'qty' dq,list_rate from pulse.erp_line where document_id=%s order by position", (q,))
    assert [(r["phase"], r["phase_group"], r["line_role"], r["package_id"], r["dq"], r["list_rate"]) for r in rows] == [
        ("Phase 2: Make", "Attention", None, pkg, "2", None), (None, None, "bonus", pkg, None, 1000000)]
    # Revising the issued quotation keeps the snapshot of its lines with the new fields, and undoing restores them.
    one(api, w, w.finance, "select pulse.erp_quote_revise(%s,%s) r", (q, "Synthetic scope change"))
    one(api, w, w.finance, "update pulse.erp_line set qty=3 where document_id=%s and position=0 returning id", (q,))
    one(api, w, w.finance, "select pulse.erp_quote_revise_undo(%s) r", (q,))
    back = as_(api, w, w.finance, "select qty::float8 qty,phase,line_role from pulse.erp_line where document_id=%s order by position", (q,))
    assert [(r["qty"], r["phase"], r["line_role"]) for r in back] == [(2.0, "Phase 2: Make", None), (1.0, None, "bonus")]
    # Phases are one company's: another seat in another company never reads them (tenant policy as for every erp table).
    assert one(api, w, w.member, "select count(*)::int n from pulse.erp_settings where phases <> '[]'")["n"] == 0


def test_a_sales_seat_never_sees_cost_whatever_the_setting(api, owner, worker, erp):  # noqa: F811
    w = erp
    sales = person(worker, w, "Synthetic Salesperson", "sales")
    head = person(worker, w, "Synthetic Sales Head", "sales_head")
    for setting, expect in (("everyone", {"founder": True, "finance": True, "sales": False, "head": False}),
                            ("finance", {"founder": True, "finance": True, "sales": False, "head": False}),
                            ("owner", {"founder": True, "finance": False, "sales": False, "head": False})):
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute("update pulse.erp_settings set cost_visibility=%s", (setting,))
        seen = {k: one(api, w, who, "select pulse.erp_sees_cost() s")["s"] for k, who in (("founder", w.founder), ("finance", w.finance), ("sales", sales), ("head", head))}
        assert seen == expect, setting


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_a_package_opens_phase_by_phase_in_the_browser(api, worker, erp):  # noqa: F811
    """services/api/test/quote-structure-browser-runner.mjs: Billing settings' phases, a package opened into its parts in
    the composer (one unticked, one +1), the PDF, and the package page as leadership and as a salesperson, at 1440 and 363
    (PULSE_QS_SCREENSHOTS=<dir> keeps the shots and the PDF)."""
    w = erp
    sales = person(worker, w, "Synthetic Salesperson", "sales")
    with worker.transaction():
        set_tenant(worker, w.org)
        for who, mail in ((w.founder, f"founder@{w.domain}"), (sales, f"sales@{w.domain}")):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, mail, who))
    phases = [{"key": "plan", "name": "Phase 1: Plan", "groups": []}, {"key": "make", "name": "Phase 2: Make", "groups": ["Attention", "Trust"]},
              {"key": "run", "name": "Phase 3: Run", "groups": []}]
    one(api, w, w.founder, "update pulse.erp_settings set phases=%s,cost_visibility='owner' returning org_id", (Jsonb(phases),))

    def item(name, price, phase, group=None, unit="nos", cost=None, included=False):
        return one(api, w, w.founder, """insert into pulse.erp_item(org_id,kind,name,sac,unit,price,gst_rate,status,phase,phase_group,cost,included)
            values(%s,'service',%s,'998361',%s,%s,18,'active',%s,%s,%s,%s) returning id""", (w.org, name, unit, price, phase, group, cost, included))["id"]
    study = item("Synthetic market study", 420000, "plan", cost=116000)
    align = item("Synthetic alignment session", 180000, "plan", cost=50000)
    video = item("Synthetic video ad (standard)", 3350500, "make", "Attention", cost=957300)
    item("Synthetic video ad (luxury)", 6125000, "make", "Attention", cost=1750000)
    test = item("Synthetic first test", 0, "make", "Attention", included=True)
    page = item("Synthetic landing page", 1370200, "make", "Trust", cost=203910)
    ads = item("Synthetic ads and nurturing", 700000, "run", unit="month", cost=200000)
    kit = item("Synthetic partner kit", 1000000, None)
    pkg = one(api, w, w.founder, "insert into pulse.erp_item(org_id,kind,name,description,sac,price,gst_rate,status) values(%s,'package','Synthetic Growth bundle','your team and your ad spend stay yours','998361',0,18,'active') returning id",
              (w.org,))["id"]
    parts = [(study, "Synthetic market study", 1, 420000, 116000), (align, "Synthetic alignment session", 1, 180000, None), (video, "Synthetic video ad (standard)", 2, 3350500, None),
             (test, "Synthetic first test", 1, None, None), (page, "Synthetic landing page", 1, 1370200, None), (ads, "Synthetic ads and nurturing", 4, 700000, None),
             (kit, "Synthetic partner kit", 1, 0, None), (None, "Synthetic coaching", 1, None, None)]
    for n, (iid, label, qty, price, cost) in enumerate(parts):
        one(api, w, w.founder, "insert into pulse.erp_package_part(org_id,package_id,position,item_id,label,quantity,price,cost) values(%s,%s,%s,%s,%s,%s,%s,%s) returning id",
            (w.org, pkg, n, iid, label, qty, price, cost))
    total = 420000 + 180000 + 2 * 3350500 + 1370200 + 4 * 700000
    one(api, w, w.founder, "update pulse.erp_item set price=%s where id=%s returning id", (total, pkg))
    doc = draft(api, w, w.founder, "quotation", taxable=100000, client=w.client)
    one(api, w, w.founder, "delete from pulse.erp_line where document_id=%s returning id", (doc,))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"org": str(w.org), "docs": [str(doc)], "package": str(pkg), "packageName": "Synthetic Growth bundle", "partsTotal": "₹1,14,712"}),
           "TEST_EMAILS": json.dumps({"founder": f"founder@{w.domain}", "sales": f"sales@{w.domain}"})}
    p = subprocess.run(["node", "test/quote-structure-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=2400, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    rows = as_(api, w, w.founder, """select description,qty::float8 qty,rate,not_needed,line_role,phase,phase_group,package_id,package_default is not null has_default
        from pulse.erp_line where document_id=%s order by position""", (doc,))
    got = {r["description"]: r for r in rows}
    assert len(rows) == 8 and all(r["package_id"] == pkg and r["has_default"] for r in rows)
    assert got["Synthetic alignment session"]["not_needed"] is True
    assert got["Synthetic video ad (standard)"]["qty"] == 3.0 and got["Synthetic video ad (standard)"]["phase_group"] == "Attention"
    assert (got["Synthetic first test"]["line_role"], got["Synthetic partner kit"]["line_role"], got["Synthetic coaching"]["line_role"]) == ("included", "bonus", "to_quote")
    assert got["Synthetic ads and nurturing"]["phase"] == "Phase 3: Run" and got["Synthetic ads and nurturing"]["qty"] == 4.0
    # The catalogue's package is unchanged by the quotation.
    assert one(api, w, w.founder, "select count(*)::int n,sum(quantity)::float8 q from pulse.erp_package_part where package_id=%s", (pkg,)) == {"n": 8, "q": 12.0}
