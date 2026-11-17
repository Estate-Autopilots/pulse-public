"""BHARATA-2 (16 Nov 2026): draft_quotation (POST /api/v1/billing/quotations/from-words) on real PostgreSQL and tenant row
security, through services/api/test/bharata-draft-words-runner.mjs: a quotation from words (client found, added, or a
sound-alike taken), the catalogue matched on the server, an identical draft reused, a voice note's new client confirmed
first, a missing price or size asked instead of guessed, "same as last time" copied from the last approved quotation,
a draft changed and submitted. Synthetic people, products and prices only; nothing leaves the machine."""
import json
import os
import subprocess
import uuid
from pathlib import Path

from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_erp_invoice import _seed_erp_world, erp, one  # noqa: F401  (erp is a fixture)

CATALOGUE = [  # code, name, price (paise), gst
    ("TS-3.0", "TEST Sunbox 3.0 kW solar system", 9500000, 5), ("TS-5.0", "TEST Sunbox 5.0 kW solar system", 14000000, 5),
    ("TS-12.0", "TEST Sunbox 12.0 kW solar system", 31000000, 5), ("AO-EXW7-5.0", "Extended warranty (+7 years) for TEST Sunbox 5.0", 1800000, 18),
    ("AO-EXW7-3.0", "Extended warranty (+7 years) for TEST Sunbox 3.0", 1200000, 18), ("AO-ACDB-5.0", "ACDB for TEST Sunbox 5.0", 450000, 18),
    ("SV-INSTALL", "Installation & commissioning", 1250000, 18), ("SV-DELIVERY", "Delivery & transport", 0, 18),
]


def test_draft_quotation_from_words(worker, owner, api, erp):  # noqa: F811
    w = erp
    _seed_erp_world(worker, w)   # Workspace accounts founder@ (leadership) and finance@ the domain
    items, desai = {}, uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        for code, name, price, gst in CATALOGUE:
            items[code] = uuid.uuid4()
            worker.execute("insert into pulse.erp_item(id,org_id,kind,code,name,price,gst_rate,status) values(%s,%s,'product',%s,%s,%s,%s,'active')",
                           (items[code], w.org, code, name, price, gst))
        worker.execute("insert into pulse.client(id,org_id,display_name,city) values(%s,%s,'TEST Desai Dairy','Kolhapur')", (desai, w.org))

    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "PULSE_PUBLIC_URL": "https://pulse.synthetic.example", "TEST_API_CONFIG": json.dumps(config),
           "TEST_W": json.dumps({"org": str(w.org), "founder": str(w.founder), "founderEmail": f"founder@{w.domain}", "financeEmail": f"finance@{w.domain}",
                                 "desai": str(desai), "items": {k: str(v) for k, v in items.items()}})}
    p = subprocess.run(["node", "test/bharata-draft-words-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=300)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    out = json.loads([line for line in p.stdout.splitlines() if line.startswith('{"ok"')][-1])
    assert out["checks"] >= 40, out

    # What the database holds: one client added (Mifos), none for the voice note before its name was confirmed.
    names = set(one(api, w, w.founder, "select coalesce(json_agg(display_name),'[]'::json) n from pulse.client", ())["n"])
    assert "TEST Mifos Traders" in names and "TEST Gokhale Clinic" in names and "TEST Desideri" not in names, names
