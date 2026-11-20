"""AGREEMENTS round 14 Nov (2091): People → Agreements works over People & pay's offers, and the person answers an offer
in Pulse term by term: the offer's own letter split into key terms, every one ticked, then accepted with their name; the
pay in force follows the accepted offer (comp_offer_apply) and a signed copy of the letter is filed for them. Pay readers,
HR and founders see every offer and where it stands, never an amount; others see none. Synthetic people and figures."""
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_comp import _api_world


def test_offer_from_agreements_to_a_signed_letter(worker, owner, api, tmp_path):
    w, roles, config, wc = _api_world(worker, owner, api)
    keys = tmp_path / "keys"; keys.mkdir(mode=0o700)
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_OWNER_CONFIG": json.dumps(wc), "PULSE_ORG_ID": str(w.org),
           "TEST_ROLES": json.dumps({r: str(p) for r, p in roles.items()}), "TEST_KEY_DIR": str(keys), "PULSE_CI": "1"}
    env.pop("PULSE_DOCUMENT_KEY_FILE", None)
    p = subprocess.run(["node", "test/agreements-offer-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       text=True, capture_output=True, timeout=300, check=False)
    assert p.returncode == 0, (p.stdout + "\n" + p.stderr)[-6000:]
    # The database holds the answer, the signed copy and the terms ticked; never an amount in the timeline.
    with owner.transaction():
        set_tenant(owner, w.org)
        o = owner.execute("select status, answer_via, answer_name, signed_letter_id, letter_id from pulse.comp_offer where person_id=%s", (roles["person"],)).fetchone()
        assert (o["status"], o["answer_via"], o["answer_name"]) == ("accepted", "pulse", "Synthetic Person")
        assert o["signed_letter_id"] and o["signed_letter_id"] != o["letter_id"]
        ev = owner.execute("select detail from pulse.comp_event where person_id=%s and kind='offer.signed'", (roles["person"],)).fetchone()
        assert ev["detail"]["terms"][:3] == ["Your role and start date", "Your pay", "Probation and notice"]
        assert "4200000" not in json.dumps(ev["detail"])


def test_who_sees_the_offers_and_the_signed_copy_guard(worker, owner, api):
    w, roles, _, _ = _api_world(worker, owner, api)

    def one(who, sql, args=()):
        with api.transaction():
            set_tenant(api, w.org, who)
            return api.execute(sql, args).fetchone()

    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(roles["person"], "select pulse.agreements_offers()")
    assert one(roles["hr"], "select pulse.agreements_offers() d")["d"]["offers"] == []
    assert one(roles["person"], "select pulse.agreement_offers_waiting() n")["n"] == 0
    # Nobody files a signed copy for an offer that is not theirs, or not accepted in Pulse.
    with pytest.raises(psycopg.errors.NoDataFound):
        one(roles["hr"], "select pulse.agreement_offer_signed(gen_random_uuid(), '[]', '{}')")


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser flows need PULSE_AUTH_BROWSER=1 (and Playwright's Chromium)")
def test_agreements_in_the_browser(worker, owner, api, tmp_path):
    """services/api/test/agreements-browser.mjs: People → Agreements end to end in the browser at 1440 and 363, light and
    dark. HR makes an offer letter (someone new, then someone in Pulse), a founder approves and sends it, the person
    accepts it term by term on a phone, the pay record and the signed letter follow, HR sees it accepted. Screenshots with
    PULSE_AGREEMENTS_SCREENSHOTS=<dir>."""
    w, roles, config, wc = _api_world(worker, owner, api, names={"person": "Rifob Mifos", "hr": "Asha Kireteso", "founder": "Meera Iyer",
                                                                 "founder2": "Rumam Menon", "head": "Tara Kapoor"})
    keys = tmp_path / "keys"; keys.mkdir(mode=0o700)
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_OWNER_CONFIG": json.dumps(wc), "PULSE_ORG_ID": str(w.org),
           "TEST_ROLES": json.dumps({r: str(p) for r, p in roles.items()}), "TEST_KEY_DIR": str(keys), "TEST_REPORT": str(tmp_path / "browser.json"), "PULSE_CI": "1"}
    env.pop("PULSE_DOCUMENT_KEY_FILE", None)
    p = subprocess.run(["node", "test/agreements-browser.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       text=True, capture_output=True, timeout=2400, check=False)
    report = json.loads((tmp_path / "browser.json").read_text()) if (tmp_path / "browser.json").exists() else None
    assert p.returncode == 0 and report and not report["failed"], (p.stdout + "\n" + p.stderr)[-8000:]
    assert report["checks"] >= 15
    # Nothing the walk logged carries an amount.
    assert "4800000" not in p.stdout + p.stderr
