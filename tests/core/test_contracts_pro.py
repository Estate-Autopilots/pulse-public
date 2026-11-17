"""CONTRACTS-PRO (2140): contracts drawn as typeset legal documents with the company's letterhead, and a signature made
from a photo of a signature on paper ('uploaded'). Synthetic company and people only; nothing is sent to anyone."""
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_comp import _api_world


def test_letterhead_reads_in_its_company_and_uploaded_is_a_kind(worker, owner, api):
    w, roles, _, _ = _api_world(worker, owner, api)
    with api.transaction():
        set_tenant(api, w.org, roles["person"])
        h = api.execute("select pulse.contract_letterhead() h").fetchone()["h"]
        assert h["company"]["name"] and isinstance(h["company"]["lines"], list) and h["logo"] in (True, False)
        assert api.execute("select count(*) n from pulse.contract_letterhead_logo()").fetchone()["n"] in (0, 1)
    with owner.transaction():
        set_tenant(owner, w.org)
        ok = owner.execute("select pg_get_constraintdef(oid) d from pg_constraint where conname='contract_party_sign_kind_check'").fetchone()["d"]
        assert "'uploaded'" in ok and "'drawn'" in ok
        # 1850's two signing functions now take a photo of a signature, and say so in the log.
        for fn in ("contract_sign_here", "contract_sign_act"):
            src = owner.execute("select prosrc from pg_proc where proname=%s", (fn,)).fetchone()["prosrc"]
            assert "'uploaded'" in src and "photo of their signature" in src
    with pytest.raises(psycopg.errors.NoDataFound):
        with api.transaction():
            set_tenant(api, w.org, roles["admin"])
            api.execute("""select pulse.contract_sign_here(gen_random_uuid(), '{"kind":"uploaded","name":"A B","agree":true}'::jsonb)""")


def test_signing_order_from_the_facts_line(worker, owner, api):
    """2140's pulse.contract_turn: with "ordered" in the facts line a party signs only after every party listed before it; no
    order, or an unreadable facts line, never blocks."""
    w, roles, _, _ = _api_world(worker, owner, api)
    import json as _json
    with owner.transaction():
        set_tenant(owner, w.org)
        cid = owner.execute("insert into pulse.contract(org_id,home_org,kind,title) values(%s,%s,'services','Synthetic MSA') returning id", (w.org, w.org)).fetchone()["id"]
        a = owner.execute("insert into pulse.contract_party(org_id,contract_id,position,kind,role,name) values(%s,%s,0,'company','provider','Synthetic Provider') returning party_key", (w.org, cid)).fetchone()["party_key"]
        b = owner.execute("insert into pulse.contract_party(org_id,contract_id,position,kind,role,name) values(%s,%s,1,'company','client','Synthetic Client') returning party_key", (w.org, cid)).fetchone()["party_key"]

        def body(ordered):
            facts = {"v": 1, "type": "service", "ordered": ordered, "deal": {},
                     "parties": [{"key": str(a), "name": "Synthetic Provider Private Limited", "type": "private_limited", "defined": "Provider"},
                                 {"key": str(b), "name": "Synthetic Client LLP", "type": "llp", "defined": "Client"}]}
            return "<!-- pulse:contract " + _json.dumps(facts).replace(">", "\\u003e") + " -->\n## Services\nWords."

        def turn(party):
            return owner.execute("select pulse.contract_turn(%s,%s) t", (cid, party)).fetchone()["t"]

        owner.execute("update pulse.contract set body=%s where id=%s", (body(True), cid))
        assert turn(b) == "Synthetic Provider Private Limited"
        assert turn(a) is None
        owner.execute("update pulse.contract_party set accepted_at=now(), accepted_version=1, accepted_by_name='A B' where party_key=%s", (a,))
        assert turn(b) is None
        owner.execute("update pulse.contract_party set accepted_at=null, accepted_version=null where party_key=%s", (a,))
        owner.execute("update pulse.contract set body=%s where id=%s", (body(False), cid))
        assert turn(b) is None
        owner.execute("update pulse.contract set body=%s where id=%s", ("<!-- pulse:contract {not json -->\n## Services", cid))
        assert turn(b) is None


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser flows need PULSE_AUTH_BROWSER=1 (and Playwright's Chromium)")
def test_contracts_pro_in_the_browser(worker, owner, api, tmp_path):
    """services/api/test/contracts-pro-browser.mjs: make a service agreement from the template with two parties, edit it,
    send it, the client signs with a photo on a phone, the admin signs by drawing, the PDF downloads (1440/363, light/dark)."""
    w, roles, config, wc = _api_world(worker, owner, api, names={"admin": "Kedab Mifos"})
    keys = tmp_path / "keys"; keys.mkdir(mode=0o700)
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_OWNER_CONFIG": json.dumps(wc), "PULSE_ORG_ID": str(w.org),
           "TEST_ROLES": json.dumps({r: str(p) for r, p in roles.items()}), "TEST_KEY_DIR": str(keys), "TEST_REPORT": str(tmp_path / "browser.json"), "PULSE_CI": "1"}
    env.pop("PULSE_DOCUMENT_KEY_FILE", None)
    p = subprocess.run(["node", "test/contracts-pro-browser.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       text=True, capture_output=True, timeout=2400, check=False)
    report = json.loads((tmp_path / "browser.json").read_text()) if (tmp_path / "browser.json").exists() else None
    assert p.returncode == 0 and report and not report["failed"], (p.stdout + "\n" + p.stderr)[-8000:]
    assert report["checks"] >= 25
    # The owner heard each step the client took through the link, and that everyone signed (2140's notifications).
    with owner.transaction():
        set_tenant(owner, w.org)
        titles = [r["title"] for r in owner.execute("select title from pulse.notification where person_id=%s and href like '/contracts/%%' order by created_at",
                                                     (roles["admin"],)).fetchall()]
    assert any(" opened " in t for t in titles), titles
    assert any(" signed " in t for t in titles), titles
    assert any(t.startswith("Everyone signed") for t in titles), titles
