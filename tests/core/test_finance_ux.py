"""UX-FINANCE (owner, 5 Nov 2026: "there is no UX/UI improvement in anything: billing, finance, work"): every Finance
screen and My sales in the browser at 390 and 1440 px, light and dark, on a disposable synthetic company with invoices
paid over several months, Cash book lines and an invented live finance model (tests/e2e/fixtures/finance-live.json).
services/api/test/finance-ux-browser.mjs; PULSE_FUX_SHOTS=<dir> also writes the screens. Synthetic data only."""
import json
import os
import subprocess
from pathlib import Path

import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import (
    as_,
    draft,
    erp,  # noqa: F401  (a fixture)
    issue,
    one,
)
from test_finance_truth import GST, books, pay  # noqa: F401  (books is a fixture)

ROOT = Path(__file__).resolve().parents[2]


def seed(worker, api, w):
    as_(api, w, w.founder, "select pulse.finance_gst_account_set(%s)", (GST,))
    # Four months of invoices: each base paid into HDFC, the GST into the GST account a little later; the last one open.
    for n, (day, taxable, paid_on, gst_on) in enumerate((("2026-07-04", 24000000, "2026-07-20", "2026-08-02"), ("2026-08-06", 31000000, "2026-08-25", "2026-09-04"),
                                                         ("2026-09-03", 28000000, "2026-09-21", None), ("2026-10-08", 36000000, None, None))):
        q = draft(api, w, w.finance, "quotation", taxable=taxable, day=day, client=w.client)
        as_(api, w, w.finance, "update pulse.erp_document set salesperson_id=%s where id=%s", (w.sales, q))
        issue(api, w, w.finance, q)
        inv = draft(api, w, w.finance, taxable=taxable, day=day, client=w.client)
        as_(api, w, w.finance, "update pulse.erp_document set source_id=%s where id=%s", (q, inv))
        issue(api, w, w.finance, inv)
        if paid_on:
            pay(api, w, inv, taxable, paid_on, "HDFC current")
        if gst_on:
            pay(api, w, inv, taxable * 18 // 100, gst_on, GST)
        if n == 3:
            one(api, w, w.finance, "select pulse.erp_document_mark(%s,'sent') s", (inv,))
    with api.transaction():
        set_tenant(api, w.org, w.founder)
        for day, amount, gst, category, vendor in (
                ("2026-07-28", 9500000, 0, "Salaries", None), ("2026-08-28", 9800000, 0, "Salaries", None), ("2026-09-28", 10200000, 0, "Salaries", None),
                ("2026-10-28", 10400000, 0, "Salaries", None), ("2026-07-05", 4500000, 0, "Rent", "Synthetic Estates"), ("2026-08-05", 4500000, 0, "Rent", "Synthetic Estates"),
                ("2026-09-05", 4500000, 0, "Rent", "Synthetic Estates"), ("2026-10-05", 4500000, 0, "Rent", "Synthetic Estates"),
                ("2026-08-12", 1180000, 180000, "Software & tools", "Invented Cloud"), ("2026-10-14", 1416000, 216000, "Software & tools", "Invented Cloud"),
                ("2026-09-18", 650000, 0, None, "Unsorted vendor")):
            api.execute("insert into pulse.fin_entry(org_id,kind,direction,entry_date,amount_minor,gst_minor,category,vendor,account_from,created_by) "
                        "values(%s,'expense','out',%s,%s,%s,%s,%s,'HDFC current',%s)", (w.org, day, amount, gst, category, vendor, w.founder))
        api.execute("insert into pulse.fin_entry(org_id,kind,direction,entry_date,amount_minor,category,account_to,created_by) "
                    "values(%s,'income','in','2026-10-30',2500000,'Other income','Cash',%s)", (w.org, w.founder))
    live = json.loads((ROOT / "tests/e2e/fixtures/finance-live.json").read_text())
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse_priv.finance_live_model(org_id,body) values(%s,%s)", (w.org, Jsonb(live["model"])))
        for handle, who in (("founder", w.founder), ("finance", w.finance), ("sales", w.sales), ("member", w.member)):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, f"{handle}@{w.domain}", who))


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1 (it needs a web build or NEXT_MODE=dev)")
def test_finance_screens_in_the_browser(worker, owner, api, books, tmp_path):  # noqa: F811
    """Every Finance screen and My sales at 390 and 1440, light and dark: one heading, no page errors, no sideways scroll
    on a phone, one primary action where there is one, focus that shows."""
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    seed(worker, api, books)
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config), "TEST_REPORT": str(tmp_path / "fux.json"),
           "TEST_EMAILS": json.dumps({k: f"{k}@{books.domain}" for k in ("founder", "finance", "sales", "member")})}
    result = subprocess.run(["node", "test/finance-ux-browser.mjs"], cwd=ROOT / "services/api", env=env, capture_output=True, text=True, timeout=3000, check=False)
    print(result.stdout[-6000:])
    assert result.returncode == 0, (result.stdout + result.stderr)[-8000:]
    got = json.loads((tmp_path / "fux.json").read_text())
    assert got["loose"] or got["checks"] >= 100, got
