"""UX-BILLING (owner, 5 Nov 2026: "there is no UX/UI improvement in anything: billing, finance, work"): every Billing screen
(home, documents, a new quotation, the editor, approval, revisions, invoices, payments, the catalogue, stock, templates,
settings and the log) through the real API and the built web app at 390 and 1440 px, light and dark, held to the Work →
My day standard (services/api/test/billing-ux-runner.mjs). Synthetic tenant, people, clients, products and figures only."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest
from pulse_sdk.db import set_tenant
from test_erp_invoice import _seed_erp_world, as_, erp  # noqa: F401  (fixture)

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_billing_screens_meet_the_my_day_standard(worker, owner, api, erp, tmp_path):  # noqa: F811
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = erp
    ids = _seed_erp_world(worker, w)
    asohiv = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Asohiv Mifos','client')", (asohiv, w.org))
        worker.execute("insert into pulse.contact_profile(org_id,person_id,email,phone,city) values(%s,%s,'asohiv@synthetic.example','+91 98765 43210','Nagpur')", (w.org, asohiv))
    as_(api, w, w.founder, "update pulse.erp_settings set inventory_enabled=true,quote_approval=true")

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "TEST_ORG": str(w.org),
           "TEST_EMAILS": json.dumps({k: f"{k}@{w.domain}" for k in ("founder", "finance", "member")}),
           "TEST_IDS": json.dumps({k: str(v) for k, v in {**ids, "finance": w.finance, "founder": w.founder, "asohiv": asohiv}.items()}),
           "PULSE_BILLING_UX_REPORT": str(tmp_path / "billing-ux.json")}
    timeout = 6 * 3600 if env.get("PULSE_BILLING_UX_HOLD") else 2400
    p = subprocess.run(["node", "test/billing-ux-runner.mjs"], cwd=ROOT / "services/api", env=env, capture_output=True, text=True, timeout=timeout, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-8000:]
    report = json.loads((tmp_path / "billing-ux.json").read_text())
    assert report["apiChecks"] >= 40
    if env.get("PULSE_BILLING_UX_CHECKS") != "0" and not env.get("PULSE_BILLING_UX_HOLD"):
        assert report["browserChecks"] >= 150
