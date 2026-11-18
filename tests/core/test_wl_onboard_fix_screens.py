"""WL-ONBOARD-FIX (17 Nov 2026): the screens this lane changed, in the browser at 363 and 1440 px, light and dark, on a
disposable synthetic company: Chats' "AI helpers you can ask", the empty cash book's first-run card, Get the app's Chrome
card, and the price list import with a Stock column (preview, then the import with stock before and after, then Undo).
services/api/test/wl-onboard-fix-screens.mjs; PULSE_WLOF_SHOTS=<dir> writes the screenshots. Everything is invented."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest
from pulse_sdk.db import set_tenant
from test_erp_invoice import as_, erp, one  # noqa: F401  (erp is a fixture)
from test_finance_truth import books  # noqa: F401  (books is a fixture)

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run with PULSE_AUTH_BROWSER=1")
def test_wl_onboard_fix_screens_in_the_browser(worker, owner, api, books, tmp_path):  # noqa: F811
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = books
    ai = uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Quotes helper','agent')", (ai, w.org))
        owner.execute("""insert into pulse.agent_member(org_id,person_id,owner_person_id,employee_no,employee_id,title)
            values(%s,%s,%s,1,'TST-AI-001','Quotations, approvals and finance follow-ups')""", (w.org, ai, w.founder))
        owner.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,user_no,username) values(%s,%s,'AI','test',91,'quotes.helper')", (w.org, ai))
    with worker.transaction():
        set_tenant(worker, w.org)
        for handle, who in (("founder", w.founder), ("finance", w.finance)):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, f"{handle}@{w.domain}", who))
    # A stock-tracked item with 4 on the shelf, so the import shows its stock before and after.
    as_(api, w, w.finance, "update pulse.erp_settings set inventory_enabled=true")
    item = one(api, w, w.finance, """insert into pulse.erp_item(org_id,kind,name,unit,price,gst_rate,status,track_stock,created_by,updated_by)
        values(pulse.current_org(),'product','TEST battery 12','nos',36190381,5,'active',true,pulse.current_viewer(),pulse.current_viewer()) returning id""")["id"]
    as_(api, w, w.finance, "select pulse.erp_stock_set(%s, 4, null, 'Opening count')", (item,))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config), "TEST_REPORT": str(tmp_path / "wlof.json"),
           "TEST_EMAILS": json.dumps({k: f"{k}@{w.domain}" for k in ("founder", "finance")})}
    result = subprocess.run(["node", "test/wl-onboard-fix-screens.mjs"], cwd=ROOT / "services/api", env=env, capture_output=True, text=True, timeout=3000, check=False)
    print(result.stdout[-4000:])
    assert result.returncode == 0, (result.stdout + result.stderr)[-8000:]
    got = json.loads((tmp_path / "wlof.json").read_text())
    assert got["checks"] >= 30, got
    on_hand = one(api, w, w.finance, "select pulse.erp_on_hand(%s) n", (item,))["n"]
    assert int(on_hand) == 4, "every import was undone: the count is back to 4"
