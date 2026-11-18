"""AGREEMENTS round 3 (owner, 14 Nov 2026: "quote → accepted → agreement → invoice"): one chain, read from the quotation,
the agreement or the invoice. The client accepts the quotation, the agreement is made from it (CONTRACTS-2), both sides
sign it, and Finance makes the invoice from the quotation (Billing's own draft: lines, prices and GST carry over), linked
to the agreement; a retry opens the same invoice. Round 4: the flow is eight steps (lead, quote, agreement sent, client
reviews, both accept, monthly invoice, onboarding, live); onboarding is the project and tasks from the quotation, and the
client is live when every onboarding task is done. A member sees no chain. Synthetic company, client and figures only."""
import json
import os
import subprocess
from pathlib import Path

import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_billing_flow import _issued_quote
from test_comp import _api_world
from test_contract_signing import BUYER, PNG, signed_out, template, token
from test_erp_invoice import setup_company


def _runner(stage, config, w, **ids):
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(w.org), "STAGE": stage, "PULSE_CI": "1",
           **{k.upper(): str(v) for k, v in ids.items()}}
    p = subprocess.run(["node", "test/agreement-chain-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       text=True, capture_output=True, timeout=300, check=False)
    assert p.returncode == 0, (stage + "\n" + p.stdout + "\n" + p.stderr)[-6000:]
    line = next((x for x in p.stdout.splitlines() if x.startswith("CHAIN ")), None)
    return json.loads(line[6:]) if line else {}


def test_quotation_to_agreement_to_invoice(worker, owner, api):
    w, roles, config, _ = _api_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'finance','2020-01-01')", (w.org, roles["admin"]))
    setup_company(api, w, roles["founder"])
    fin = roles["admin"]
    template(api, w, fin)
    quote = _issued_quote(api, w, fin, BUYER)

    _runner("issued", config, w, quote=quote)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.erp_document set status='accepted' where id=%s", (quote,))
    cid = _runner("accepted", config, w, quote=quote)["contractId"]

    # Both sides sign: the client through the link, Finance inside Vitals OS (the signing functions CONTRACTS-2 tests).
    def one(sql, args=()):
        with api.transaction():
            set_tenant(api, w.org, fin)
            return api.execute(sql, args).fetchone()
    client = one("select party_key k from pulse.contract_party where contract_id=%s and role='client'", (cid,))["k"]
    _, h = token()
    one("select pulse.contract_send_to_sign(%s,%s,%s,14,'diya@example.test','Diya Nair (synthetic)') r", (cid, client, h))
    signed_out(api, w.org, "select pulse.contract_sign_act(%s,%s,%s,'Synthetic phone') r",
               (h, Jsonb({"action": "sign", "name": "Diya Nair (synthetic)", "kind": "drawn", "image": PNG, "agree": True}), "c" * 64))
    assert one("select pulse.contract_sign_here(%s,%s) s", (cid, Jsonb({"name": "Synthetic Admin", "kind": "typed", "agree": True})))["s"] == "active"

    out = _runner("signed", config, w, quote=quote, contract=cid)
    inv, project = out["invoiceId"], out["projectId"]
    with owner.transaction():
        set_tenant(owner, w.org)
        d = owner.execute("select doc_type, status, source_id, total from pulse.erp_document where id=%s", (inv,)).fetchone()
        assert (d["doc_type"], d["status"], str(d["source_id"])) == ("invoice", "draft", str(quote))
        assert owner.execute("select count(*) n from pulse.erp_document where doc_type='invoice' and source_id=%s", (quote,)).fetchone()["n"] == 1
        assert owner.execute("select count(*) n from pulse.contract_link where contract_id=%s and erp_document_id=%s", (cid, inv)).fetchone()["n"] == 1
        assert owner.execute("select count(*) n from pulse.contract_link where contract_id=%s and project_id=%s", (cid, project)).fetchone()["n"] == 1
        # The onboarding team finishes its one task: the client is live.
        owner.execute("update pulse.task set status='done' where project_id=%s", (project,))
    _runner("live", config, w, quote=quote)


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser flows need PULSE_AUTH_BROWSER=1 (and Playwright's Chromium)")
def test_agreement_chain_in_the_browser(worker, owner, api, tmp_path):
    """services/api/test/agreement-chain-browser.mjs: the owner's "how to send a contract", step by step. Finance saves the
    Master Service Agreement as the standard words, makes the agreement from the accepted quotation, fills the detailed
    sheet and sends it; the client reads it on the link, asks for a change and signs; Finance marks the request done and
    signs; the invoice; onboarding; live. 1440 and 363, light and dark. Screenshots with PULSE_AGREEMENTS_SCREENSHOTS=<dir>."""
    w, roles, config, wc = _api_world(worker, owner, api, names={"admin": "Asha Kireteso", "founder": "Meera Iyer"})
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'finance','2020-01-01')", (w.org, roles["admin"]))
    setup_company(api, w, roles["founder"])
    quote = _issued_quote(api, w, roles["admin"], BUYER)  # no template yet: the walk saves the Master Service Agreement
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.erp_document set status='accepted' where id=%s", (quote,))
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_OWNER_CONFIG": json.dumps(wc), "PULSE_ORG_ID": str(w.org), "QUOTE": str(quote), "FIN_ID": str(roles["admin"]),
           "TEST_REPORT": str(tmp_path / "browser.json"), "PULSE_CI": "1"}
    p = subprocess.run(["node", "test/agreement-chain-browser.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       text=True, capture_output=True, timeout=2400, check=False)
    report = json.loads((tmp_path / "browser.json").read_text()) if (tmp_path / "browser.json").exists() else None
    assert p.returncode == 0 and report and not report["failed"], (p.stdout + "\n" + p.stderr)[-8000:]
    assert report["checks"] >= 12
